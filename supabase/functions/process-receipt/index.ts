// process-receipt
//
// Server-side foundation for OCR processing of a single purchase report's
// receipt. This function does NOT run real OCR yet - no provider is
// configured. Structural flow:
//
//   authenticate
//     -> verify ownership
//     -> mark processing (idempotent receipt_ocr_results row)
//     -> load private receipt
//     -> runOcrProvider (provider adapter)
//     -> normalize/validate OCR result (ocrParser.ts)
//     -> persist OCR result + lines, retry-safe (ocrPersistence.ts)
//     -> load active product catalog + deterministically match each OCR
//        line (productMatcher.ts), persist results, retry-safe
//        (productMatchPersistence.ts)
//     -> move purchase report to needs_review
//     -> return a safe response
//
// Since no provider is configured in this environment, every real
// invocation today ends at the provider step and fails safely - no fake
// OCR output is ever produced or persisted, and product matching (which
// only runs after real OCR output exists) is unreachable along with it. See
// supabase/README.md for the full lifecycle and required secrets.
//
// IMPORTANT: product matching classifies OCR lines against the product
// catalog only - it never approves a purchase report and never awards
// points. purchase_reports.status always ends this function at
// needs_review, and points_awarded/points_balance/membership_level/
// approved_purchases_count are never touched here.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

import { corsHeaders } from '../_shared/cors.ts';
import { isEmptyOcrResult, parseOcrResult } from './ocrParser.ts';
import { markOcrFailed, persistOcrResult } from './ocrPersistence.ts';
import { runOcrProvider } from './ocrProvider.ts';
import { matchOcrLine } from './productMatcher.ts';
import { loadActiveProductCatalog, persistLineMatches, type LineMatchToPersist } from './productMatchPersistence.ts';

