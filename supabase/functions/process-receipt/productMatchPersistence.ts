// Server-side I/O for product matching: loading the active catalog and
// persisting match results. Every function here takes an already-authorized
// service-role Supabase client - this module performs no auth/ownership
// checks of its own. Kept separate from productMatcher.ts (pure logic, no
// Supabase/Deno dependency) so the matching algorithm stays trivially
// unit-testable in isolation.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

import type { CatalogAlias, CatalogProduct, LineMatchResult, ProductCatalog } from './productMatcher.ts';

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
    .select('id, sku, name, is_active')
    .eq('is_active', true);

  if (productsError) {
    throw new Error(`Failed to load product catalog: ${productsError.message}`);
  }

  const products: CatalogProduct[] = (productRows ?? []).map((row: Record<string, unknown>) => ({
    id: row.id as string,
    sku: row.sku as string,
    name: row.name as string,
    isActive: Boolean(row.is_active),
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
