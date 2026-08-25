// Dev-only local tests for ocrNormalization.ts, using Deno's built-in test
// runner, matching the same approach as ocrParser.test.ts/
// productMatcher.test.ts/ocrProvider.test.ts. Run locally with:
//
//   deno test supabase/functions/process-receipt/ocrNormalization.test.ts
//
// Covers exactly the real observed Azure cases (A-F) the OCR Integration
// Stage 2 task spec requires as test cases, plus supporting unit coverage
// for each pure helper. Never touches the network or Supabase - catalogs
// are in-memory fixtures only, never inserted into any real table.

import { assertEquals, assertExists } from 'https://deno.land/std@0.224.0/assert/mod.ts';

import type { ProductCatalog } from './productMatcher.ts';
import {
  detectMergedItem,
  extractBarcodeTokens,
  extractNumericTokens,
  isCloseEnough,
  normalizeOcrLine,
  reconcileQuantity,
  resolveBarcodeEvidence,
  resolveProductCode,
} from './ocrNormalization.ts';

function catalogWith(products: ProductCatalog['products']): ProductCatalog {
  return { products, aliases: [] };
}

// STAGE 2.1 real live invoice row used by several tests below:
// ProductCode "600302 8" (Azure split the real 7-digit SKU "6003028"
// across two adjacent tokens), raw barcode token "0602697128922" (13
// digits, one extra leading zero vs. the catalog's stored 12-digit
// "602697128922"), Quantity=195/UnitPrice=195/Amount=8190 (the same
// "wrong quantity token selected" bug Stage 2 already handles, with the
// real quantity "42" present in the row's raw text as evidence).
const STAGE_2_1_CATALOG = catalogWith([
  {
    id: 'p-gbox-6003028',
    sku: '6003028',
    name: 'לוח חשמל תחת הטיח 54 מודול GBOX',
    isActive: true,
    barcode: '602697128922',
  },
]);
const STAGE_2_1_ROW_RAW_TEXT =
  '600302 8 לוח חשמל תחת הטיח 54 מודול GBOX 195 195 8190 42 0602697128922';

function azureItem(opts: {
  content?: string;
  description?: string;
  productCode?: string;
}): unknown {
  return {
    type: 'object',
    content: opts.content ?? '',
    valueObject: {
      ...(opts.description !== undefined
        ? { Description: { valueString: opts.description, content: opts.description, confidence: 0.9 } }
        : {}),
      ...(opts.productCode !== undefined
        ? { ProductCode: { valueString: opts.productCode, content: opts.productCode, confidence: 0.85 } }
        : {}),
    },
  };
}

// =====================================================================
// CASE A: ProductCode contaminated by an adjacent row/index number.
// =====================================================================
Deno.test('CASE A: "600302 9" resolves to normalized_product_code "600302" (the only real active SKU token)', () => {
  const catalog = catalogWith([{ id: 'p1', sku: '600302', name: 'מוצר גולדן לייט', isActive: true }]);

  const resolution = resolveProductCode('600302 9', catalog);

  assertEquals(resolution.status, 'validated');
  assertEquals(resolution.normalizedProductCode, '600302');
  assertEquals(resolution.candidateTokens, ['600302', '9']);
  assertEquals(resolution.wasMultiToken, true);
});

Deno.test('CASE A variants: "500511 6" and "500631 6" both resolve to their real SKU token', () => {
  const catalog = catalogWith([
    { id: 'p1', sku: '500511', name: 'א', isActive: true },
    { id: 'p2', sku: '500631', name: 'ב', isActive: true },
  ]);

  assertEquals(resolveProductCode('500511 6', catalog).normalizedProductCode, '500511');
  assertEquals(resolveProductCode('500631 6', catalog).normalizedProductCode, '500631');
});

Deno.test('CASE A: a single, already-clean token that matches is validated without being flagged multi-token', () => {
  const catalog = catalogWith([{ id: 'p1', sku: 'GL-10452', name: 'ספוט לד', isActive: true }]);
  const resolution = resolveProductCode('GL-10452', catalog);

  assertEquals(resolution.status, 'validated');
  assertEquals(resolution.normalizedProductCode, 'GL-10452');
  assertEquals(resolution.wasMultiToken, false);
});

