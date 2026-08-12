// Vendor-neutral, deterministic product matching for a single OCR receipt
// line against the active Golden Light product catalog. Pure functions only
// - no Supabase client, no Deno-specific APIs, no React Native coupling, so
// this module is trivially unit-testable (see productMatcher.test.ts) and
// stays entirely independent of how the catalog/lines are actually loaded
// or persisted (see productMatchPersistence.ts for that).
//
// IMPORTANT: this module must never fabricate a match. Ambiguous cases
// (more than one distinct product could plausibly match the same line)
// always resolve to 'needs_review', never an arbitrary pick. An empty
// catalog always resolves to 'unmatched'. Nothing here awards points or
// approves a purchase report - matching is a separate, earlier step.

// --- Input shapes ------------------------------------------------------------

export interface MatchableOcrLine {
  text: string;
  normalizedText?: string | null;
}

export interface CatalogProduct {
  id: string;
  sku: string;
  name: string;
  isActive: boolean;
}

export interface CatalogAlias {
  productId: string;
  alias: string;
  normalizedAlias: string;
}

export interface ProductCatalog {
  products: CatalogProduct[];
  aliases: CatalogAlias[];
}

// --- Result shape --------------------------------------------------------------

export type MatchStatus = 'matched' | 'unmatched' | 'needs_review';

// Conceptual set for now - deliberately not a closed union, since the
// database's match_method column is not constrained to a fixed check
// either (see migration 007_create_product_matching.sql), and new
// strategies are expected to be added later without a schema change.
export type MatchMethod = 'exact_sku' | 'normalized_sku' | 'alias' | 'name' | 'similarity' | 'manual';

export interface LineMatchResult {
  status: MatchStatus;
  productId: string | null;
  method: MatchMethod | null;
  confidence: number | null;
  matchedText: string | null;
  // Short internal category explaining a needs_review result (e.g.
  // 'ambiguous_exact_sku'). Always null for matched/unmatched. Intended for
  // receipt_line_matches.review_note - an internal/admin diagnostic only,
  // never verbose or raw receipt text, and never exposed to the mobile
  // client (see the column-level SELECT grant in
  // 007_create_product_matching.sql, which omits review_note).
  reviewReason: string | null;
}

// --- Normalization -------------------------------------------------------------
// Mirrors public.normalize_catalog_text() (see
// supabase/migrations/004_create_product_catalog.sql) EXACTLY:
// lowercase, trim, then strip runs of -, _, /, \, then strip all remaining
// whitespace. Hebrew, English, and digits are all preserved untouched.
//
// This MUST stay aligned with the database function - if one changes, the
// other must change with it, or SKUs/aliases that normalize identically in
// Postgres could normalize differently here (or vice versa), silently
// breaking matching.
export function normalizeCatalogText(input: string | null | undefined): string {
  const trimmedLower = (input ?? '').trim().toLowerCase();
  const withoutSeparators = trimmedLower.replace(/[-_/\\]+/g, '');
  return withoutSeparators.replace(/\s+/g, '');
}

// --- Small result builders -------------------------------------------------------

function matchedResult(product: CatalogProduct, method: MatchMethod, matchedText: string): LineMatchResult {
  // Deterministic exact matches only ever reach this point - 1.0 is the
  // only confidence value this foundation ever produces. No nuanced
  // percentages are invented.
  return { status: 'matched', productId: product.id, method, confidence: 1.0, matchedText, reviewReason: null };
}

// reason is a short, fixed internal category (never raw receipt text) - see
// the call sites below for the exact set of values this module produces.
function needsReviewResult(reason: string): LineMatchResult {
  return {
    status: 'needs_review',
    productId: null,
    method: null,
    confidence: null,
    matchedText: null,
    reviewReason: reason,
  };
}

function unmatchedResult(): LineMatchResult {
  return {
    status: 'unmatched',
    productId: null,
    method: null,
    confidence: null,
    matchedText: null,
    reviewReason: null,
  };
}

function uniqueProducts(products: CatalogProduct[]): CatalogProduct[] {
  const byId = new Map<string, CatalogProduct>();
  for (const product of products) {
    byId.set(product.id, product);
  }
  return Array.from(byId.values());
}

// --- Reserved for a future strategy --------------------------------------------
// Not implemented and never called by matchOcrLine() below. Kept only as a
// documented extension point so a future fuzzy/similarity strategy has an
// obvious place to live without redesigning the matcher's cascade. No
// similarity scoring or confidence threshold exists anywhere in this module
// today.
export interface SimilarityMatchStrategy {
  match(line: MatchableOcrLine, catalog: ProductCatalog): LineMatchResult | null;
}

