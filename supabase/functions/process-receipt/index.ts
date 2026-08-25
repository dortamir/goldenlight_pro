// process-receipt
//
// OCR Integration Stages 1 + 2 + 3: server-side ingestion + persistence for
// a single purchase report's receipt (Stage 1, Azure Document Intelligence
// prebuilt-invoice), normalization/row-recovery of that raw evidence into
// cleaner OCR rows (Stage 2), and deterministic product matching against
// the real Golden Light catalog using that normalized evidence (Stage 3).
// Structural flow:
//
//   authenticate
//     -> verify ownership (owner OR admin)
//     -> claim_ocr_processing (concurrency-safe: rejects a second
//        concurrent/duplicate call, allows an explicit forceRetry)
//     -> load private receipt
//     -> runOcrProvider (Azure Document Intelligence adapter)
//     -> normalize/validate OCR result (ocrParser.ts)
//     -> persist OCR result + lines, retry-safe (ocrPersistence.ts)
//     -> normalize/recover OCR rows (ocrNormalization.ts)
//     -> match OCR rows to catalog products (productMatchPersistence.ts)
//     -> move purchase report to needs_review
//     -> return a safe response
//
// SCOPE: this function's job ends at "real, normalized, product-matched
// OCR evidence, safely persisted, report flagged for review." Matching
// classifies each OCR line against the catalog - it never approves a
// purchase report, rejects it, awards points, or touches
// profiles.points_balance/membership_level/approved_purchases_count, and
// it never writes receipt_manual_items/is_golden_light. See "Product
// matching (Stage 3)" below for exactly what it does and doesn't do.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

import { corsHeaders } from '../_shared/cors.ts';
import { isEmptyOcrResult, parseOcrResult } from './ocrParser.ts';
import { claimOcrProcessing, markOcrFailed, persistOcrResult } from './ocrPersistence.ts';
import { normalizeAndPersistOcrLines } from './ocrNormalization.ts';
import { matchAndPersistOcrLines } from './productMatchPersistence.ts';
import { runOcrProvider } from './ocrProvider.ts';

interface ProcessReceiptRequestBody {
  purchaseReportId?: unknown;
  // Explicit, deliberate retry path (section 15 of the Stage 1 spec: "an
  // explicit controlled retry path for failed/manual retry cases"). false
  // by default - an ordinary call never overrides an in-progress or
  // already-completed OCR run. No UI calls this with true yet; it exists
  // as backend plumbing for a future retry action.
  forceRetry?: unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A generic message returned to the client whenever OCR itself did not
// succeed, regardless of the internal reason (download failure, provider
// unavailable, empty result, or a persistence error). Internal detail is
// logged server-side only - see the individual branches below. Never
// includes the Azure key, request headers, or a raw provider error body.
const CLIENT_SAFE_OCR_FAILURE = 'OCR processing failed';

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// ok:false here means "OCR did not succeed" (the request itself was handled
// fine); status always reflects where the purchase report actually landed
// (needs_review), never a fabricated "success".
function ocrFailureResponse(purchaseReportId: string) {
  return jsonResponse(
    { ok: false, purchaseReportId, status: 'needs_review', error: CLIENT_SAFE_OCR_FAILURE },
    200,
  );
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
  }

