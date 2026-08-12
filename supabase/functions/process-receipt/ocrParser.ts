// Reusable, provider-agnostic OCR line parsing/validation.
//
// A real provider adapter (see ocrProvider.ts) is responsible for
// translating whatever shape a vendor API returns into the
// NormalizedOcrResult contract defined here. This module never talks to
// Azure (or any vendor) directly, and never fabricates text or numbers -
// it only cleans up and validates whatever it is given.

// --- Provider-facing contract ---------------------------------------------
// Every OCR provider adapter must resolve to this shape on success. This is
// intentionally generic (no Azure-specific fields) so a different provider
// could be swapped in later without touching this module.

export interface NormalizedOcrLine {
  text: string;
  quantity?: number | null;
  unitPrice?: number | null;
  total?: number | null;
}

export interface NormalizedOcrResult {
  rawText: string;
  lines: NormalizedOcrLine[];
}

// --- Internal, DB-ready shape ----------------------------------------------
// Produced by parseOcrResult() below: cleaned text, validated numbers, and
// a deterministic, gap-free line_index - ready to hand to
// ocrPersistence.ts for writing into receipt_ocr_lines.

export interface ParsedOcrLine {
  lineIndex: number;
  rawText: string;
  detectedQuantity: number | null;
  detectedUnitPrice: number | null;
  detectedTotal: number | null;
}

export interface ParsedOcrResult {
  rawText: string;
  lines: ParsedOcrLine[];
}

// --- Line text cleanup -------------------------------------------------------
// Trims edges and collapses repeated internal whitespace only. Deliberately
// does NOT lowercase, strip separators/punctuation, or otherwise mangle the
// text - Hebrew, English, digits, and punctuation are all preserved as-is.
// This is intentionally lighter-touch than public.normalize_catalog_text()
// (used for product/alias matching) and does not duplicate what the
// database's normalize_receipt_line()/receipt_ocr_lines_set_normalized_text
// trigger already computes for normalized_text - this function only cleans
// raw_text before it's persisted.
function cleanLineText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

// --- Safe numeric normalization ----------------------------------------------
// Accepts a value exactly as provided by an OCR provider (which may be
// missing, NaN, Infinity, a string, or a sensible number) and returns it
// only if it is a finite, non-negative number. Anything else becomes null -
// this never guesses or extracts a number from surrounding text.
export function normalizeNonNegativeNumber(value: unknown): number | null {
  if (typeof value !== 'number') {
    return null;
  }

  if (!Number.isFinite(value)) {
    // Rejects both NaN and +/-Infinity.
    return null;
  }

  if (value < 0) {
    return null;
  }

  return value;
}

// --- Main parse/validate entry point -----------------------------------------
// Converts a provider's NormalizedOcrResult into the DB-ready
// ParsedOcrResult: empty/whitespace-only lines are dropped entirely (not
// indexed), remaining lines are cleaned, their numeric fields are validated,
// and line_index is assigned sequentially starting at 0 with no gaps -
// provider-supplied indexes (if any) are never trusted or preserved.
export function parseOcrResult(input: NormalizedOcrResult): ParsedOcrResult {
  const rawText = typeof input?.rawText === 'string' ? input.rawText.trim() : '';
  const sourceLines = Array.isArray(input?.lines) ? input.lines : [];

  const lines: ParsedOcrLine[] = [];
  let nextIndex = 0;

  for (const sourceLine of sourceLines) {
    const cleanedText = cleanLineText(String(sourceLine?.text ?? ''));

    if (!cleanedText) {
      continue;
    }

    lines.push({
      lineIndex: nextIndex,
      rawText: cleanedText,
      detectedQuantity: normalizeNonNegativeNumber(sourceLine?.quantity),
      detectedUnitPrice: normalizeNonNegativeNumber(sourceLine?.unitPrice),
      detectedTotal: normalizeNonNegativeNumber(sourceLine?.total),
    });

    nextIndex += 1;
  }

  return { rawText, lines };
}

// --- Empty-result guard -------------------------------------------------------
// A provider can technically "succeed" (no network/auth error) while still
// returning nothing useful. Treat that as a processing failure rather than
// a completed OCR result with meaningless empty data - see index.ts, which
// routes this into the same needs_review failure path as a real provider
// error, using the safe internal category "empty_ocr_result".
export function isEmptyOcrResult(result: ParsedOcrResult): boolean {
  return !result.rawText.trim() || result.lines.length === 0;
}