Deno.test('resolveProductCode: multiple tokens matching different real products is ambiguous, never a silent pick', () => {
  const catalog = catalogWith([
    { id: 'p1', sku: '600302', name: 'א', isActive: true },
    { id: 'p2', sku: '500511', name: 'ב', isActive: true },
  ]);

  const resolution = resolveProductCode('600302 500511', catalog);

  assertEquals(resolution.status, 'ambiguous');
  assertEquals(resolution.normalizedProductCode, null);
});

Deno.test('resolveProductCode: no token matches any active SKU -> no_catalog_match, not fabricated', () => {
  const catalog = catalogWith([{ id: 'p1', sku: '600302', name: 'א', isActive: true }]);
  const resolution = resolveProductCode('999999 1', catalog);
  assertEquals(resolution.status, 'no_catalog_match');
  assertEquals(resolution.normalizedProductCode, null);
});

Deno.test('resolveProductCode: an inactive product is never matched', () => {
  const catalog = catalogWith([{ id: 'p1', sku: '600302', name: 'א', isActive: false }]);
  const resolution = resolveProductCode('600302 9', catalog);
  assertEquals(resolution.status, 'no_catalog_match');
});

Deno.test('resolveProductCode: null/empty productCode is no_evidence, not an error', () => {
  const catalog = catalogWith([]);
  assertEquals(resolveProductCode(null, catalog).status, 'no_evidence');
  assertEquals(resolveProductCode('   ', catalog).status, 'no_evidence');
});

// =====================================================================
// CASE B / CASE C / CASE F: quantity column confusion + reconciliation.
// =====================================================================
Deno.test('CASE B: SKU 411005 - Quantity=13 is corrected to 20 via Amount/UnitPrice + raw token evidence', () => {
  const result = reconcileQuantity(13, 10.4, 208.01, [13, 20, 10.4, 208.01]);

  assertEquals(result.status, 'corrected_from_raw');
  assertEquals(result.normalizedQuantity, 20);
  assertEquals(result.reason, 'amount_unit_price_consistency');
  assertExists(result.impliedQuantity);
});

Deno.test('CASE C: SKU 411007 - Quantity=10.5 is corrected to 50 via Amount/UnitPrice + raw token evidence', () => {
  const result = reconcileQuantity(10.5, 8.4, 420.01, [10.5, 50, 8.4, 420.01]);

  assertEquals(result.status, 'corrected_from_raw');
  assertEquals(result.normalizedQuantity, 50);
});

Deno.test('CASE F: no numeric combination reconciles - original values preserved, status inconsistent, nothing invented', () => {
  const result = reconcileQuantity(3, 10, 999, [3, 10, 999]);

  assertEquals(result.status, 'inconsistent');
  assertEquals(result.normalizedQuantity, null);
  assertExists(result.impliedQuantity);
});

Deno.test('reconcileQuantity: already-consistent quantity is left untouched (status consistent)', () => {
  const result = reconcileQuantity(4, 10, 40, [4, 10, 40]);
  assertEquals(result.status, 'consistent');
  assertEquals(result.normalizedQuantity, 4);
});

Deno.test('reconcileQuantity: a small rounding difference within tolerance still counts as consistent', () => {
  const result = reconcileQuantity(4, 10, 40.02, [4, 10, 40.02]);
  assertEquals(result.status, 'consistent');
});

Deno.test('reconcileQuantity: missing unitPrice/amount is incomplete, not inconsistent - original quantity passes through', () => {
  const result = reconcileQuantity(4, null, null, []);
  assertEquals(result.status, 'incomplete');
  assertEquals(result.normalizedQuantity, 4);
});

Deno.test('reconcileQuantity: an implied quantity with no matching raw token is inconsistent, never guessed from the division alone', () => {
  // 208.01 / 10.4 = 20.001, but the raw tokens do NOT include anything
  // close to 20 - the math alone must never be enough.
  const result = reconcileQuantity(13, 10.4, 208.01, [13]);
  assertEquals(result.status, 'inconsistent');
  assertEquals(result.normalizedQuantity, null);
});

Deno.test('isCloseEnough respects the given tolerance in both directions', () => {
  assertEquals(isCloseEnough(20, 20.001, 0.05), true);
  assertEquals(isCloseEnough(20, 20.1, 0.05), false);
  assertEquals(isCloseEnough(20, 19.96, 0.05), true);
});

Deno.test('extractNumericTokens finds every positive decimal number in a blob of mixed text', () => {
  assertEquals(extractNumericTokens('שורה 13 20 10.4 208.01 טקסט'), [13, 20, 10.4, 208.01]);
  assertEquals(extractNumericTokens('אין מספרים כאן'), []);
});

