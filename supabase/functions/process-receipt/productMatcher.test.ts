// Dev-only local tests for productMatcher.ts, using Deno's built-in test
// runner (no test framework installed), matching the same approach as
// ocrParser.test.ts. Run locally with:
//
//   deno test supabase/functions/process-receipt/productMatcher.test.ts
//
// All catalog data here is in-memory test fixtures ONLY - nothing in this
// file touches Supabase, and none of this is ever inserted into any real
// table.

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

import {
  diceCoefficient,
  matchOcrLine,
  matchOcrLineFromEvidence,
  normalizeCatalogText,
  normalizeDescriptionText,
  type OcrLineEvidence,
  type ProductCatalog,
} from './productMatcher.ts';

function catalogWith(
  products: ProductCatalog['products'],
  aliases: ProductCatalog['aliases'] = [],
): ProductCatalog {
  return { products, aliases };
}

Deno.test('normalizeCatalogText mirrors the database normalization for SKU formatting variants', () => {
  // Same semantics as public.normalize_catalog_text(): lowercase, trim,
  // strip -_/\\ runs, strip remaining whitespace.
  const variants = ['GL-10452', 'GL 10452', 'GL/10452', 'GL_10452', '  gl10452  '];
  for (const variant of variants) {
    assertEquals(normalizeCatalogText(variant), 'gl10452');
  }
});

// A: exact SKU appearing inside a longer OCR line
Deno.test('matches an exact raw SKU embedded inside a longer OCR line', () => {
  const catalog = catalogWith([{ id: 'p1', sku: 'GL-10452', name: 'ספוט לד', isActive: true }]);

  const result = matchOcrLine({ text: 'GL-10452 ספוט LED 7W 4 יח' }, catalog);

  assertEquals(result.status, 'matched');
  assertEquals(result.productId, 'p1');
  assertEquals(result.method, 'exact_sku');
  assertEquals(result.confidence, 1);
});

// B: formatting variant (space instead of hyphen) -> normalized SKU
Deno.test('matches a formatting-variant SKU via normalized SKU detection', () => {
  const catalog = catalogWith([{ id: 'p1', sku: 'GL-10452', name: 'ספוט לד', isActive: true }]);

  const result = matchOcrLine(
    { text: 'GL 10452 ספוט LED 7W', normalizedText: 'gl 10452 ספוט led 7w' },
    catalog,
  );

  assertEquals(result.status, 'matched');
  assertEquals(result.productId, 'p1');
  assertEquals(result.method, 'normalized_sku');
  assertEquals(result.confidence, 1);
});

// C: Hebrew preserved through an exact normalized product-name match
Deno.test('matches deterministically on an exact normalized Hebrew product name', () => {
  const catalog = catalogWith([{ id: 'p1', sku: 'GL-7000', name: 'ספוט גולדן 7W', isActive: true }]);

  const result = matchOcrLine({ text: 'ספוט גולדן 7W' }, catalog);

  assertEquals(result.status, 'matched');
  assertEquals(result.productId, 'p1');
  assertEquals(result.method, 'name');
  assertEquals(result.matchedText, 'ספוט גולדן 7W');
});

// D: unrelated product -> no match
Deno.test('returns unmatched for a line with no relation to the catalog', () => {
  const catalog = catalogWith([{ id: 'p1', sku: 'GL-10452', name: 'ספוט לד', isActive: true }]);

  const result = matchOcrLine({ text: 'שקית ניילון' }, catalog);

  assertEquals(result.status, 'unmatched');
  assertEquals(result.productId, null);
  assertEquals(result.method, null);
  assertEquals(result.confidence, null);
});

// E: two distinct products both plausibly match the same line -> needs_review
Deno.test('returns needs_review rather than guessing when two distinct SKUs appear in the same line', () => {
  const catalog = catalogWith([
    { id: 'p1', sku: 'GL-100', name: 'מוצר ראשון', isActive: true },
    { id: 'p2', sku: 'GL-200', name: 'מוצר שני', isActive: true },
  ]);

  const result = matchOcrLine({ text: 'GL-100 / GL-200 מארז משולב' }, catalog);

  assertEquals(result.status, 'needs_review');
  assertEquals(result.productId, null);
  assertEquals(result.method, null);
  assertEquals(result.reviewReason, 'ambiguous_exact_sku');
});

