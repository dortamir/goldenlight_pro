// Server-side persistence for OCR results/lines. Every function here takes
// an already-authorized service-role Supabase client - this module performs
// no auth/ownership checks of its own (see index.ts, which does that before
// calling in).

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

import type { ParsedOcrResult } from './ocrParser.ts';

export interface PersistOcrResultParams {
  adminClient: SupabaseClient;
  purchaseReportId: string;
  provider: string;
  parsedResult: ParsedOcrResult;
}

// The persisted shape of one receipt_ocr_lines row, as needed by product
// matching (productMatcher.ts) - normalizedText comes back exactly as
// computed by the receipt_ocr_lines_set_normalized_text database trigger,
// never recomputed here.
export interface PersistedOcrLine {
  id: string;
  lineIndex: number;
  rawText: string;
  normalizedText: string | null;
}

export interface PersistOcrResultOutcome {
  ocrResultId: string;
  lineCount: number;
  lines: PersistedOcrLine[];
}

// Writes a completed OCR result and its lines for one purchase report.
//
// NOT ATOMIC - IMPORTANT LIMITATION:
// Each Supabase client call below (upsert, delete, insert) is its own
// separate request/statement, not one Postgres transaction. The
// delete-then-insert of receipt_ocr_lines in particular is not atomic: if
// this function crashes, times out, or the insert fails after the delete
// already succeeded, the report will be left with zero lines even though
// receipt_ocr_results.status may still say "completed" from a moment ago
// (this function throws in that case - see the insert step below - so the
// caller can react, but the window between delete and insert is real).
// This is a deliberate, documented limitation of this foundation, not an
// oversight. If this becomes a real risk once a provider is connected, the
// correct fix is a single Postgres function (RPC, called via
// supabase.rpc(...)) that performs the delete+insert inside one explicit
// transaction - do not attempt to fake atomicity from the client, and do
// not add that RPC/migration without review.
export async function persistOcrResult(
  params: PersistOcrResultParams,
): Promise<PersistOcrResultOutcome> {
  const { adminClient, purchaseReportId, provider, parsedResult } = params;

  // A + B. Upsert the matching receipt_ocr_results row. Idempotent on the
  // unique purchase_report_id column, so calling this more than once for
  // the same report (retries) updates the same row rather than creating a
  // duplicate.
  const { data: ocrResult, error: upsertError } = await adminClient
    .from('receipt_ocr_results')
    .upsert(
      {
        purchase_report_id: purchaseReportId,
        raw_text: parsedResult.rawText,
        provider,
        status: 'completed',
        processed_at: new Date().toISOString(),
        error_message: null,
      },
      { onConflict: 'purchase_report_id' },
    )
    .select('id')
    .single();

  if (upsertError || !ocrResult) {
    throw new Error(`Failed to upsert receipt_ocr_results: ${upsertError?.message ?? 'unknown error'}`);
  }

  // C.
  const ocrResultId = ocrResult.id as string;

  // D. Replace child lines rather than appending. This is what makes
  // retries safe: if process-receipt runs again for the same purchase
  // report (same ocr_result_id via the upsert above), the previous line
  // set is deleted first so re-inserting the freshly parsed lines can never
  // create duplicates or leave stale lines from an earlier attempt behind.
  // This delete is only reachable through this service-role client - the
  // mobile client has no delete privilege on receipt_ocr_lines at all (see
  // migration 005_create_receipt_ocr.sql).
  const { error: deleteError } = await adminClient
    .from('receipt_ocr_lines')
    .delete()
    .eq('ocr_result_id', ocrResultId);

  if (deleteError) {
    throw new Error(`Failed to clear existing receipt_ocr_lines: ${deleteError.message}`);
  }

  if (parsedResult.lines.length > 0) {
    const rows = parsedResult.lines.map((line) => ({
      ocr_result_id: ocrResultId,
      line_index: line.lineIndex,
      raw_text: line.rawText,
      detected_quantity: line.detectedQuantity,
      detected_unit_price: line.detectedUnitPrice,
      detected_total: line.detectedTotal,
      // normalized_text is intentionally omitted here - the
      // receipt_ocr_lines_set_normalized_text trigger (migration
      // 005_create_receipt_ocr.sql) computes it from raw_text on insert.
      // This module must never compute it manually.
    }));

    // .select() here returns the DB-generated id and normalized_text (the
    // latter computed by the trigger, not by this module) for each inserted
    // row - product matching (index.ts) needs both, and this avoids a
    // second round trip to re-fetch the lines it just wrote.
    const { data: insertedRows, error: insertError } = await adminClient
      .from('receipt_ocr_lines')
      .insert(rows)
      .select('id, line_index, raw_text, normalized_text');

    if (insertError) {
      // The delete above already succeeded, so the report currently has
      // zero lines - exactly the non-atomicity documented above. Throw so
      // the caller (index.ts) marks the OCR result failed rather than
      // silently leaving "completed" with no lines.
      throw new Error(`Failed to insert receipt_ocr_lines: ${insertError.message}`);
    }

    const lines: PersistedOcrLine[] = (insertedRows ?? []).map((row: Record<string, unknown>) => ({
      id: row.id as string,
      lineIndex: row.line_index as number,
      rawText: row.raw_text as string,
      normalizedText: (row.normalized_text as string | null) ?? null,
    }));

    return { ocrResultId, lineCount: parsedResult.lines.length, lines };
  }

  return { ocrResultId, lineCount: 0, lines: [] };
}

// Marks an OCR result as failed and routes the purchase report to
// needs_review, without ever touching points/membership/approval fields.
// currentPurchaseReportStatus guards the purchase_reports update so this
// never overwrites a status something else (e.g. an admin) may have already
// moved on to while this call was in flight.
export async function markOcrFailed(
  adminClient: SupabaseClient,
  ocrResultId: string,
  purchaseReportId: string,
  currentPurchaseReportStatus: string,
  safeErrorMessage: string,
): Promise<void> {
  await adminClient
    .from('receipt_ocr_results')
    .update({ status: 'failed', error_message: safeErrorMessage })
    .eq('id', ocrResultId);

  await adminClient
    .from('purchase_reports')
    .update({ status: 'needs_review' })
    .eq('id', purchaseReportId)
    .eq('status', currentPurchaseReportStatus);
}
