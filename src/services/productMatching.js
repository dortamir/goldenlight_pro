// Deterministic product matching for the admin "manual receipt item" review
// flow, against the real Golden Light catalog (public.products /
// public.product_aliases, populated in
// supabase/migrations/018_product_catalog_foundation.sql).
//
// SAME MATCHER AS THE FUTURE OCR PIPELINE, NOT A SECOND ONE: this is a
// plain-JS port of the exact same priority cascade already implemented for
// OCR lines in supabase/functions/process-receipt/productMatcher.ts (SKU
// exact -> normalized SKU -> alias exact -> name exact), extended here with
// the two strategies that file explicitly reserved but never implemented:
// barcode-exact (priority 1, ahead of SKU - see that file's CatalogProduct
// type, which predates the `barcode` column added in 018) and a real
// description-similarity/fuzzy strategy (that file's `SimilarityMatchStrategy`
// interface, documented there as "Not implemented and never called").
// Both modules stay independently pure/dependency-free and unit-testable,
// and both must stay in sync with public.normalize_catalog_text() (SKU/alias
// normalization) - see normalizeCatalogText() below, copied verbatim.
//
// WHY A SEPARATE PORT INSTEAD OF IMPORTING productMatcher.ts DIRECTLY: that
// file lives under supabase/functions/ and imports from
// `https://esm.sh/@supabase/supabase-js@2` - a Deno Edge Function module
// path that does not resolve inside the Expo/React Native/Metro bundle.
// Nothing about the MATCHING ALGORITHM differs for that reason; only the
// runtime/module system does. If a genuine shared-package extraction is
// ever justified, it should replace both copies at once - not attempted
// here, to avoid touching the OCR pipeline (explicitly out of scope this
// stage) for a purely structural reason.
//
// This module never fabricates a match. Ambiguous candidates always resolve
// to 'needs_review' with every tied candidate listed - never an arbitrary
// pick. A fuzzy/similarity result is ALWAYS 'needs_review' (a suggestion for
// the admin to confirm), never 'matched', regardless of how high its score
// is - the admin's explicit confirmation is what turns a fuzzy suggestion
// into a real, authoritative match (see productMatching persistence in
// AdminReportDetailScreen.js and 019_product_matching_manual_items.sql).

// --- Normalization ---------------------------------------------------------

// Mirrors public.normalize_catalog_text() (004_create_product_catalog.sql)
// and productMatcher.ts's normalizeCatalogText() EXACTLY: lowercase, trim,
// strip runs of -_/\\, then strip all remaining whitespace. Used for SKU and
// alias comparisons, where separator/spacing variants should collapse
// together (see matchManualItem's sku_normalized strategy and the module
// header's "GL411001 should NOT auto-match 411001" example - it doesn't,
// since normalizeCatalogText keeps the "gl" prefix and only strips
// separators/whitespace, never arbitrary substrings).
export function normalizeCatalogText(input) {
  const trimmedLower = (input ?? '').trim().toLowerCase();
  const withoutSeparators = trimmedLower.replace(/[-_/\\]+/g, '');
  return withoutSeparators.replace(/\s+/g, '');
}

// A gentler normalization for free-text product/description matching -
// deliberately DIFFERENT from normalizeCatalogText above. A SKU like
// "411-001" and "411 001" should collapse to the same key with no space at
// all (there is no word-boundary meaning in a product code), but a
// description like "מפסק 1M לבן" must NOT collapse to a single run of
// characters - word/number boundaries carry real meaning in natural-language
// text, and merging them risks false-positive matches between unrelated
// descriptions that happen to share the same characters in a different
// arrangement. This function: lowercases, trims, replaces any character that
// is not a Hebrew letter, Latin letter, digit, or whitespace with a single
// space (removing punctuation "where safe" without touching Hebrew/English
// words or numeric tokens), then collapses runs of whitespace to one space.
const DESCRIPTION_STRIP_REGEX = new RegExp('[^a-z0-9\\u0590-\\u05FF\\s]', 'g');
export function normalizeDescriptionText(input) {
  const lower = (input ?? '').trim().toLowerCase();
  const withSpaces = lower.replace(DESCRIPTION_STRIP_REGEX, ' ');
  return withSpaces.replace(/\s+/g, ' ').trim();
}

// --- Similarity --------------------------------------------------------------

// Character-bigram Sorensen-Dice coefficient: a small, deterministic,
// explainable similarity score in [0, 1] - not a heavy AI/ML dependency,
// just string comparison. Character-based (not word-based) so it degrades
// gracefully on Hebrew text without needing a tokenizer/stemmer.
function bigrams(value) {
  const grams = [];
  for (let i = 0; i < value.length - 1; i += 1) {
    grams.push(value.slice(i, i + 2));
  }
  return grams;
}

