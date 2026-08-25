// Dev-only local tests for productMatchPersistence.ts's PURE helpers
// (wasMergedParent/hasConflictingEvidence), using Deno's built-in test
// runner, matching the same approach as every other *.test.ts file in this
// directory. Run locally with:
//
//   deno test supabase/functions/process-receipt/productMatchPersistence.test.ts
//
// matchAndPersistOcrLines() itself (the DB-touching orchestration) is NOT
// unit-tested here - it requires a live Supabase service-role client, the
// same reason ocrPersistence.ts's/ocrNormalization.ts's own DB-touching
// functions were never unit-tested directly either (see those modules'
// own test files, which cover only their pure logic). What IS fully
// covered here is the exact exclusion/conflict logic that decides which
// rows matchAndPersistOcrLines() feeds into matching - the part most
// important to get right, since a mistake there would either silently
// double-match a split parent+child or silently drop a real line.

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { matchOcrLineFromEvidence, type OcrLineEvidence, type ProductCatalog } from './productMatcher.ts';
import { hasConflictingEvidence, type OcrLineRow, wasMergedParent } from './productMatchPersistence.ts';

function row(overrides: Partial<OcrLineRow> = {}): OcrLineRow {
  return {
    id: 'line-1',
    raw_text: 'row',
    normalized_text: 'row',
    product_code: null,
    normalized_product_code: null,
    normalization_notes: null,
    ...overrides,
  };
}

Deno.test('wasMergedParent: false when normalization_notes is null (line never normalized, or a recovered child with no merge key)', () => {
  assertEquals(wasMergedParent(row({ normalization_notes: null })), false);
  assertEquals(wasMergedParent(row({ normalization_notes: { recoveredFromOcrLineId: 'x', parentLineIndex: 0 } })), false);
});

Deno.test('wasMergedParent: false for a normal (non-merged) row', () => {
  assertEquals(wasMergedParent(row({ normalization_notes: { merge: { detected: false } } })), false);
});

// CASE F (part 1): a merge-detected parent - whether or not the split
// itself succeeded - must never be matched.
Deno.test('STAGE 3 CASE F: wasMergedParent is true whenever merge.detected is true, split-succeeded or not', () => {
  assertEquals(
    wasMergedParent(row({ normalization_notes: { merge: { detected: true, recoveredRows: [{}, {}] } } })),
    true,
  );
  assertEquals(
    wasMergedParent(row({ normalization_notes: { merge: { detected: true, recoveredRows: null } } })),
    true,
  );
});

Deno.test('hasConflictingEvidence: false when normalization_notes/crossEvidence is absent', () => {
  assertEquals(hasConflictingEvidence(row({ normalization_notes: null })), false);
  assertEquals(hasConflictingEvidence(row({ normalization_notes: { productCode: {} } })), false);
});

Deno.test('hasConflictingEvidence: true only when crossEvidence.conflict is exactly true', () => {
  assertEquals(hasConflictingEvidence(row({ normalization_notes: { crossEvidence: { conflict: true } } })), true);
  assertEquals(hasConflictingEvidence(row({ normalization_notes: { crossEvidence: { conflict: false, agrees: true } } })), false);
});

// CASE F (part 2): a recovered CHILD row (is_recovered_row=true in the
// database, reflected here simply as "no merge key in its own notes,
// plus its own normalized_product_code already set by Stage 2") is
// matched independently, exactly like any other line - proving the child
// side of "match each child independently, do not match the parent".
Deno.test('STAGE 3 CASE F: a recovered child row (real SKU, no merge key of its own) is matched independently', () => {
  const catalog: ProductCatalog = {
    products: [
      { id: 'p-411208', sku: '411208', name: 'מפסק דו קוטבי מואר 1 מודול לבן', isActive: true },
      { id: 'p-414001', sku: '414001', name: 'שקע ישראלי 2 מודול לבן', isActive: true },
    ],
    aliases: [],
  };

  const child1 = row({
    id: 'child-1',
    raw_text: 'מפסק דו קוטבי מואר 1 מודול לבן',
    product_code: '411208',
    normalized_product_code: '411208',
    normalization_notes: { recoveredFromOcrLineId: 'parent-1', parentLineIndex: 3 },
  });
  const child2 = row({
    id: 'child-2',
    raw_text: 'שקע ישראלי 2 מודול לבן',
    product_code: '414001',
    normalized_product_code: '414001',
    normalization_notes: { recoveredFromOcrLineId: 'parent-1', parentLineIndex: 3 },
  });
  const parent = row({
    id: 'parent-1',
    raw_text: 'מפסק דו קוטבי מואר 1 מודול לבן שקע ישראלי 2 מודול לבן',
    product_code: '411208 414001',
    normalized_product_code: null,
    normalization_notes: {
      merge: { detected: true, recoveredRows: [{ productCode: '411208' }, { productCode: '414001' }] },
    },
  });

  // The parent is excluded before matching is ever attempted on it.
  assertEquals(wasMergedParent(parent), true);

  // Each child is matched independently, to its OWN distinct product.
  const evidenceFor = (r: OcrLineRow): OcrLineEvidence => ({
    text: r.raw_text ?? '',
    normalizedText: r.normalized_text,
    productCode: r.product_code,
    normalizedProductCode: r.normalized_product_code,
    hasConflictingEvidence: hasConflictingEvidence(r),
  });

  const result1 = matchOcrLineFromEvidence(evidenceFor(child1), catalog);
  const result2 = matchOcrLineFromEvidence(evidenceFor(child2), catalog);

  assertEquals(result1.status, 'matched');
  assertEquals(result1.productId, 'p-411208');
  assertEquals(result2.status, 'matched');
  assertEquals(result2.productId, 'p-414001');
  // Never the same product for both children.
  assertEquals(result1.productId === result2.productId, false);
});