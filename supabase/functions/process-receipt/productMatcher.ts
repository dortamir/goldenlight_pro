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
  // Added for OCR Integration Stage 2 (ocrNormalization.ts) - barcode
  // evidence validation, not a matching strategy here. matchOcrLine()
  // below does not read this field; it exists purely so
  // loadActiveProductCatalog() has one shared catalog shape for both
  // consumers rather than two near-duplicate loaders. Optional (not every
  // real catalog row has one - see 018_product_catalog_foundation.sql's
  // own note on missing barcodes) so every existing productMatcher.test.ts
  // fixture stays valid without needing to add it everywhere.
  barcode?: string | null;
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
// Stage 3 (OCR Product Matching) adds 'normalized_sku_exact' and
// 'description_fuzzy' - see matchOcrLineFromEvidence() below.
export type MatchMethod =
  | 'exact_sku'
  | 'normalized_sku'
  | 'alias'
  | 'name'
  | 'similarity'
  | 'manual'
  | 'normalized_sku_exact'
  | 'description_fuzzy';

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

// =====================================================================
// OCR Product Matching Stage 3: wires the Stage 2 normalized OCR
// evidence (receipt_ocr_lines.normalized_product_code, and the barcode/
// conflict evidence Stage 2 already computed into normalization_notes)
// into this SAME matcher - matchOcrLine() above is completely unchanged
// and remains the fallback cascade for the original Azure evidence
// (product_code/description text). This is deliberately NOT a second
// matcher: matchOcrLineFromEvidence() below calls matchOcrLine()
// internally for everything it doesn't resolve itself.
//
// Evidence priority (per the Stage 3 spec):
//   1. A genuine Stage 2 SKU-vs-barcode conflict (already detected by
//      ocrNormalization.ts's computeCrossEvidence(), never recomputed
//      here) -> needs_review immediately, before anything else is tried.
//   2. normalized_product_code, when present - Stage 2 already validated
//      it against the real active-SKU catalog, so an exact unique match
//      here is the strongest possible SKU evidence.
//   3. Falls back to matchOcrLine() against the original product_code +
//      line text - exact_sku/normalized_sku/alias/name, unchanged.
//   4. If that finds nothing (unmatched), a fuzzy description candidate
//      (ported from src/services/productMatching.js - see that file's own
//      "SAME MATCHER AS THE FUTURE OCR PIPELINE, NOT A SECOND ONE" header
//      for why this is a deliberate, already-established mirroring
//      convention, not a new algorithm) - always needs_review, never
//      auto-matched, regardless of score.
// =====================================================================

// --- Fuzzy description matching (ported from productMatching.js) ----------------
// Mirrors productMatching.js's normalizeDescriptionText/diceCoefficient/
// FUZZY_SUGGEST_THRESHOLD/FUZZY_MAX_CONFIDENCE EXACTLY - both files must
// stay in sync, the same convention already established (and documented)
// for normalizeCatalogText() above. Deliberately NOT changed/tuned here -
// "do not change the existing fuzzy algorithm unless absolutely
// necessary".

// A gentler normalization for free-text product/description matching -
// deliberately different from normalizeCatalogText: word/number
// boundaries carry real meaning in natural-language text, so this only
// strips punctuation, never collapses all whitespace away.
const DESCRIPTION_STRIP_REGEX = /[^a-z0-9\u0590-\u05FF\s]/g;
export function normalizeDescriptionText(input: string | null | undefined): string {
  const lower = (input ?? '').trim().toLowerCase();
  const withSpaces = lower.replace(DESCRIPTION_STRIP_REGEX, ' ');
  return withSpaces.replace(/\s+/g, ' ').trim();
}

// Character-bigram Sorensen-Dice coefficient - deterministic, explainable,
// no AI/ML dependency.
function bigrams(value: string): string[] {
  const grams: string[] = [];
  for (let i = 0; i < value.length - 1; i += 1) {
    grams.push(value.slice(i, i + 2));
  }
  return grams;
}

export function diceCoefficient(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const bigramsA = bigrams(a);
  const bigramsB = bigrams(b);
  if (bigramsA.length === 0 || bigramsB.length === 0) return 0;

  const remaining = new Map<string, number>();
  for (const gram of bigramsA) {
    remaining.set(gram, (remaining.get(gram) || 0) + 1);
  }

  let intersection = 0;
  for (const gram of bigramsB) {
    const count = remaining.get(gram) || 0;
    if (count > 0) {
      intersection += 1;
      remaining.set(gram, count - 1);
    }
  }

  return (2 * intersection) / (bigramsA.length + bigramsB.length);
}

// A fuzzy candidate below this Dice score is not even suggested. Fuzzy
// results are always capped below every exact tier's confidence and are
// NEVER auto-applied regardless of score.
export const FUZZY_SUGGEST_THRESHOLD = 0.55;
export const FUZZY_MAX_CONFIDENCE = 0.89;

// --- Stage 3 evidence input -------------------------------------------------------