  // --- Parse & validate the request body -------------------------------
  // Only purchaseReportId and forceRetry are accepted. user_id,
  // receipt_path, status, and points are never read from the request - see
  // steps below for where each of those actually comes from.
  let body: ProcessReceiptRequestBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid request body' }, 400);
  }

  const purchaseReportId = body?.purchaseReportId;
  if (typeof purchaseReportId !== 'string' || !UUID_RE.test(purchaseReportId)) {
    return jsonResponse({ ok: false, error: 'purchaseReportId is required' }, 400);
  }

  const forceRetry = body?.forceRetry === true;

  // --- Authenticate the caller from the Authorization header -----------
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return jsonResponse({ ok: false, error: 'Missing Authorization header' }, 401);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
    // Server misconfiguration - never reveal which variable is missing.
    console.error('[process-receipt] Missing required Supabase environment configuration');
    return jsonResponse({ ok: false, error: 'Server not configured' }, 500);
  }

  // Short-lived client scoped to the caller's own JWT, used only to resolve
  // *who* is calling. It never bypasses RLS and is discarded immediately
  // after auth.getUser().
  const callerClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const {
    data: { user },
    error: authError,
  } = await callerClient.auth.getUser();

  if (authError || !user) {
    return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
  }

  // Trusted server-side client for every privileged read/write below
  // (purchase_reports status, receipt_ocr_results/lines, private Storage,
  // claim_ocr_processing). SUPABASE_SERVICE_ROLE_KEY is read only from this
  // function's own environment - it is never sent to, stored in, or
  // reachable from the Expo app.
  const adminClient: SupabaseClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });

  // --- Verify ownership (owner OR admin) --------------------------------
  const { data: report, error: reportError } = await adminClient
    .from('purchase_reports')
    .select('id, user_id, receipt_path, original_filename, status')
    .eq('id', purchaseReportId)
    .maybeSingle();

  if (reportError) {
    console.error('[process-receipt] Failed to load purchase report', purchaseReportId, reportError.message);
    return jsonResponse({ ok: false, error: 'Unable to process receipt' }, 500);
  }

  if (!report) {
    return jsonResponse({ ok: false, error: 'Report not found' }, 404);
  }

  if (report.user_id !== user.id) {
    // Not the report's owner - the only other legitimate caller is an
    // admin (an "authorized server/admin path", per this stage's own
    // security requirement). Checked via the service-role client directly
    // against admin_users (bypassing that table's own RLS, which is
    // exactly what a trusted backend check is supposed to do) rather than
    // trusting anything the caller claims about themselves.
    const { data: adminRow } = await adminClient
      .from('admin_users')
      .select('user_id')
      .eq('user_id', user.id)
      .maybeSingle();

    if (!adminRow) {
      // Whether the report doesn't exist or belongs to someone else who
      // isn't an admin, respond identically so a caller can never
      // distinguish the two cases.
      return jsonResponse({ ok: false, error: 'Report not found' }, 404);
    }
  }

  console.log('[process-receipt] Processing started', purchaseReportId, { forceRetry });

  // --- Claim processing (concurrency-safe, cost/duplicate-call guard) ------
  // See claim_ocr_processing() (021_ocr_azure_document_intelligence.sql):
  // locks the purchase_reports row, then atomically inspects/updates
  // receipt_ocr_results' own status. Rejects a second concurrent/duplicate
  // call for the same report outright (no duplicate Azure analysis is ever
  // started) unless forceRetry was explicitly requested.
  const claimOutcome = await claimOcrProcessing(adminClient, report.id, forceRetry);

  if (!claimOutcome.ok) {
    if (claimOutcome.reason === 'report_not_found') {
      return jsonResponse({ ok: false, error: 'Report not found' }, 404);
    }
    if (claimOutcome.reason === 'already_processing') {
      console.log('[process-receipt] Rejected: already processing', purchaseReportId);
      return jsonResponse({ ok: false, error: 'OCR is already in progress for this report' }, 409);
    }
    if (claimOutcome.reason === 'already_completed') {
      console.log('[process-receipt] Rejected: already completed', purchaseReportId);
      return jsonResponse({ ok: false, error: 'OCR has already completed for this report' }, 409);
    }
    console.error('[process-receipt] Failed to claim OCR processing', purchaseReportId, claimOutcome.message);
    return jsonResponse({ ok: false, error: 'Unable to process receipt' }, 500);
  }

  const ocrResultId = claimOutcome.ocrResultId;

  // Move the purchase report into "processing" so the mobile UI reflects
  // that work has begun. Only the backend-controlled status column is
  // touched here - points_awarded, profile.points_balance,
  // membership_level, and approved_purchases_count are never written by
  // this function; no points/matching logic runs in this stage.
  await adminClient
    .from('purchase_reports')
    .update({ status: 'processing' })
    .eq('id', report.id)
    .eq('status', 'submitted'); // no-op if a retry finds it already past "submitted"

  // --- Load the private receipt file from Storage --------------------------
  // Always uses purchase_report.receipt_path loaded from the database
  // above - never a path supplied by the caller. No public URL is ever
  // generated; the file bytes are downloaded directly with the
  // service-role client, which is the only way this function ever reads a
  // receipt (JPEG/PNG/WebP/PDF - the same set the upload flow already
  // accepts, see 002_create_purchase_reports.sql's storage bucket config).
  const { data: fileBlob, error: downloadError } = await adminClient.storage
    .from('receipts')
    .download(report.receipt_path);

  if (downloadError || !fileBlob) {
    console.error('[process-receipt] Failed to download receipt file', purchaseReportId, downloadError?.message);
    await markOcrFailed(adminClient, ocrResultId, report.id, 'processing', 'Receipt file could not be retrieved');
    return ocrFailureResponse(purchaseReportId);
  }

  // --- Run the OCR provider (Azure Document Intelligence) -------------------
  const fileBytes = new Uint8Array(await fileBlob.arrayBuffer());
  const providerResult = await runOcrProvider(fileBytes, fileBlob.type || 'application/octet-stream');

  if (!providerResult.ok) {
    // Log a safe summary only - never the Azure key, never a raw
    // Authorization header, never the full receipt content. providerResult
    // itself is already scrubbed of the key by construction (see
    // ocrProvider.ts) - only its reason/message (already-sanitized) are
    // logged here.
    console.log('[process-receipt] OCR provider unavailable', purchaseReportId, providerResult.reason);
    await markOcrFailed(adminClient, ocrResultId, report.id, 'processing', providerResult.message, {
      modelId: providerResult.modelId,
      apiVersion: providerResult.apiVersion,
      rawResponse: providerResult.rawResponse,
    });
    return ocrFailureResponse(purchaseReportId);
  }

  // --- Normalize/validate the provider's output -----------------------------
  // parseOcrResult() cleans line text, validates numeric/confidence fields,
  // drops empty lines, and assigns a deterministic gap-free line_index. It
  // never trusts a provider-supplied index and never guesses/cleans a
  // value Azure returned (e.g. ProductCode "600302 9" is preserved exactly,
  // never split - see the Stage 1 spec's own example).
  const parsedResult = parseOcrResult(providerResult.result);

  if (isEmptyOcrResult(parsedResult)) {
    // The provider technically didn't error, but returned nothing useful -
    // treat that the same as a failure rather than persisting a
    // "completed" result with meaningless empty data. The raw response is
    // still preserved (via markOcrFailed's rawResponse) even in this case,
    // so a genuinely-empty-looking Azure response can still be inspected
    // later.
    console.log('[process-receipt] Empty OCR result', purchaseReportId, { lineCount: parsedResult.lines.length });
    await markOcrFailed(adminClient, ocrResultId, report.id, 'processing', 'empty_ocr_result', {
      modelId: providerResult.modelId,
      apiVersion: providerResult.apiVersion,
      rawResponse: providerResult.rawResponse,
    });
    return ocrFailureResponse(purchaseReportId);
  }

  // --- Persist OCR result + lines (retry-safe replace) ----------------------
  // Deliberately does not award points or approve the report - that
  // remains a separate future stage.
  try {
    const outcome = await persistOcrResult({
      adminClient,
      purchaseReportId: report.id,
      provider: providerResult.provider,
      parsedResult,
      modelId: providerResult.modelId,
      apiVersion: providerResult.apiVersion,
      rawResponse: providerResult.rawResponse,
    });

    console.log('[process-receipt] OCR completed', purchaseReportId, {
      provider: providerResult.provider,
      lineCount: outcome.lineCount,
    });
  } catch (persistError) {
    console.error(
      '[process-receipt] Failed to persist OCR result',
      purchaseReportId,
      (persistError as Error).message,
    );
    await markOcrFailed(adminClient, ocrResultId, report.id, 'processing', 'Failed to persist OCR result', {
      modelId: providerResult.modelId,
      apiVersion: providerResult.apiVersion,
      rawResponse: providerResult.rawResponse,
    });
    return ocrFailureResponse(purchaseReportId);
  }

  // --- OCR Integration Stage 2: normalize/recover OCR rows ------------------
  // Runs only after Stage 1's OCR evidence is already durably persisted
  // above, so a normalization failure here must never undo or fail the
  // OCR success itself - it's logged and swallowed (same isolation pattern
  // used for the product-matching step right below), and the report still
  // reaches needs_review either way. Turns the just-persisted
  // receipt_ocr_lines rows into cleaner, more trustworthy evidence
  // (validated ProductCode candidates, a consistency-checked quantity,
  // evidence-based merged-row recovery) - see ocrNormalization.ts. This
  // does NOT run product matching itself: it never sets product_id/
  // match_status, never touches receipt_line_matches or
  // receipt_manual_items. A normalized row is not an approved product and
  // not points-eligible.
  try {
    console.log('[process-receipt] Normalization started', purchaseReportId);
    const normalizationOutcome = await normalizeAndPersistOcrLines(adminClient, ocrResultId);
    console.log('[process-receipt] Normalization completed', purchaseReportId, {
      sourceItemCount: normalizationOutcome.sourceItemCount,
      normalizedRowCount: normalizationOutcome.normalizedRowCount,
      correctedCount: normalizationOutcome.correctedCount,
      ambiguousCount: normalizationOutcome.ambiguousCount,
      needsReviewCount: normalizationOutcome.needsReviewCount,
      mergedRecoveredCount: normalizationOutcome.mergedRecoveredCount,
    });
  } catch (normalizationError) {
    console.error(
      '[process-receipt] Normalization failed',
      purchaseReportId,
      (normalizationError as Error).message,
    );
    // Deliberately not returned as a failure response: OCR itself already
    // succeeded and was persisted above (with normalization_status simply
    // left null on every line, meaning "not yet normalized" - see
    // migration 022), and normalization is not a precondition for the
    // report reaching needs_review for human review. A future retry of
    // this function (forceRetry) re-runs normalization from scratch too.
    // Matching (right below) still runs even when normalization failed -
    // it just has weaker evidence available (Stage 1's original
    // product_code/raw_text only, no normalized_product_code), which
    // matchOcrLineFromEvidence() already degrades to gracefully.
  }

  // --- OCR Product Matching Stage 3: match OCR rows to catalog products -----
  // Runs after Stage 2 (successful or not - see the catch above), so a
  // matching failure here must never undo or fail the already-persisted
  // OCR/normalization results - logged and swallowed, and the report still
  // reaches needs_review either way. Classifies each matchable
  // receipt_ocr_lines row (every row except a detected-merge PARENT - see
  // matchAndPersistOcrLines()'s own comment) against the real active
  // product catalog using Stage 2's normalized evidence first
  // (normalized_product_code, and the barcode/conflict evidence already
  // computed into normalization_notes), falling back to the original,
  // unchanged matchOcrLine() cascade (product_code/description text) and
  // finally a fuzzy description candidate - see productMatcher.ts's
  // matchOcrLineFromEvidence() for the full priority order. This does NOT
  // approve/reject the report, award points, change G Level, or write
  // receipt_manual_items/is_golden_light - it only classifies OCR lines
  // (matched/needs_review/unmatched) for a later admin review step.
  try {
    console.log('[process-receipt] Matching started', purchaseReportId);
    const matchOutcome = await matchAndPersistOcrLines(adminClient, ocrResultId);
    console.log('[process-receipt] Matching completed', purchaseReportId, {
      sourceLineCount: matchOutcome.sourceLineCount,
      skippedMergedParentCount: matchOutcome.skippedMergedParentCount,
      matchedCount: matchOutcome.matchedCount,
      needsReviewCount: matchOutcome.needsReviewCount,
      unmatchedCount: matchOutcome.unmatchedCount,
      conflictCount: matchOutcome.conflictCount,
    });
  } catch (matchError) {
    console.error('[process-receipt] Matching failed', purchaseReportId, (matchError as Error).message);
    // Deliberately not returned as a failure response, for the same
    // reason as the normalization catch above: OCR/normalization already
    // succeeded and were persisted, and matching is not a precondition for
    // the report reaching needs_review for human review. A future retry
    // of this function (forceRetry) re-runs matching from scratch too
    // (matchAndPersistOcrLines() deletes-then-regenerates every time).
  }

  // OCR succeeded and was durably persisted, but that does not imply
  // approval - move the report to needs_review, never approved, and never
  // touch points_awarded/points_balance/membership_level/
  // approved_purchases_count from this function.
  await adminClient
    .from('purchase_reports')
    .update({ status: 'needs_review' })
    .eq('id', report.id)
    .eq('status', 'processing');

  return jsonResponse({ ok: true, purchaseReportId, status: 'needs_review' }, 200);
});