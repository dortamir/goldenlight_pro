// Server-side I/O for product matching: loading the active catalog and
// persisting match results. Every function here takes an already-authorized
// service-role Supabase client - this module performs no auth/ownership
// checks of its own. Kept separate from productMatcher.ts (pure logic, no
// Supabase/Deno dependency) so the matching algorithm stays trivially
// unit-testable in isolation.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

import {
  matchOcrLineFromEvidence,
  type CatalogAlias,
  type CatalogProduct,
  type LineMatchResult,
  type OcrLineEvidence,
  type ProductCatalog,
} from './productMatcher.ts';

// Loads the active product catalog (products + their aliases) needed for
// matching. Only public.products rows with is_active = true are loaded -
// mirrors the mobile client's own read policy (see
// 004_create_product_catalog.sql), though this runs server-side with the
// service-role client, never by asking the mobile client for catalog data.
//
// Returns an empty catalog (not an error) when there are no active
// products yet - expected until the real Golden Light catalog is imported.
export async function loadActiveProductCatalog(adminClient: SupabaseClient): Promise<ProductCatalog> {
  const { data: productRows, error: productsError } = await adminClient
    .from('products')
    .select('id, sku, name, is_active, barcode')
    .eq('is_active', true);

  if (productsError) {
    throw new Error(`Failed to load product catalog: ${productsError.message}`);
  }

  const products: CatalogProduct[] = (productRows ?? []).map((row: Record<string, unknown>) => ({
    id: row.id as string,
    sku: row.sku as string,
    name: row.name as string,
    isActive: Boolean(row.is_active),
    barcode: (row.barcode as string | null) ?? null,
  }));

  if (products.length === 0) {
    return { products: [], aliases: [] };
  }

  const productIds = products.map((product) => product.id);

  const { data: aliasRows, error: aliasesError } = await adminClient
    .from('product_aliases')
    .select('product_id, alias, normalized_alias')
    .in('product_id', productIds);

  if (aliasesError) {
    throw new Error(`Failed to load product aliases: ${aliasesError.message}`);
  }

  const aliases: CatalogAlias[] = (aliasRows ?? []).map((row: Record<string, unknown>) => ({
    productId: row.product_id as string,
    alias: row.alias as string,
    normalizedAlias: row.normalized_alias as string,
  }));

  return { products, aliases };
}

export interface LineMatchToPersist {
  ocrLineId: string;
  result: LineMatchResult;
}

export interface PersistLineMatchesOutcome {
  matchedCount: number;
  needsReviewCount: number;
  unmatchedCount: number;
}

// Upserts exactly one receipt_line_matches row per OCR line, keyed by the
// table's unique ocr_line_id column - never creates duplicate match rows.
// A retry that produces a different result for the same line simply
// updates the existing row, which is safe because matching is entirely
// backend-controlled (the mobile client has no write privilege on this
// table at all).
export async function persistLineMatches(
  adminClient: SupabaseClient,
  matches: LineMatchToPersist[],
): Promise<PersistLineMatchesOutcome> {
  const outcome: PersistLineMatchesOutcome = { matchedCount: 0, needsReviewCount: 0, unmatchedCount: 0 };

  if (matches.length === 0) {
    return outcome;
  }

  const rows = matches.map(({ ocrLineId, result }) => {
    if (result.status === 'matched') {
      outcome.matchedCount += 1;
    } else if (result.status === 'needs_review') {
      outcome.needsReviewCount += 1;
    } else {
      outcome.unmatchedCount += 1;
    }

    return {
      ocr_line_id: ocrLineId,
      product_id: result.productId,
      match_status: result.status,
      match_method: result.method,
      confidence: result.confidence,
      matched_text: result.matchedText,
      // A short, fixed internal category (e.g. 'ambiguous_exact_sku'), or
      // null for matched/unmatched - never verbose/raw receipt text. This
      // column is internal-only: excluded from the client-readable column
      // grant in 007_create_product_matching.sql.
      review_note: result.reviewReason,
    };
  });

  const { error } = await adminClient.from('receipt_line_matches').upsert(rows, { onConflict: 'ocr_line_id' });

  if (error) {
    throw new Error(`Failed to persist receipt_line_matches: ${error.message}`);
  }

  return outcome;
}

// =====================================================================
// OCR Product Matching Stage 3: orchestrates one report's product
// matching pass, mirroring ocrNormalization.ts's own
// normalizeAndPersistOcrLines() (load -> compute -> persist, one
// self-contained function, called with a single line from index.ts).
// Reuses loadActiveProductCatalog()/persistLineMatches() above and
// matchOcrLineFromEvidence() (productMatcher.ts) - no write logic is
// duplicated anywhere in this function.
// =====================================================================

export interface MatchAndPersistOutcome {
  sourceLineCount: number;
  skippedMergedParentCount: number;
  matchedCount: number;
  needsReviewCount: number;
  unmatchedCount: number;
  conflictCount: number;
}

