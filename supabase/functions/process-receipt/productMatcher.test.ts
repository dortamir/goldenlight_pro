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

import { matchOcrLine, normalizeCatalogText, type ProductCatalog } from './productMatcher.ts';

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