// =====================================================================
// CASE D: merged Azure item recovered into separate logical rows.
// =====================================================================
Deno.test('CASE D: two distinct SKUs + two matching description lines recover into two logical rows', () => {
  const catalog = catalogWith([
    { id: 'p1', sku: '411208', name: 'מפסק דו קוטבי מואר 1 מודול לבן', isActive: true },
    { id: 'p2', sku: '414001', name: 'שקע ישראלי 2 מודול לבן', isActive: true },
  ]);

  const rawItem = azureItem({
    productCode: '411208\n414001',
    description: 'מפסק דו קוטבי מואר 1 מודול לבן\nשקע ישראלי 2 מודול לבן',
  });

  const result = detectMergedItem(rawItem, catalog);

  assertEquals(result.detected, true);
  assertExists(result.recoveredRows);
  assertEquals(result.recoveredRows?.length, 2);
  assertEquals(result.recoveredRows?.[0], { productCode: '411208', description: 'מפסק דו קוטבי מואר 1 מודול לבן' });
  assertEquals(result.recoveredRows?.[1], { productCode: '414001', description: 'שקע ישראלי 2 מודול לבן' });
});

Deno.test('CASE D fallback: merge detected but description does not cleanly split -> needs_review, never a guessed pairing', () => {
  const catalog = catalogWith([
    { id: 'p1', sku: '411208', name: 'א', isActive: true },
    { id: 'p2', sku: '414001', name: 'ב', isActive: true },
  ]);

  const rawItem = azureItem({
    productCode: '411208 414001',
    // Only ONE description segment for TWO matched SKUs - insufficient
    // evidence to pair them.
    description: 'מפסק דו קוטבי מואר 1 מודול לבן ושקע ישראלי 2 מודול לבן',
  });

  const result = detectMergedItem(rawItem, catalog);

  assertEquals(result.detected, true);
  assertEquals(result.recoveredRows, null);
  assertEquals(result.reason, 'description_segment_count_mismatch');
});

Deno.test('detectMergedItem: a single real SKU plus noise (CASE A shape) is never treated as a merge', () => {
  const catalog = catalogWith([{ id: 'p1', sku: '600302', name: 'א', isActive: true }]);
  const rawItem = azureItem({ productCode: '600302 9', description: 'מוצר גולדן לייט' });

  const result = detectMergedItem(rawItem, catalog);
  assertEquals(result.detected, false);
});

Deno.test('detectMergedItem: no ProductCode evidence at all is never a merge', () => {
  const catalog = catalogWith([{ id: 'p1', sku: '600302', name: 'א', isActive: true }]);
  const result = detectMergedItem(azureItem({ description: 'תיאור בלבד' }), catalog);
  assertEquals(result.detected, false);
});

// =====================================================================
// CASE E: barcode evidence.
// =====================================================================
Deno.test('CASE E: a 13-digit token matching more than one active product is ambiguous, never authoritative', () => {
  // The real Stage 1 duplicate-barcode case: 753287487971 shared by two
  // distinct GSWITCH products (412525/412575).
  const catalog = catalogWith([
    { id: 'p1', sku: '412525', name: 'א', isActive: true, barcode: '7532874879710' },
    { id: 'p2', sku: '412575', name: 'ב', isActive: true, barcode: '7532874879710' },
  ]);

  const result = resolveBarcodeEvidence('שורת חשבונית עם ברקוד 7532874879710', catalog);
  assertEquals(result.status, 'ambiguous');
  assertEquals(result.matchedProductIds.length, 2);
});

Deno.test('resolveBarcodeEvidence: a barcode matching exactly one product is unique evidence', () => {
  const catalog = catalogWith([{ id: 'p1', sku: '412525', name: 'א', isActive: true, barcode: '1234567890123' }]);
  const result = resolveBarcodeEvidence('טקסט 1234567890123 טקסט', catalog);
  assertEquals(result.status, 'unique');
  assertEquals(result.matchedProductIds, ['p1']);
});

Deno.test('resolveBarcodeEvidence: a 13-digit token matching no product is no_match', () => {
  const catalog = catalogWith([{ id: 'p1', sku: '412525', name: 'א', isActive: true, barcode: '1234567890123' }]);
  const result = resolveBarcodeEvidence('טקסט 9999999999999 טקסט', catalog);
  assertEquals(result.status, 'no_match');
});