export function diceCoefficient(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const bigramsA = bigrams(a);
  const bigramsB = bigrams(b);
  if (bigramsA.length === 0 || bigramsB.length === 0) return 0;

  const remaining = new Map();
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

// --- Confidence heuristics ---------------------------------------------------
// Starting values only, not permanent business rules - centralized here so
// they can be tuned later without touching the matching logic itself. Higher
// tiers are checked first and short-circuit the cascade (see
// matchManualItem below); the numeric ordering here is for display/auto-
// apply-threshold purposes only, not what decides which tier "wins" (the
// cascade order does that, exactly like productMatcher.ts).
export const MATCH_CONFIDENCE = {
  barcode_exact: 1.0,
  sku_exact: 0.99,
  sku_normalized: 0.97,
  alias_exact: 0.98,
  description_exact: 0.95,
};

// A fuzzy candidate below this Dice score is not even suggested - too weak
// to be useful to an admin. Fuzzy results are always capped below every
// exact-tier confidence (FUZZY_MAX_CONFIDENCE) and are NEVER auto-applied
// regardless of score - see matchManualItem's final strategy below and the
// "never auto-mark Golden Light on poor confidence" requirement.
export const FUZZY_SUGGEST_THRESHOLD = 0.55;
export const FUZZY_MAX_CONFIDENCE = 0.89;
export const FUZZY_MAX_CANDIDATES = 5;

// --- Result builders -----------------------------------------------------------

function uniqueProducts(products) {
  const byId = new Map();
  for (const product of products) {
    byId.set(product.id, product);
  }
  return Array.from(byId.values());
}

function toCandidate(product, method, confidence, matchedText) {
  return { productId: product.id, sku: product.sku, name: product.name, method, confidence, matchedText };
}

function matchedResult(product, method, confidence, matchedText) {
  return {
    status: 'matched',
    productId: product.id,
    method,
    confidence,
    matchedText,
    reviewReason: null,
    candidates: [],
  };
}

function needsReviewResult(reason, candidates) {
  return {
    status: 'needs_review',
    productId: null,
    method: null,
    confidence: null,
    matchedText: null,
    reviewReason: reason,
    candidates: candidates || [],
  };
}

function unmatchedResult() {
  return {
    status: 'unmatched',
    productId: null,
    method: null,
    confidence: null,
    matchedText: null,
    reviewReason: null,
    candidates: [],
  };
}

// --- Main matching entry point --------------------------------------------------
//
// input: { description, code } - code is whatever short code text the admin
// captured for this manual line (may be a SKU or a barcode as printed on the
// receipt - manual entry does not distinguish the two at capture time, so
// both are checked, barcode first per the task's priority order).
//
// catalog: { products: [{ id, sku, name, barcode, isActive }], aliases: [{ productId, alias, normalizedAlias }] }
//
// Strategy order (each only runs if the previous strategy found ZERO
// candidates - identical short-circuit behavior to productMatcher.ts):
//   1. Barcode exact       - code equals a product's barcode.
//   2. SKU exact            - code equals a product's sku (case-insensitive).
//   3. SKU normalized       - normalizeCatalogText(code) equals
//                             normalizeCatalogText(sku) - catches
//                             formatting variants (411-001, 411 001, 411/001)
//                             WITHOUT matching an unrelated superstring like
//                             "GL411001" (that is what aliases are for).
//   4. Alias exact           - normalizeCatalogText(description) equals a
//                             known alias's normalized_alias (this is the
//                             SAME normalization the database trigger uses
//                             to populate product_aliases.normalized_alias -
//                             required so an alias learned via a manual
//                             confirmation is found again automatically on a
//                             later occurrence of the same text).
//   5. Description exact    - normalizeDescriptionText(description) equals
//                             normalizeDescriptionText(product name).
//   6. Description fuzzy    - Dice-coefficient similarity, ALWAYS returned
//                             as 'needs_review' candidates (never 'matched'),
//                             capped below every exact tier's confidence.
//
// At every exact tier (1-5), more than one distinct product qualifying
// resolves to 'needs_review' with all tied candidates listed - never a
// guess.
export function matchManualItem({ description, code } = {}, catalog) {
  const trimmedDescription = (description ?? '').trim();
  const trimmedCode = (code ?? '').trim();

  if (!trimmedDescription && !trimmedCode) {
    return unmatchedResult();
  }

  const activeProducts = (catalog?.products ?? []).filter((product) => product.isActive);
  if (activeProducts.length === 0) {
    return unmatchedResult();
  }

  const lowerCode = trimmedCode.toLowerCase();
  const normalizedCode = trimmedCode ? normalizeCatalogText(trimmedCode) : '';
  const normalizedDescriptionForAlias = trimmedDescription ? normalizeCatalogText(trimmedDescription) : '';
  const normalizedDescription = normalizeDescriptionText(trimmedDescription);

  // 1. Barcode exact.
  if (trimmedCode) {
    const candidates = uniqueProducts(
      activeProducts.filter((product) => product.barcode && product.barcode.trim().toLowerCase() === lowerCode),
    );
    if (candidates.length === 1) {
      return matchedResult(candidates[0], 'barcode_exact', MATCH_CONFIDENCE.barcode_exact, trimmedCode);
    }
    if (candidates.length > 1) {
      return needsReviewResult(
        'ambiguous_barcode',
        candidates.map((product) => toCandidate(product, 'barcode_exact', MATCH_CONFIDENCE.barcode_exact, trimmedCode)),
      );
    }
  }

  // 2. SKU exact.
  if (trimmedCode) {
    const candidates = uniqueProducts(
      activeProducts.filter((product) => product.sku && product.sku.trim().toLowerCase() === lowerCode),
    );
    if (candidates.length === 1) {
      return matchedResult(candidates[0], 'sku_exact', MATCH_CONFIDENCE.sku_exact, trimmedCode);
    }
    if (candidates.length > 1) {
      return needsReviewResult(
        'ambiguous_sku_exact',
        candidates.map((product) => toCandidate(product, 'sku_exact', MATCH_CONFIDENCE.sku_exact, trimmedCode)),
      );
    }
  }

  // 3. SKU normalized.
  if (normalizedCode) {
    const candidates = uniqueProducts(
      activeProducts.filter((product) => {
        const normalizedSku = normalizeCatalogText(product.sku);
        return normalizedSku.length > 0 && normalizedSku === normalizedCode;
      }),
    );
    if (candidates.length === 1) {
      return matchedResult(candidates[0], 'sku_normalized', MATCH_CONFIDENCE.sku_normalized, trimmedCode);
    }
    if (candidates.length > 1) {
      return needsReviewResult(
        'ambiguous_sku_normalized',
        candidates.map((product) => toCandidate(product, 'sku_normalized', MATCH_CONFIDENCE.sku_normalized, trimmedCode)),
      );
    }
  }

  // 4. Alias exact.
  if (normalizedDescriptionForAlias) {
    const productIds = new Set();
    let matchedAliasText = null;

    for (const alias of catalog?.aliases ?? []) {
      if (alias.normalizedAlias && alias.normalizedAlias === normalizedDescriptionForAlias) {
        productIds.add(alias.productId);
        matchedAliasText = alias.alias;
      }
    }

    const candidates = uniqueProducts(
      Array.from(productIds)
        .map((id) => activeProducts.find((product) => product.id === id))
        .filter(Boolean),
    );

    if (candidates.length === 1) {
      return matchedResult(
        candidates[0],
        'alias_exact',
        MATCH_CONFIDENCE.alias_exact,
        matchedAliasText ?? trimmedDescription,
      );
    }
    if (candidates.length > 1) {
      return needsReviewResult(
        'ambiguous_alias',
        candidates.map((product) => toCandidate(product, 'alias_exact', MATCH_CONFIDENCE.alias_exact, matchedAliasText)),
      );
    }
  }

  // 5. Description exact.
  if (normalizedDescription) {
    const candidates = uniqueProducts(
      activeProducts.filter((product) => normalizeDescriptionText(product.name) === normalizedDescription),
    );
    if (candidates.length === 1) {
      return matchedResult(candidates[0], 'description_exact', MATCH_CONFIDENCE.description_exact, candidates[0].name);
    }
    if (candidates.length > 1) {
      return needsReviewResult(
        'ambiguous_description_exact',
        candidates.map((product) =>
          toCandidate(product, 'description_exact', MATCH_CONFIDENCE.description_exact, product.name),
        ),
      );
    }
  }

  // 6. Description fuzzy - suggestion only, never auto-matched.
  if (normalizedDescription) {
    const scored = activeProducts
      .map((product) => ({
        product,
        score: diceCoefficient(normalizedDescription, normalizeDescriptionText(product.name)),
      }))
      .filter((entry) => entry.score >= FUZZY_SUGGEST_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, FUZZY_MAX_CANDIDATES);

    if (scored.length > 0) {
      const candidates = scored.map((entry) =>
        toCandidate(entry.product, 'description_fuzzy', Math.min(entry.score, FUZZY_MAX_CONFIDENCE), entry.product.name),
      );
      return needsReviewResult('fuzzy_candidates', candidates);
    }
  }

  return unmatchedResult();
}

// --- Unified suggestion/search mechanism ---------------------------------------
//
// ONE shared function, used for every text-driven product lookup in the admin
// UI: the inline "as you type" dropdown under both the description AND the
// SKU/barcode input in AdminReportDetailScreen.js, and the product-match
// modal's free-text search box. There is deliberately no second, competing
// search implementation - whichever field the admin types in (description,
// SKU, or barcode), the exact same ranking below decides what to suggest.
//
// This is a SUGGESTION list, not a verdict - unlike matchManualItem() above,
// it never returns a status/confidence and never claims a single "the"
// answer; it always returns a plain, ranked array of candidate products for
// the admin to look at and explicitly choose from (or ignore). Selecting a
// suggestion is what makes a match authoritative (see applyProductToRow in
// AdminReportDetailScreen.js) - this function itself never mutates anything.
//
// Ranking tiers, in priority order (mirrors the same priority list
// matchManualItem() uses for a definitive match, adapted for "what should I
// show first" rather than "what should I auto-resolve to"):
//   0. exact barcode
//   1. exact SKU
//   2. normalized SKU (411-001 / 411 001 / 411/001 all collapse together)
//   3. known alias (exact normalized alias text)
//   4. exact normalized product name
//   5. partial SKU/barcode prefix match
//   6. partial SKU/barcode/name substring match
//   7. fuzzy name similarity (Dice coefficient) - only used as a fallback
//      when NOTHING matched at a higher tier, exactly like
//      matchManualItem()'s own fuzzy strategy. A fuzzy suggestion is still
//      just a suggestion here (this function never distinguishes "exact" vs
//      "fuzzy" beyond ranking) - nothing is ever auto-selected by this
//      function; the admin always makes the final choice by tapping one.
//
// Operates on an already-loaded catalog (see loadCatalogForMatching in
// adminReportService.js) - never issues its own query, and never returns the
// full catalog unfiltered (an empty/blank query returns zero results, not
// everything) - `limit` caps how many rows this feeds into any picker/
// dropdown UI, so a broad query never dumps the whole catalog on screen.
export function getProductSuggestions(query, catalog, limit = 6) {
  const trimmed = (query ?? '').trim();
  if (!trimmed) {
    return [];
  }

  const lower = trimmed.toLowerCase();
  const normalizedCodeQuery = normalizeCatalogText(trimmed);
  const normalizedNameQuery = normalizeDescriptionText(trimmed);
  const activeProducts = (catalog?.products ?? []).filter((product) => product.isActive);
  const aliases = catalog?.aliases ?? [];

  const tierFor = (product) => {
    const skuLower = (product.sku || '').toLowerCase();
    const nameLower = (product.name || '').toLowerCase();
    const barcodeLower = (product.barcode || '').toLowerCase();
    const normalizedSku = normalizeCatalogText(product.sku);
    const normalizedName = normalizeDescriptionText(product.name);

    if (barcodeLower && barcodeLower === lower) return 0;
    if (skuLower && skuLower === lower) return 1;
    if (normalizedSku && normalizedCodeQuery && normalizedSku === normalizedCodeQuery) return 2;
    if (
      normalizedCodeQuery &&
      aliases.some((alias) => alias.productId === product.id && alias.normalizedAlias === normalizedCodeQuery)
    ) {
      return 3;
    }
    if (normalizedName && normalizedNameQuery && normalizedName === normalizedNameQuery) return 4;
    if (skuLower.startsWith(lower) || barcodeLower.startsWith(lower)) return 5;
    if (skuLower.includes(lower) || barcodeLower.includes(lower) || nameLower.includes(lower)) return 6;
    return null;
  };

  const ranked = [];
  for (const product of activeProducts) {
    const tier = tierFor(product);
    if (tier !== null) {
      ranked.push({ product, tier, score: 1 });
    }
  }

  // Fuzzy fallback - only when nothing matched any exact/partial tier above,
  // exactly like matchManualItem()'s own fuzzy strategy only running after
  // every stronger strategy found nothing.
  if (ranked.length === 0 && normalizedNameQuery) {
    for (const product of activeProducts) {
      const score = diceCoefficient(normalizedNameQuery, normalizeDescriptionText(product.name));
      if (score >= FUZZY_SUGGEST_THRESHOLD) {
        ranked.push({ product, tier: 7, score });
      }
    }
  }

  ranked.sort((a, b) => a.tier - b.tier || b.score - a.score || (a.product.sku || '').localeCompare(b.product.sku || ''));
  return ranked.slice(0, limit).map((entry) => entry.product);
}