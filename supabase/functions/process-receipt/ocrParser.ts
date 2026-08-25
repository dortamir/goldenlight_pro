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
  // --- Structured extras (Azure Document Intelligence prebuilt-invoice) --
  // All optional - a provider without these concepts simply omits them.
  // NEVER cleaned/interpreted by a provider adapter or by this module:
  // productCode is preserved exactly as the provider returned it (e.g. a
  // stray adjacent row number like "600302 9" is NOT stripped at this
  // stage - see the OCR Integration Stage 1 spec's own example). Product
  // matching, a later stage, is responsible for reconciling this against
  // the real catalog, not persistence.
  productCode?: string | null;
  // Per-field confidence in [0, 1], or null/omitted when the provider
  // doesn't report one. Never treated as authoritative here - only
  // persisted so a low-confidence value can be surfaced later.
  descriptionConfidence?: number | null;
  productCodeConfidence?: number | null;
  quantityConfidence?: number | null;
  unitPriceConfidence?: number | null;
  amountConfidence?: number | null;
  // The complete provider-specific raw object for this one row/item
  // (values, content/source text, confidence, bounding regions/spans -
  // whatever the provider returned), preserved verbatim for later
  // debugging/recovery. Never parsed or relied upon by this module - pure
  // pass-through into receipt_ocr_lines.raw_item.
  rawItem?: unknown;
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
  productCode: string | null;
  descriptionConfidence: number | null;
  productCodeConfidence: number | null;
  quantityConfidence: number | null;
  unitPriceConfidence: number | null;
  amountConfidence: number | null;
  rawItem: unknown | null;
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

// --- Safe confidence normalization -------------------------------------------
// A provider's per-field confidence must be a finite number in [0, 1] to be
// persisted - anything else (missing, NaN, Infinity, a string, or a value
// outside that range) becomes null. Mirrors normalizeNonNegativeNumber()'s
// "never guess" posture: a confidence outside the valid range is discarded,
// never clamped into range (clamping would misrepresent what the provider
// actually reported).
export function normalizeConfidence(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  if (value < 0 || value > 1) {
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

    // productCode is cleaned exactly like rawText (trim + collapse repeated
    // whitespace only) - never split, never stripped of trailing/adjacent
    // tokens. "600302 9" stays "600302 9": the single internal space is
    // original structure, not incidental whitespace to collapse away.
    const cleanedProductCode =
      typeof sourceLine?.productCode === 'string' ? cleanLineText(sourceLine.productCode) || null : null;

    lines.push({
      lineIndex: nextIndex,
      rawText: cleanedText,
      detectedQuantity: normalizeNonNegativeNumber(sourceLine?.quantity),
      detectedUnitPrice: normalizeNonNegativeNumber(sourceLine?.unitPrice),
      detectedTotal: normalizeNonNegativeNumber(sourceLine?.total),
      productCode: cleanedProductCode,
      descriptionConfidence: normalizeConfidence(sourceLine?.descriptionConfidence),
      productCodeConfidence: normalizeConfidence(sourceLine?.productCodeConfidence),
      quantityConfidence: normalizeConfidence(sourceLine?.quantityConfidence),
      unitPriceConfidence: normalizeConfidence(sourceLine?.unitPriceConfidence),
      amountConfidence: normalizeConfidence(sourceLine?.amountConfidence),
      rawItem: sourceLine?.rawItem ?? null,
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