Deno.test('returns needs_review when two distinct active products share the same normalized name', () => {
  const catalog = catalogWith([
    { id: 'p1', sku: 'GL-300', name: 'ספוט כללי', isActive: true },
    { id: 'p2', sku: 'GL-400', name: 'ספוט כללי', isActive: true },
  ]);

  const result = matchOcrLine({ text: 'ספוט כללי' }, catalog);

  assertEquals(result.status, 'needs_review');
  assertEquals(result.productId, null);
  assertEquals(result.reviewReason, 'ambiguous_name');
});

// H: an exact SKU match must outrank a coincidental alias/name match for a
// different product - the cascade stops (and returns) at strategy 1 as soon
// as exactly one exact-SKU candidate is found, so strategies 3-4 never even
// run in this case.
Deno.test('an exact SKU match outranks a coincidental name match for a different product', () => {
  const catalog = catalogWith([
    { id: 'p1', sku: 'GL-100', name: 'מוצר ראשי', isActive: true },
    // p2's name happens to equal the exact text of the OCR line below - if
    // priority were not respected, this could wrongly trigger needs_review
    // (or even match the wrong product) via the name strategy.
    { id: 'p2', sku: 'GL-999', name: 'GL-100', isActive: true },
  ]);

  const result = matchOcrLine({ text: 'GL-100', normalizedText: 'gl100' }, catalog);

  assertEquals(result.status, 'matched');
  assertEquals(result.productId, 'p1');
  assertEquals(result.method, 'exact_sku');
  assertEquals(result.reviewReason, null);
});

// F: empty catalog -> unmatched, never a fabricated match
Deno.test('returns unmatched safely against an empty catalog rather than fabricating a match', () => {
  const catalog = catalogWith([]);

  const result = matchOcrLine({ text: 'GL-10452 ספוט LED 7W' }, catalog);

  assertEquals(result.status, 'unmatched');
  assertEquals(result.productId, null);
});

Deno.test('inactive products are never matched', () => {
  const catalog = catalogWith([{ id: 'p1', sku: 'GL-10452', name: 'ספוט לד', isActive: false }]);

  const result = matchOcrLine({ text: 'GL-10452 ספוט LED' }, catalog);

  assertEquals(result.status, 'unmatched');
  assertEquals(result.productId, null);
});

Deno.test('an alias only matches on exact normalized equality, not mere containment', () => {
  const catalog = catalogWith(
    [{ id: 'p1', sku: 'GL-500', name: 'ספוט תעשייתי', isActive: true }],
    [{ productId: 'p1', alias: 'SPOT GL 7W', normalizedAlias: normalizeCatalogText('SPOT GL 7W') }],
  );

  // Exact alias text -> matched.
  const exact = matchOcrLine({ text: 'SPOT GL 7W' }, catalog);
  assertEquals(exact.status, 'matched');
  assertEquals(exact.method, 'alias');

  // Same alias text but with extra surrounding words -> not an exact
  // normalized-line match, and none of the earlier SKU strategies fire
  // either, so this is conservatively unmatched rather than guessed.
  const withExtraWords = matchOcrLine({ text: 'שקית SPOT GL 7W מתנה' }, catalog);
  assertEquals(withExtraWords.status, 'unmatched');
});

// =====================================================================
// OCR Product Matching Stage 3: matchOcrLineFromEvidence() - covers the
// task's own live-observed test cases (A-G). matchOcrLine() itself
// (tested exhaustively above) is completely unchanged; every test below
// exercises ONLY the new evidence-priority orchestration layered on top
// of it.
// =====================================================================

