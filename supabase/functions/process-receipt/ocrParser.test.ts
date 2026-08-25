// Dev-only local tests for ocrParser.ts, using Deno's built-in test runner
// (no test framework installed - `Deno.test` ships with the Deno runtime
// itself). Run locally with:
//
//   deno test supabase/functions/process-receipt/ocrParser.test.ts
//
// These never touch the database, Storage, or any network call, and never
// require Supabase or Azure credentials - they only exercise the pure
// parsing/validation functions in ocrParser.ts.

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { isEmptyOcrResult, normalizeConfidence, normalizeNonNegativeNumber, parseOcrResult } from './ocrParser.ts';

// A: "  מוצר   לד   7W  " -> "מוצר לד 7W"
Deno.test('trims edges and collapses repeated internal whitespace while preserving Hebrew, English, and digits', () => {
  const result = parseOcrResult({
    rawText: 'receipt',
    lines: [{ text: '  מוצר   לד   7W  ' }],
  });

  assertEquals(result.lines.length, 1);
  assertEquals(result.lines[0].rawText, 'מוצר לד 7W');
  assertEquals(result.lines[0].lineIndex, 0);
});

// B: empty/whitespace-only line -> removed, with no gap left in line_index
Deno.test('drops empty and whitespace-only lines without leaving index gaps', () => {
  const result = parseOcrResult({
    rawText: 'receipt',
    lines: [{ text: 'שורה ראשונה' }, { text: '   ' }, { text: '' }, { text: 'שורה שנייה' }],
  });

  assertEquals(result.lines.length, 2);
  assertEquals(result.lines[0].lineIndex, 0);
  assertEquals(result.lines[0].rawText, 'שורה ראשונה');
  assertEquals(result.lines[1].lineIndex, 1);
  assertEquals(result.lines[1].rawText, 'שורה שנייה');
});

// C: "ספוט GOLDEN 7W" -> preserved (already clean, no separators stripped)
Deno.test('preserves mixed Hebrew and English text unchanged when already clean', () => {
  const result = parseOcrResult({
    rawText: 'receipt',
    lines: [{ text: 'ספוט GOLDEN 7W' }],
  });

  assertEquals(result.lines[0].rawText, 'ספוט GOLDEN 7W');
});

// D: quantity 2 -> 2
Deno.test('preserves a valid non-negative quantity', () => {
  assertEquals(normalizeNonNegativeNumber(2), 2);
  assertEquals(normalizeNonNegativeNumber(1.5), 1.5);
});

// E: invalid number (NaN) -> null
Deno.test('rejects NaN as null rather than guessing', () => {
  assertEquals(normalizeNonNegativeNumber(Number.NaN), null);
});

// F: negative total (-10) -> null
Deno.test('rejects a negative total as null rather than storing a nonsensical value', () => {
  assertEquals(normalizeNonNegativeNumber(-10), null);
});

Deno.test('rejects Infinity as null', () => {
  assertEquals(normalizeNonNegativeNumber(Number.POSITIVE_INFINITY), null);
  assertEquals(normalizeNonNegativeNumber(Number.NEGATIVE_INFINITY), null);
});

Deno.test('rejects non-numeric values (missing/string) as null without guessing', () => {
  assertEquals(normalizeNonNegativeNumber(undefined), null);
  assertEquals(normalizeNonNegativeNumber('2'), null);
});

Deno.test('an OCR result with no raw text and no lines is treated as empty', () => {
  const result = parseOcrResult({ rawText: '', lines: [] });
  assertEquals(isEmptyOcrResult(result), true);
});

Deno.test('an OCR result with real raw text and at least one line is not empty', () => {
  const result = parseOcrResult({ rawText: 'receipt text', lines: [{ text: 'פריט אחד' }] });
  assertEquals(isEmptyOcrResult(result), false);
});

// --- Stage 1: Azure structured extras (productCode/confidence/rawItem) -----

// CASE A: "600302 9" (a real observed Azure ProductCode value - a stray
// adjacent row number glued onto the actual SKU) must survive
// parseOcrResult() unchanged - only whitespace-collapse/trim is applied,
// exactly like rawText, never a split/clean.
Deno.test('CASE A: preserves productCode exactly as provided, including an embedded stray token', () => {
  const result = parseOcrResult({
    rawText: 'receipt',
    lines: [{ text: 'ספוט לד', productCode: '  600302   9  ' }],
  });

  // Same cleanLineText() treatment as rawText: trim + collapse repeated
  // whitespace only - the single space between "600302" and "9" is
  // original structure, not collapsed away or split.
  assertEquals(result.lines[0].productCode, '600302 9');
});

Deno.test('a missing/non-string productCode becomes null, never an empty string', () => {
  const result = parseOcrResult({ rawText: 'receipt', lines: [{ text: 'line with no product code' }] });
  assertEquals(result.lines[0].productCode, null);
});

// CASE C: a low confidence value is preserved as-is (never dropped,
// upgraded, or used to filter/hide the row).
Deno.test('CASE C: preserves a low confidence value exactly, never treating it as authoritative or filtering it out', () => {
  const result = parseOcrResult({
    rawText: 'receipt',
    lines: [{ text: 'unclear row', productCode: 'GX12', productCodeConfidence: 0.12, quantityConfidence: 0.08 }],
  });

  assertEquals(result.lines[0].productCodeConfidence, 0.12);
  assertEquals(result.lines[0].quantityConfidence, 0.08);
  // The row itself is still present - low confidence never removes a line.
  assertEquals(result.lines.length, 1);
});

Deno.test('normalizeConfidence accepts any value in [0, 1]', () => {
  assertEquals(normalizeConfidence(0), 0);
  assertEquals(normalizeConfidence(0.5), 0.5);
  assertEquals(normalizeConfidence(1), 1);
});

Deno.test('normalizeConfidence rejects a value outside [0, 1] as null rather than clamping it', () => {
  assertEquals(normalizeConfidence(1.5), null);
  assertEquals(normalizeConfidence(-0.1), null);
});

Deno.test('normalizeConfidence rejects NaN/Infinity/non-numeric values as null', () => {
  assertEquals(normalizeConfidence(Number.NaN), null);
  assertEquals(normalizeConfidence(Number.POSITIVE_INFINITY), null);
  assertEquals(normalizeConfidence('0.9'), null);
  assertEquals(normalizeConfidence(undefined), null);
});

Deno.test('rawItem is passed through verbatim without being parsed or modified', () => {
  const rawItem = { content: 'raw azure item', confidence: 0.77, boundingRegions: [{ pageNumber: 1 }] };
  const result = parseOcrResult({ rawText: 'receipt', lines: [{ text: 'line', rawItem }] });
  assertEquals(result.lines[0].rawItem, rawItem);
});