export interface OcrLineEvidence {
  // The line's own text (used for the matchOcrLine() fallback and the
  // fuzzy description strategy) - same as MatchableOcrLine.text.
  text: string;
  normalizedText?: string | null;
  // receipt_ocr_lines.product_code (Stage 1's original, unmodified Azure
  // ProductCode) - folded into the matchOcrLine() fallback call so its
  // existing substring-based SKU strategies still see it, exactly as they
  // would have seen it concatenated into a single OCR line pre-Stage-1/2.
  productCode?: string | null;
  // receipt_ocr_lines.normalized_product_code (Stage 2) - the strongest
  // possible SKU evidence when present. Never re-derived/re-normalized
  // here - Stage 2 owns that.
  normalizedProductCode?: string | null;
  // true only when ocrNormalization.ts's computeCrossEvidence() itself
  // found a unique SKU resolution and a unique barcode match pointing at
  // TWO DIFFERENT products (receipt_ocr_lines.normalization_notes.
  // crossEvidence.conflict) - read directly, never recomputed here (Stage
  // 3 must not duplicate Stage 2's barcode-normalization/cross-evidence
  // logic).
  hasConflictingEvidence?: boolean;
}

// Same result builders as matchOcrLine() above, reused here so every
// LineMatchResult produced by this module (regardless of which strategy)
// has an identical shape - no separate result type for Stage 3.
function matchedResultForProduct(
  product: CatalogProduct,
  method: MatchMethod,
  matchedText: string,
): LineMatchResult {
  return { status: 'matched', productId: product.id, method, confidence: 1.0, matchedText, reviewReason: null };
}

export function matchOcrLineFromEvidence(evidence: OcrLineEvidence, catalog: ProductCatalog): LineMatchResult {
  // 1. A genuine SKU-vs-barcode conflict, already detected by Stage 2 -
  // never choose either signal silently, and never fall through to a
  // weaker strategy that might produce a DIFFERENT, equally unverified
  // answer.
  if (evidence.hasConflictingEvidence) {
    return needsReviewResult('conflicting_evidence');
  }

  // 2. normalized_product_code - the strongest deterministic SKU
  // evidence. Stage 2 only ever sets this when it already found exactly
  // one real active-SKU match, so this is a plain exact-equality lookup,
  // never a substring/containment search and never re-split into
  // multiple candidate tokens again.
  const normalizedProductCode = evidence.normalizedProductCode?.trim();
  if (normalizedProductCode) {
    const activeProducts = catalog.products.filter((product) => product.isActive);
    const normalized = normalizeCatalogText(normalizedProductCode);
    const candidates = uniqueProducts(
      activeProducts.filter((product) => normalizeCatalogText(product.sku) === normalized),
    );

    if (candidates.length === 1) {
      return matchedResultForProduct(candidates[0], 'normalized_sku_exact', normalizedProductCode);
    }
    if (candidates.length > 1) {
      // Should not normally happen (Stage 2 already validated uniqueness
      // against this same catalog), but the catalog could have changed
      // between normalization and matching - never guess.
      return needsReviewResult('ambiguous_normalized_sku_exact');
    }
    // No active product currently matches - fall through to the original-
    // evidence cascade below rather than assuming.
  }

  // 3. Fall back to the existing, unchanged matchOcrLine() cascade
  // (exact_sku/normalized_sku/alias/name) against the ORIGINAL Azure
  // evidence - product_code folded into the line text so its substring-
  // based SKU strategies still find it, exactly like before Stage 1/2
  // separated product_code out into its own column. No new OCR-cleanup
  // rule is invented here.
  const combinedText = evidence.productCode ? `${evidence.productCode} ${evidence.text ?? ''}`.trim() : evidence.text ?? '';
  const fallbackResult = matchOcrLine({ text: combinedText }, catalog);

  if (fallbackResult.status !== 'unmatched') {
    return fallbackResult;
  }

  // 4. Fuzzy description candidate - last resort, always needs_review,
  // never auto-matched. Mirrors productMatching.js's own fuzzy strategy
  // exactly (same threshold/cap), only reachable after every deterministic
  // strategy above found nothing.
  const normalizedDescription = normalizeDescriptionText(evidence.normalizedText ?? evidence.text);
  if (normalizedDescription) {
    const activeProducts = catalog.products.filter((product) => product.isActive);
    let bestScore = 0;
    let bestProduct: CatalogProduct | null = null;

    for (const product of activeProducts) {
      const score = diceCoefficient(normalizedDescription, normalizeDescriptionText(product.name));
      if (score > bestScore) {
        bestScore = score;
        bestProduct = product;
      }
    }

    if (bestProduct && bestScore >= FUZZY_SUGGEST_THRESHOLD) {
      // A fuzzy result is always needs_review (never 'matched'), no
      // matter how high the score is - the admin's explicit confirmation
      // is what would turn this into a real match, in a later stage.
      // productId/matchedText are intentionally omitted here (same
      // convention as every other needs_review result in this module) -
      // the fuzzy candidate itself is not persisted as a schema change
      // this stage; see the Stage 3 report for why.
      return needsReviewResult('fuzzy_candidate');
    }
  }

  return unmatchedResult();
}