Deno.test('resolveBarcodeEvidence: no 13-digit token at all is no_evidence', () => {
  const catalog = catalogWith([{ id: 'p1', sku: '412525', name: 'א', isActive: true, barcode: '1234567890123' }]);
  assertEquals(resolveBarcodeEvidence('אין ברקוד כאן', catalog).status, 'no_evidence');
});

Deno.test('extractBarcodeTokens matches only exactly-13-digit runs', () => {
  assertEquals(extractBarcodeTokens('12345 1234567890123 123456789012345'), ['1234567890123']);
});

// =====================================================================
// normalizeOcrLine: end-to-end per-row status derivation.
// =====================================================================
Deno.test('normalizeOcrLine: a fully clean row (no correction, no ambiguity) is status clean', () => {
  const catalog = catalogWith([{ id: 'p1', sku: 'GL-100', name: 'א', isActive: true }]);
  const result = normalizeOcrLine(
    { productCode: 'GL-100', detectedQuantity: 2, detectedUnitPrice: 5, detectedTotal: 10, rawText: 'GL-100 x2', rawItem: null },
    catalog,
  );
  assertEquals(result.normalizationStatus, 'clean');
  assertEquals(result.normalizedProductCode, 'GL-100');
  assertEquals(result.normalizedQuantity, 2);
});

Deno.test('normalizeOcrLine: CASE A + CASE B combined on one row is status corrected', () => {
  const catalog = catalogWith([{ id: 'p1', sku: '411005', name: 'א', isActive: true }]);
  const result = normalizeOcrLine(
    {
      productCode: '411005 1',
      detectedQuantity: 13,
      detectedUnitPrice: 10.4,
      detectedTotal: 208.01,
      rawText: '411005 1 13 20 10.4 208.01',
      rawItem: null,
    },
    catalog,
  );

  assertEquals(result.normalizationStatus, 'corrected');
  assertEquals(result.normalizedProductCode, '411005');
  assertEquals(result.normalizedQuantity, 20);
});

Deno.test('normalizeOcrLine: an inconsistent quantity forces needs_review', () => {
  const catalog = catalogWith([{ id: 'p1', sku: 'GL-100', name: 'א', isActive: true }]);
  const result = normalizeOcrLine(
    { productCode: 'GL-100', detectedQuantity: 3, detectedUnitPrice: 10, detectedTotal: 999, rawText: 'GL-100', rawItem: null },
    catalog,
  );
  assertEquals(result.normalizationStatus, 'needs_review');
});

Deno.test('normalizeOcrLine: CASE D - a merged item always yields needs_review with null normalized fields on the parent, regardless of split success', () => {
  const catalog = catalogWith([
    { id: 'p1', sku: '411208', name: 'א', isActive: true },
    { id: 'p2', sku: '414001', name: 'ב', isActive: true },
  ]);
  const rawItem = azureItem({
    productCode: '411208\n414001',
    description: 'תיאור אחד\nתיאור שני',
  });

  const result = normalizeOcrLine(
    { productCode: '411208 414001', detectedQuantity: 1, detectedUnitPrice: 5, detectedTotal: 5, rawText: 'row', rawItem },
    catalog,
  );

  assertEquals(result.normalizationStatus, 'needs_review');
  assertEquals(result.normalizedProductCode, null);
  assertEquals(result.normalizedQuantity, null);
  assertExists(result.recoveredRows);
  assertEquals(result.recoveredRows?.length, 2);
});

Deno.test('normalizeOcrLine: an empty catalog never fabricates a match - every row resolves to no_catalog_match/needs_review', () => {
  const catalog = catalogWith([]);
  const result = normalizeOcrLine(
    { productCode: '600302 9', detectedQuantity: 1, detectedUnitPrice: 1, detectedTotal: 1, rawText: 'row', rawItem: null },
    catalog,
  );
  assertEquals(result.normalizationStatus, 'needs_review');
  assertEquals(result.normalizedProductCode, null);
});

// =====================================================================
// STAGE 2.1: joined-token ProductCode candidates, barcode leading-zero
// normalization, and SKU/barcode cross-evidence. Real live case: Azure
// split the real 7-digit SKU "6003028" (barcode 602697128922) into
// ProductCode tokens "600302"/"8", and the raw barcode OCR token had one
// extra leading zero ("0602697128922").
// =====================================================================