interface ProcessReceiptRequestBody {
  purchaseReportId?: unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A generic message returned to the client whenever OCR itself did not
// succeed, regardless of the internal reason (download failure, provider
// unavailable, empty result, or a persistence error). Internal detail is
// logged server-side only - see the individual branches below.
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
  // Only purchaseReportId is accepted. user_id, receipt_path, status, and
  // points are never read from the request - see steps below for where
  // each of those actually comes from.
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
  // (purchase_reports status, receipt_ocr_results/lines, private Storage).
  // SUPABASE_SERVICE_ROLE_KEY is read only from this function's own
  // environment - it is never sent to, stored in, or reachable from the
  // Expo app.
  const adminClient: SupabaseClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });

  // --- Verify ownership ---------------------------------------------------
  const { data: report, error: reportError } = await adminClient
    .from('purchase_reports')
    .select('id, user_id, receipt_path, original_filename, status')
    .eq('id', purchaseReportId)
    .maybeSingle();

  if (reportError) {
    console.error('[process-receipt] Failed to load purchase report', purchaseReportId, reportError.message);
    return jsonResponse({ ok: false, error: 'Unable to process receipt' }, 500);
  }

  // Whether the report doesn't exist or belongs to someone else, respond
  // identically so a caller can never distinguish the two cases.
  if (!report || report.user_id !== user.id) {
    return jsonResponse({ ok: false, error: 'Report not found' }, 404);
  }

  console.log('[process-receipt] Processing started', purchaseReportId);

  // --- Mark processing (idempotent OCR result row) -------------------------
  // purchase_report_id is UNIQUE on receipt_ocr_results, so upserting on
  // that column guarantees exactly one OCR result row per report no matter
  // how many times this function is called for the same purchaseReportId.
  const { data: ocrResult, error: upsertError } = await adminClient
    .from('receipt_ocr_results')
    .upsert(
      { purchase_report_id: report.id, status: 'processing', error_message: null, provider: null },
      { onConflict: 'purchase_report_id' },
    )
    .select('id')
    .single();

  if (upsertError || !ocrResult) {
    console.error('[process-receipt] Failed to create OCR result row', purchaseReportId, upsertError?.message);
    return jsonResponse({ ok: false, error: 'Unable to process receipt' }, 500);
  }

  // Move the purchase report into "processing" so the mobile UI reflects
  // that work has begun. Only the backend-controlled status column is
  // touched here - points_awarded, profile.points_balance,
  // membership_level, and approved_purchases_count are never written by
  // this function; no points/matching logic exists yet.
  await adminClient
    .from('purchase_reports')
    .update({ status: 'processing' })
    .eq('id', report.id)
    .eq('status', 'submitted'); // no-op if a retry finds it already past "submitted"

  // --- Load the private receipt file from Storage --------------------------
  // Always uses purchase_report.receipt_path loaded from the database
  // above - never a path supplied by the caller. No public URL is ever
  // generated; the file bytes are downloaded directly with the
  // service-role client.
  const { data: fileBlob, error: downloadError } = await adminClient.storage
    .from('receipts')
    .download(report.receipt_path);

  if (downloadError || !fileBlob) {
    console.error('[process-receipt] Failed to download receipt file', purchaseReportId, downloadError?.message);
    await markOcrFailed(adminClient, ocrResult.id, report.id, 'processing', 'Receipt file could not be retrieved');
    return ocrFailureResponse(purchaseReportId);
  }

  // --- Run the OCR provider (not configured yet in this environment) -------
  const fileBytes = new Uint8Array(await fileBlob.arrayBuffer());
  const providerResult = await runOcrProvider(fileBytes, fileBlob.type || 'application/octet-stream');

  if (!providerResult.ok) {
    // Expected today: no Azure credentials are configured. Fail safely
    // rather than pretending OCR succeeded - no fake raw_text/lines are
    // ever written.
    console.log('[process-receipt] OCR provider unavailable', purchaseReportId, providerResult.reason);
    await markOcrFailed(adminClient, ocrResult.id, report.id, 'processing', providerResult.message);
    return ocrFailureResponse(purchaseReportId);
  }

  // --- Normalize/validate the provider's output -----------------------------
  // parseOcrResult() cleans line text, validates numeric fields, drops
  // empty lines, and assigns a deterministic gap-free line_index. It never
  // trusts a provider-supplied index and never guesses numbers from text.
  const parsedResult = parseOcrResult(providerResult.result);

  if (isEmptyOcrResult(parsedResult)) {
    // The provider technically didn't error, but returned nothing useful -
    // treat that the same as a failure rather than persisting a
    // "completed" result with meaningless empty data.
    console.log('[process-receipt] Empty OCR result', purchaseReportId, { lineCount: parsedResult.lines.length });
    await markOcrFailed(adminClient, ocrResult.id, report.id, 'processing', 'empty_ocr_result');
    return ocrFailureResponse(purchaseReportId);
  }

  // --- Persist OCR result + lines (retry-safe replace) ----------------------
  // Not reachable until a real provider is implemented in ocrProvider.ts;
  // left in place so that integration only needs to fill in
  // runOcrProvider(). Deliberately does not award points or approve the
  // report - that remains a separate future stage.
  let persistedLines: Awaited<ReturnType<typeof persistOcrResult>>['lines'] = [];
  try {
    const outcome = await persistOcrResult({
      adminClient,
      purchaseReportId: report.id,
      provider: providerResult.provider,
      parsedResult,
    });

    persistedLines = outcome.lines;

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
    await markOcrFailed(adminClient, ocrResult.id, report.id, 'processing', 'Failed to persist OCR result');
    return ocrFailureResponse(purchaseReportId);
  }

  // --- Deterministic product matching (server-side only) --------------------
  // Runs after OCR is already durably persisted, so a matching failure here
  // must never undo or fail the OCR success above - it's logged and
  // swallowed, and the report still lands in needs_review below either way.
  // loadActiveProductCatalog() naturally returns an empty catalog until real
  // Golden Light product data is imported; matchOcrLine() already treats
  // that as a safe "every line unmatched" case rather than an error, so no
  // special-casing is needed here for an empty catalog.
  // persistLineMatches() upserts on the unique ocr_line_id column, so
  // re-running this function for the same report (a retry) simply
  // overwrites the previous match results rather than duplicating rows.
  try {
    const catalog = await loadActiveProductCatalog(adminClient);
    const matches: LineMatchToPersist[] = persistedLines.map((line) => ({
      ocrLineId: line.id,
      result: matchOcrLine({ text: line.rawText, normalizedText: line.normalizedText }, catalog),
    }));

    const matchOutcome = await persistLineMatches(adminClient, matches);

    console.log('[process-receipt] Product matching completed', purchaseReportId, {
      lineCount: matches.length,
      matched: matchOutcome.matchedCount,
      needsReview: matchOutcome.needsReviewCount,
      unmatched: matchOutcome.unmatchedCount,
    });
  } catch (matchError) {
    console.error(
      '[process-receipt] Product matching failed',
      purchaseReportId,
      (matchError as Error).message,
    );
    // Deliberately not returned as a failure response: OCR itself already
    // succeeded and was persisted above, and matching is not a precondition
    // for the report reaching needs_review for human review.
  }

  // OCR (and, best-effort, matching) succeeded, but matching results do not
  // imply approval - move the report to needs_review, never approved, and
  // never touch points_awarded/points_balance/membership_level/
  // approved_purchases_count from this function.
  await adminClient
    .from('purchase_reports')
    .update({ status: 'needs_review' })
    .eq('id', report.id)
    .eq('status', 'processing');

  return jsonResponse({ ok: true, purchaseReportId, status: 'needs_review' }, 200);
});