// CASE A: normalized_product_code exact match is the strongest possible
// SKU evidence - the real live row from OCR Stage 2.1 (ProductCode
// "600302 8" -> normalized_product_code "6003028").
Deno.test('STAGE 3 CASE A: normalized_product_code exact match -> matched via normalized_sku_exact', () => {
  const catalog = catalogWith([{ id: 'p1', sku: '6003028', name: 'לוח חשמל תחת הטיח 54 מודול GBOX', isActive: true }]);

  const evidence: OcrLineEvidence = {
    text: 'לוח חשמל תחת הטיח 54 מודול GBOX',
    normalizedProductCode: '6003028',
    productCode: '600302 8',
  };

  const result = matchOcrLineFromEvidence(evidence, catalog);

  assertEquals(result.status, 'matched');
  assertEquals(result.productId, 'p1');
  assertEquals(result.method, 'normalized_sku_exact');
  assertEquals(result.confidence, 1.0);
});

// CASE B: normalized_product_code null, original product_code doesn't
// match any real SKU, no alias/name match either - falls through the
// entire cascade to the SAME existing 'unmatched' outcome matchOcrLine()
// has always produced for "nothing found at any strategy" (the
// established 3-state model's own "unresolved" concept - see the task's
// own section 8: "unmatched/unresolved as currently supported"). Nothing
// is guessed.
Deno.test('STAGE 3 CASE B: no normalized code, no exact SKU match, no alias/name match -> unmatched (existing behavior), never guessed', () => {
  const catalog = catalogWith([{ id: 'p1', sku: 'GL-100', name: 'מוצר אחר לגמרי', isActive: true }]);

  const evidence: OcrLineEvidence = {
    text: 'תיאור כלשהו שלא קיים בקטלוג',
    normalizedProductCode: null,
    productCode: '90294 BK',
  };

  const result = matchOcrLineFromEvidence(evidence, catalog);

  assertEquals(result.status, 'unmatched');
  assertEquals(result.productId, null);
});

// CASE C: normalized SKU and (Stage 2-corroborated) barcode evidence
// agree on the same product - matched, no conflict flag set.
Deno.test('STAGE 3 CASE C: normalized SKU corroborated by agreeing barcode evidence -> matched (no conflict)', () => {
  const catalog = catalogWith([{ id: 'p1', sku: '6003028', name: 'לוח חשמל', isActive: true, barcode: '602697128922' }]);

  // hasConflictingEvidence is false because Stage 2's own crossEvidence
  // computation found agreement, not disagreement - Stage 3 never
  // recomputes the barcode comparison itself, only reads this flag.
  const evidence: OcrLineEvidence = {
    text: 'לוח חשמל',
    normalizedProductCode: '6003028',
    hasConflictingEvidence: false,
  };

  const result = matchOcrLineFromEvidence(evidence, catalog);

  assertEquals(result.status, 'matched');
  assertEquals(result.productId, 'p1');
  assertEquals(result.method, 'normalized_sku_exact');
});

// CASE D: normalized SKU points to product A, barcode uniquely points to
// product B (Stage 2 already detected this and set
// hasConflictingEvidence=true) - needs_review, no authoritative
// product_id, and the conflict is checked BEFORE the normalized_sku_exact
// strategy even runs (so a "confident" SKU match never silently wins over
// a genuine independent contradiction).
Deno.test('STAGE 3 CASE D: conflicting SKU vs. barcode evidence -> needs_review, no product chosen', () => {
  const catalog = catalogWith([{ id: 'p-a', sku: '6003028', name: 'א', isActive: true }]);

  const evidence: OcrLineEvidence = {
    text: 'row',
    normalizedProductCode: '6003028',
    hasConflictingEvidence: true,
  };

  const result = matchOcrLineFromEvidence(evidence, catalog);

  assertEquals(result.status, 'needs_review');
  assertEquals(result.productId, null);
  assertEquals(result.reviewReason, 'conflicting_evidence');
});

// CASE E: only a fuzzy description candidate exists (no SKU/barcode/
// alias/exact-name evidence anywhere) - needs_review, never auto-matched
// regardless of how close the score is.
Deno.test('STAGE 3 CASE E: only a fuzzy description candidate exists -> needs_review, never auto-matched', () => {
  const catalog = catalogWith([{ id: 'p1', sku: 'GL-999', name: 'מפסק יחיד 1 מודול לבן', isActive: true }]);

  const evidence: OcrLineEvidence = {
    text: 'מפסק 1 מודול לבן', // close, but not an exact normalized match
  };

  const result = matchOcrLineFromEvidence(evidence, catalog);

  assertEquals(result.status, 'needs_review');
  assertEquals(result.productId, null);
  assertEquals(result.reviewReason, 'fuzzy_candidate');
});