export interface OcrLineRow {
  id: string;
  raw_text: string | null;
  normalized_text: string | null;
  product_code: string | null;
  normalized_product_code: string | null;
  normalization_notes: Record<string, unknown> | null;
}

// true only when ocrNormalization.ts's detectMergedItem() found strong
// evidence that this ONE Azure item actually represents more than one
// invoice row (see normalization_notes.merge.detected) - whether or not
// the split itself succeeded. Read directly, never recomputed - Stage 3
// must not re-implement Stage 2's merge detection.
export function wasMergedParent(row: OcrLineRow): boolean {
  const merge = row.normalization_notes?.merge as Record<string, unknown> | undefined;
  return merge?.detected === true;
}

// true only when ocrNormalization.ts's computeCrossEvidence() itself
// found a unique SKU resolution and a unique barcode match pointing at
// two DIFFERENT products (see normalization_notes.crossEvidence.conflict).
// Read directly, never recomputed - Stage 3 must not duplicate Stage 2's
// barcode-normalization/cross-evidence logic.
export function hasConflictingEvidence(row: OcrLineRow): boolean {
  const crossEvidence = row.normalization_notes?.crossEvidence as Record<string, unknown> | undefined;
  return crossEvidence?.conflict === true;
}

// Runs product matching for every matchable receipt_ocr_lines row
// belonging to one OCR result, and persists the results.
//
// Matchable = every row EXCEPT a merged-item PARENT (wasMergedParent()) -
// a row Stage 2 determined actually represents more than one product is
// never independently matched, whether or not it was successfully split
// into recovered child rows; each recovered child (its own real
// receipt_ocr_lines row, with its own normalized_product_code already set
// by Stage 2) is matched independently like any other line, so no special
// case is needed for it beyond simply not being excluded.
//
// Idempotent by construction: existing receipt_line_matches rows for
// every line belonging to this OCR result are deleted BEFORE the fresh
// set is persisted (mirroring the same delete-then-insert convention
// ocrPersistence.ts already uses for receipt_ocr_lines itself) - so a
// rerun can never leave a stale match behind for a line that used to be
// matchable and no longer is (e.g. a line that becomes a detected-merge
// parent on a re-normalization), and persistLineMatches()'s own upsert-
// on-ocr_line_id then makes the actual write safe to repeat besides.
export async function matchAndPersistOcrLines(
  adminClient: SupabaseClient,
  ocrResultId: string,
): Promise<MatchAndPersistOutcome> {
  const outcome: MatchAndPersistOutcome = {
    sourceLineCount: 0,
    skippedMergedParentCount: 0,
    matchedCount: 0,
    needsReviewCount: 0,
    unmatchedCount: 0,
    conflictCount: 0,
  };

  const { data: lineRows, error: fetchError } = await adminClient
    .from('receipt_ocr_lines')
    .select('id, raw_text, normalized_text, product_code, normalized_product_code, normalization_notes')
    .eq('ocr_result_id', ocrResultId)
    .order('line_index', { ascending: true });

  if (fetchError) {
    throw new Error(`Failed to load receipt_ocr_lines for matching: ${fetchError.message}`);
  }

  const lines = (lineRows ?? []) as OcrLineRow[];
  outcome.sourceLineCount = lines.length;

  if (lines.length === 0) {
    return outcome;
  }

  // Clear any previous match results for this report's lines first (see
  // the idempotency note above) - safe even if no rows exist yet.
  const allLineIds = lines.map((row) => row.id);
  const { error: deleteError } = await adminClient.from('receipt_line_matches').delete().in('ocr_line_id', allLineIds);

  if (deleteError) {
    throw new Error(`Failed to clear existing receipt_line_matches: ${deleteError.message}`);
  }

  const catalog = await loadActiveProductCatalog(adminClient);

  const matches: LineMatchToPersist[] = [];

  for (const row of lines) {
    if (wasMergedParent(row)) {
      outcome.skippedMergedParentCount += 1;
      continue;
    }

    const conflict = hasConflictingEvidence(row);
    const evidence: OcrLineEvidence = {
      text: row.raw_text ?? '',
      normalizedText: row.normalized_text,
      productCode: row.product_code,
      normalizedProductCode: row.normalized_product_code,
      hasConflictingEvidence: conflict,
    };

    const result = matchOcrLineFromEvidence(evidence, catalog);
    if (conflict) {
      outcome.conflictCount += 1;
    }

    matches.push({ ocrLineId: row.id, result });
  }

  const persistOutcome = await persistLineMatches(adminClient, matches);
  outcome.matchedCount = persistOutcome.matchedCount;
  outcome.needsReviewCount = persistOutcome.needsReviewCount;
  outcome.unmatchedCount = persistOutcome.unmatchedCount;

  return outcome;
}
