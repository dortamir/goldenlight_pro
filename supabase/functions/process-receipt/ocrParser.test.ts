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

import { isEmptyOcrResult, normalizeNonNegativeNumber, parseOcrResult } from './ocrParser.ts';

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