Deno.test('STAGE 3: a fuzzy score below the suggestion threshold is unmatched, not needs_review', () => {
  const catalog = catalogWith([{ id: 'p1', sku: 'GL-999', name: 'מפסק יחיד 1 מודול לבן', isActive: true }]);
  const evidence: OcrLineEvidence = { text: 'משהו שונה לגמרי בלי שום קשר' };

  const result = matchOcrLineFromEvidence(evidence, catalog);

  assertEquals(result.status, 'unmatched');
});

// CASE G: no usable SKU/barcode/description evidence at all - resolves to
// the existing model's 'unmatched' (unresolved) state, never fabricated.
Deno.test('STAGE 3 CASE G: no usable evidence at all -> unmatched per the existing state model', () => {
  const catalog = catalogWith([{ id: 'p1', sku: 'GL-100', name: 'מוצר', isActive: true }]);
  const evidence: OcrLineEvidence = { text: '' };

  const result = matchOcrLineFromEvidence(evidence, catalog);

  assertEquals(result.status, 'unmatched');
  assertEquals(result.productId, null);
});

Deno.test('matchOcrLineFromEvidence: normalized_product_code ambiguous at the catalog level (rare) -> needs_review, never guessed', () => {
  const catalog = catalogWith([
    { id: 'p1', sku: '6003028', name: 'א', isActive: true },
    { id: 'p2', sku: '600-3028', name: 'ב', isActive: true }, // normalizes identically
  ]);
  const evidence: OcrLineEvidence = { text: 'row', normalizedProductCode: '6003028' };

  const result = matchOcrLineFromEvidence(evidence, catalog);

  assertEquals(result.status, 'needs_review');
  assertEquals(result.reviewReason, 'ambiguous_normalized_sku_exact');
});

Deno.test('matchOcrLineFromEvidence: normalized_product_code that matches no active product falls back to the original-evidence cascade', () => {
  const catalog = catalogWith([{ id: 'p1', sku: 'GL-100', name: 'מוצר', isActive: true }]);
  // normalized_product_code is defensively wrong/stale here (shouldn't
  // happen in practice - Stage 2 only ever sets it when it already
  // validated the match), but productCode still carries a real SKU the
  // fallback cascade CAN find.
  const evidence: OcrLineEvidence = {
    text: 'GL-100 תיאור',
    normalizedProductCode: '9999999',
    productCode: 'GL-100',
  };

  const result = matchOcrLineFromEvidence(evidence, catalog);

  assertEquals(result.status, 'matched');
  assertEquals(result.productId, 'p1');
  assertEquals(result.method, 'exact_sku');
});

Deno.test('matchOcrLineFromEvidence: original product_code is folded into the matchOcrLine() fallback text', () => {
  // product_code and raw_text are separate columns since Stage 1/2 - this
  // confirms the fallback still finds a SKU that only appears in
  // product_code, not in the description text itself.
  const catalog = catalogWith([{ id: 'p1', sku: 'GL-777', name: 'תיאור לא קשור', isActive: true }]);
  const evidence: OcrLineEvidence = { text: 'תיאור כלשהו', productCode: 'GL-777' };

  const result = matchOcrLineFromEvidence(evidence, catalog);

  assertEquals(result.status, 'matched');
  assertEquals(result.method, 'exact_sku');
});

Deno.test('normalizeDescriptionText mirrors productMatching.js exactly: strips punctuation, preserves Hebrew/digits/word boundaries', () => {
  assertEquals(normalizeDescriptionText('מפסק 1M לבן!!'), 'מפסק 1m לבן');
  assertEquals(normalizeDescriptionText('  GL-10452  '), 'gl 10452');
});

Deno.test('diceCoefficient: identical strings score 1, completely different strings score low', () => {
  assertEquals(diceCoefficient('abc', 'abc'), 1);
  assertEquals(diceCoefficient('', 'abc'), 0);
  const score = diceCoefficient('מפסק יחיד לבן', 'תריס חשמלי ירוק');
  assertEquals(score < 0.3, true);
});