// --- Main matching entry point --------------------------------------------------
//
// Strategy order (each only runs if the previous found nothing):
//   1. Exact raw SKU     - the SKU appears verbatim (case-insensitive, same
//                          separators as catalogued) inside the raw line.
//   2. Normalized SKU    - catches formatting variants (GL 10452, GL/10452,
//                          GL_10452, ...) that strategy 1 would miss, via
//                          normalizeCatalogText() on both sides.
//   3. Exact normalized alias - the line's normalized text exactly EQUALS a
//                          known alias (not merely contains it).
//   4. Exact normalized product name - same equality-based conservatism as
//                          aliases.
//
// Strategies 1-2 use substring containment because a real receipt line
// commonly carries more than the bare SKU (quantity, price, description),
// and the task's own examples ("GL-10452 ספוט LED 7W 4 יח") require finding
// the SKU embedded inside a longer line. Strategies 3-4 deliberately use
// exact equality instead of containment: alias/name text is far more likely
// to coincide with unrelated words inside a longer line (the SKU pattern is
// distinctive; a product name often is not), so equality keeps this
// foundation conservative rather than treating a small common word as a
// product match.
//
// At every strategy, if more than one *distinct* product qualifies, the
// result is 'needs_review' immediately - this function never guesses among
// ambiguous candidates.
export function matchOcrLine(line: MatchableOcrLine, catalog: ProductCatalog): LineMatchResult {
  const rawText = (line.text ?? '').trim();
  const normalizedLine = normalizeCatalogText(line.normalizedText ?? line.text ?? '');

  if (!rawText && !normalizedLine) {
    return unmatchedResult();
  }

  const activeProducts = catalog.products.filter((product) => product.isActive);

  if (activeProducts.length === 0) {
    // No active catalog to match against - expected until real Golden
    // Light product data is imported. Never fabricate a match here.
    return unmatchedResult();
  }

  // Strategy 1: exact raw SKU.
  const lowerRawText = rawText.toLowerCase();
  const exactSkuCandidates = uniqueProducts(
    activeProducts.filter((product) => product.sku && lowerRawText.includes(product.sku.toLowerCase())),
  );
  if (exactSkuCandidates.length === 1) {
    return matchedResult(exactSkuCandidates[0], 'exact_sku', exactSkuCandidates[0].sku);
  }
  if (exactSkuCandidates.length > 1) {
    return needsReviewResult('ambiguous_exact_sku');
  }

  // Strategy 2: normalized SKU.
  const normalizedSkuCandidates = uniqueProducts(
    activeProducts.filter((product) => {
      const normalizedSku = normalizeCatalogText(product.sku);
      return normalizedSku.length > 0 && normalizedLine.includes(normalizedSku);
    }),
  );
  if (normalizedSkuCandidates.length === 1) {
    return matchedResult(normalizedSkuCandidates[0], 'normalized_sku', normalizedSkuCandidates[0].sku);
  }
  if (normalizedSkuCandidates.length > 1) {
    return needsReviewResult('ambiguous_normalized_sku');
  }

  // Strategy 3: exact normalized alias.
  if (normalizedLine) {
    const aliasProductIds = new Set<string>();
    let aliasMatchedText: string | null = null;

    for (const alias of catalog.aliases) {
      if (alias.normalizedAlias && alias.normalizedAlias === normalizedLine) {
        aliasProductIds.add(alias.productId);
        aliasMatchedText = alias.alias;
      }
    }

    const activeAliasCandidates = Array.from(aliasProductIds)
      .map((productId) => activeProducts.find((product) => product.id === productId))
      .filter((product): product is CatalogProduct => Boolean(product));

    if (activeAliasCandidates.length === 1) {
      return matchedResult(activeAliasCandidates[0], 'alias', aliasMatchedText ?? activeAliasCandidates[0].sku);
    }
    if (activeAliasCandidates.length > 1) {
      return needsReviewResult('ambiguous_alias');
    }
  }

  // Strategy 4: exact normalized product name.
  if (normalizedLine) {
    const nameCandidates = uniqueProducts(
      activeProducts.filter((product) => normalizeCatalogText(product.name) === normalizedLine),
    );
    if (nameCandidates.length === 1) {
      return matchedResult(nameCandidates[0], 'name', nameCandidates[0].name);
    }
    if (nameCandidates.length > 1) {
      return needsReviewResult('ambiguous_name');
    }
  }

  return unmatchedResult();
}