// CASE A (2.1): "600302 8" resolves via the JOINED candidate "6003028",
// since neither individual token is itself a real active SKU.
Deno.test('STAGE 2.1 CASE A: "600302 8" resolves to normalized_product_code "6003028" via the joined candidate', () => {
  const resolution = resolveProductCode('600302 8', STAGE_2_1_CATALOG);

  assertEquals(resolution.status, 'validated');
  assertEquals(resolution.normalizedProductCode, '6003028');
  assertEquals(resolution.candidateTokens, ['600302', '8']);
  assertEquals(resolution.joinedCandidates, ['6003028']);
  assertEquals(resolution.matchedFrom, '6003028');
  assertEquals(resolution.wasMultiToken, true);
});

Deno.test('resolveProductCode: neither individual token alone matches for the joined-candidate case (sanity check)', () => {
  // Confirms the match genuinely comes from the JOIN, not a coincidental
  // single-token match - "600302" (6 digits) and "8" are each checked
  // independently and neither equals the real 7-digit SKU "6003028".
  assertEquals(resolveProductCode('600302', STAGE_2_1_CATALOG).status, 'no_catalog_match');
  assertEquals(resolveProductCode('8', STAGE_2_1_CATALOG).status, 'no_catalog_match');
});

Deno.test('resolveProductCode: a 3-token ProductCode still finds a joined match across any contiguous window', () => {
  const catalog = catalogWith([{ id: 'p1', sku: 'AB123', name: 'x', isActive: true }]);
  // "AB" + "123" joined = "AB123"; "9" is noise before it.
  const resolution = resolveProductCode('9 AB 123', catalog);
  assertEquals(resolution.status, 'validated');
  assertEquals(resolution.normalizedProductCode, 'AB123');
});

// CASE B (2.1): leading-zero barcode normalization.
Deno.test('STAGE 2.1 CASE B: a 13-digit raw barcode token with an extra leading zero matches the catalog\'s 12-digit barcode', () => {
  const result = resolveBarcodeEvidence('שורה עם ברקוד 0602697128922 בטקסט', STAGE_2_1_CATALOG);

  assertEquals(result.status, 'unique');
  assertEquals(result.token, '0602697128922');
  assertEquals(result.normalizedToken, '602697128922');
  assertEquals(result.matchedProductIds, ['p-gbox-6003028']);
});

Deno.test('resolveBarcodeEvidence: a catalog barcode already stored WITH a leading zero still matches a same-leading-zero raw token', () => {
  // Confirms buildBarcodeIndex() normalizes the CATALOG side too (not
  // just the extracted token) - both sides go through the same
  // normalizeBarcodeToken(), so a catalog value that happens to already
  // carry a leading zero is indexed under its stripped form exactly like
  // any other, and a 13-digit raw token with the same digits still
  // resolves correctly regardless of which side "had" the zero.
  const catalog = catalogWith([{ id: 'p1', sku: 'X', name: 'x', isActive: true, barcode: '0123456789012' }]);
  const result = resolveBarcodeEvidence('טקסט 0123456789012 טקסט', catalog);
  assertEquals(result.status, 'unique');
  assertEquals(result.matchedProductIds, ['p1']);
});

// CASE C (2.1): SKU + barcode evidence agree -> corroboration recorded,
// and normalization_status is no longer needs_review solely because of
// ProductCode (the joined-candidate fix already resolves it on its own -
// this confirms the fix holds end-to-end through normalizeOcrLine, with
// agreeing barcode evidence alongside it).
Deno.test('STAGE 2.1 CASE C: SKU and barcode evidence agree on the same product - corroborated, not needs_review', () => {
  const result = normalizeOcrLine(
    {
      productCode: '600302 8',
      detectedQuantity: 195,
      detectedUnitPrice: 195,
      detectedTotal: 8190,
      rawText: STAGE_2_1_ROW_RAW_TEXT,
      rawItem: null,
    },
    STAGE_2_1_CATALOG,
  );

  assertEquals(result.normalizedProductCode, '6003028');
  assertEquals(result.normalizationStatus, 'corrected');
  const crossEvidence = (result.normalizationNotes as Record<string, unknown>).crossEvidence as Record<string, unknown>;
  assertEquals(crossEvidence.agrees, true);
  assertEquals(crossEvidence.conflict, false);
  assertEquals(crossEvidence.productId, 'p-gbox-6003028');
});

// CASE D (2.1): SKU evidence and barcode evidence point at two DIFFERENT
// products - never chosen silently, forced to needs_review.
Deno.test('STAGE 2.1 CASE D: conflicting unique SKU vs. unique barcode evidence forces needs_review, normalized_product_code cleared', () => {
  const catalog = catalogWith([
    { id: 'p-sku-match', sku: '6003028', name: 'א', isActive: true, barcode: '999999999999' },
    { id: 'p-barcode-match', sku: 'ZZZ999', name: 'ב', isActive: true, barcode: '602697128922' },
  ]);

  const result = normalizeOcrLine(
    {
      productCode: '600302 8',
      detectedQuantity: 195,
      detectedUnitPrice: 195,
      detectedTotal: 8190,
      rawText: STAGE_2_1_ROW_RAW_TEXT,
      rawItem: null,
    },
    catalog,
  );

  assertEquals(result.normalizationStatus, 'needs_review');
  assertEquals(result.normalizedProductCode, null);
  const crossEvidence = (result.normalizationNotes as Record<string, unknown>).crossEvidence as Record<string, unknown>;
  assertEquals(crossEvidence.conflict, true);
  assertEquals(crossEvidence.agrees, false);
});

// CASE E (2.1): joined candidate found, but it matches no real catalog
// SKU at all.
Deno.test('STAGE 2.1 CASE E: a joined candidate that matches no active SKU is no_catalog_match, nothing invented', () => {
  const catalog = catalogWith([{ id: 'p1', sku: '9999999', name: 'unrelated', isActive: true }]);
  const resolution = resolveProductCode('600302 8', catalog);
  assertEquals(resolution.status, 'no_catalog_match');
  assertEquals(resolution.normalizedProductCode, null);
});

// CASE F (2.1): the joined candidate (or any candidate) matches more than
// one distinct active product - ambiguous, never guessed. Two distinct
// SKUs (unique as real database rows always are) that happen to
// NORMALIZE identically ("6003028" and "600-3028" both normalize to
// "6003028" via normalizeCatalogText's separator-stripping) is exactly
// the catalog-level collision resolveProductCode() must still catch as
// ambiguous, even when the match came from a joined candidate rather than
// a single token.
Deno.test('STAGE 2.1 CASE F: a joined candidate matching more than one distinct active product (via a normalization collision) is ambiguous', () => {
  const collidingCatalog = catalogWith([
    { id: 'p1', sku: '6003028', name: 'א', isActive: true },
    { id: 'p2', sku: '600-3028', name: 'ב', isActive: true },
  ]);
  const resolution = resolveProductCode('600302 8', collidingCatalog);
  assertEquals(resolution.status, 'ambiguous');
  assertEquals(resolution.normalizedProductCode, null);
});

Deno.test('STAGE 2.1 CASE F variant: a joined candidate matching two genuinely different real SKUs is ambiguous', () => {
  // "600302"+"8" = "6003028" and, independently, "6003" + "028" = "6003028"
  // is not distinguishable here, so instead: two tokens whose OWN
  // individual values are each real distinct SKUs - ambiguity must be
  // caught across the whole candidate pool (tokens + joins together), not
  // per-candidate-type.
  const catalog = catalogWith([
    { id: 'p1', sku: '600302', name: 'א', isActive: true },
    { id: 'p2', sku: '8', name: 'ב', isActive: true },
  ]);
  const resolution = resolveProductCode('600302 8', catalog);
  assertEquals(resolution.status, 'ambiguous');
  assertEquals(resolution.normalizedProductCode, null);
});

// CASE G (2.1): quantity correction is unchanged - still 195 -> 42 for
// this exact real row, regardless of the ProductCode/barcode fixes above.
Deno.test('STAGE 2.1 CASE G: quantity correction remains 195 -> 42 for the real row (unchanged logic)', () => {
  const result = reconcileQuantity(195, 195, 8190, extractNumericTokens(STAGE_2_1_ROW_RAW_TEXT));
  assertEquals(result.status, 'corrected_from_raw');
  assertEquals(result.normalizedQuantity, 42);
});

Deno.test('STAGE 2.1 CASE G (end-to-end): the full real row normalizes with normalized_quantity 42 and normalized_product_code "6003028"', () => {
  const result = normalizeOcrLine(
    {
      productCode: '600302 8',
      detectedQuantity: 195,
      detectedUnitPrice: 195,
      detectedTotal: 8190,
      rawText: STAGE_2_1_ROW_RAW_TEXT,
      rawItem: null,
    },
    STAGE_2_1_CATALOG,
  );

  assertEquals(result.normalizedQuantity, 42);
  assertEquals(result.normalizedProductCode, '6003028');
  assertEquals(result.normalizationStatus, 'corrected');
});