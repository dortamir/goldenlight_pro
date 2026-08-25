// OCR Integration Stage 2: Golden Light invoice normalization + row
// recovery.
//
// Turns Stage 1's imperfect Azure structured Items into cleaner, more
// trustworthy OCR evidence - WITHOUT ever overwriting the original Azure
// fields (product_code, detected_quantity/unit_price/total, raw_item, all
// persisted by Stage 1's ocrPersistence.ts) and WITHOUT running product
// matching. Nothing in this module sets product_id, match_status,
// receipt_line_matches, receipt_manual_items, or is_golden_light, and
// nothing here calls matchOcrLine()/persistLineMatches()
// (productMatcher.ts/productMatchPersistence.ts) - only their catalog
// TYPES and the neutral, read-only loadActiveProductCatalog()/
// normalizeCatalogText() are reused, for exactly the validation uses the
// Stage 2 task spec allows: confirming a SKU/barcode-like token is real,
// and detecting merged-row boundaries. Full description/alias/fuzzy
// matching remains a separate, later stage.
//
// Pure functions (tokenizing, tolerance checks, resolveProductCode,
// reconcileQuantity, resolveBarcodeEvidence, detectMergedItem,
// normalizeOcrLine) have no Supabase/Deno dependency and are trivially
// unit-testable in isolation (see ocrNormalization.test.ts). Only
// normalizeAndPersistOcrLines() at the bottom touches the database, using
// an already-authorized service-role client passed in by index.ts - this
// module performs no auth/ownership checks of its own, same convention as
// ocrPersistence.ts/productMatchPersistence.ts.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

import { type CatalogProduct, normalizeCatalogText, type ProductCatalog } from './productMatcher.ts';
import { loadActiveProductCatalog } from './productMatchPersistence.ts';

// --- Tolerances ----------------------------------------------------------------
// Both absolute, in the same units as the values being compared (currency
// for AMOUNT_TOLERANCE, "count" for QUANTITY_MATCH_TOLERANCE - quantities
// can be fractional, e.g. 10.5, so this is not restricted to integers).
// Deliberately small and deliberately named constants rather than inline
// magic numbers, so a future tuning pass has one obvious place to look.
export const AMOUNT_TOLERANCE = 0.05;
export const QUANTITY_MATCH_TOLERANCE = 0.05;

export function isCloseEnough(a: number, b: number, tolerance: number): boolean {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
}

// --- Tokenizing ------------------------------------------------------------------
// Splits on any run of whitespace/newlines - deliberately simple and
// layout-agnostic (see the task's own warning against brittle
// pixel/coordinate rules): "600302 9" -> ["600302", "9"]; a ProductCode
// field that Azure merged across two rows via a literal newline
// ("411208\n414001") splits the same way.
function tokenizeCodeText(text: string): string[] {
  return text
    .split(/[\s\r\n]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

// All positive-decimal numeric substrings in a blob of text, as numbers -
// e.g. "13 20 10.4 208.01" -> [13, 20, 10.4, 208.01]. Never deduped
// (repeats are harmless for the "does any token match X" checks this
// feeds) and never filtered by magnitude - a 13-digit barcode number
// showing up here is harmless: it will never happen to be "close enough"
// (see isCloseEnough) to a realistic implied quantity.
export function extractNumericTokens(text: string): number[] {
  const matches = text.match(/\d+(?:\.\d+)?/g) ?? [];
  return matches.map((token) => Number.parseFloat(token)).filter((value) => Number.isFinite(value) && value > 0);
}

// Exactly-13-digit tokens - the shape of a real product barcode in this
// catalog (see 018_product_catalog_foundation.sql's own real source-data
// notes). Kept as strings (never parsed to number) so a leading zero is
// never silently dropped.
export function extractBarcodeTokens(text: string): string[] {
  return text.match(/\b\d{13}\b/g) ?? [];
}

// --- Catalog indexes -------------------------------------------------------------
// Maps a normalized SKU/barcode to EVERY active product that normalizes to
// it (not just one) - a real catalog-level collision (two distinct active
// SKUs normalizing identically, or two products genuinely sharing a
// barcode - Stage 1 already found one real duplicate barcode,
// 753287487971) must surface as ambiguous evidence, never silently pick
// whichever happened to be inserted into a map last.
function buildSkuIndex(catalog: ProductCatalog): Map<string, CatalogProduct[]> {
  const index = new Map<string, CatalogProduct[]>();
  for (const product of catalog.products) {
    if (!product.isActive) continue;
    const normalized = normalizeCatalogText(product.sku);
    if (!normalized) continue;
    const existing = index.get(normalized);
    if (existing) existing.push(product);
    else index.set(normalized, [product]);
  }
  return index;
}

// STAGE 2.1: a real live case had a raw OCR barcode token
// ("0602697128922", 13 digits) that only matched the real catalog barcode
// ("602697128922", 12 digits) after stripping the leading zero. Strips
// LEADING zeros only (never trailing, never internal) - a barcode's
// trailing digits are significant. Guards against reducing an all-zero
// token to an empty string (kept as "0" instead, which will simply never
// match a real barcode).
function normalizeBarcodeToken(token: string): string {
  const stripped = token.replace(/^0+/, '');
  return stripped || '0';
}

// Indexed by the NORMALIZED (leading-zeros-stripped) barcode, on both
// sides of every comparison - a catalog barcode is normalized the same
// way a raw OCR token is, so either side having (or not having) a leading
// zero is handled symmetrically rather than assuming only the OCR side
// can have one.
function buildBarcodeIndex(catalog: ProductCatalog): Map<string, CatalogProduct[]> {
  const index = new Map<string, CatalogProduct[]>();
  for (const product of catalog.products) {
    if (!product.isActive || !product.barcode) continue;
    const barcode = product.barcode.trim();
    if (!barcode) continue;
    const normalized = normalizeBarcodeToken(barcode);
    const existing = index.get(normalized);
    if (existing) existing.push(product);
    else index.set(normalized, [product]);
  }
  return index;
}

// --- CASE A: ProductCode candidate validation -------------------------------------
// "600302 9" -> tokens ["600302", "9"] -> only "600302" is a real active
// SKU -> normalized_product_code = "600302". Never strips digits blindly;
// every candidate token is checked against the real catalog, and more than
// one distinct real match is reported as ambiguous rather than guessed.
//
// STAGE 2.1: a real live case showed Azure can also split a SINGLE real
// SKU across two adjacent tokens - ProductCode "600302 8" for the real
// catalog SKU "6003028" (barcode 602697128922). Neither individual token
// ("600302", "8") is itself a real SKU, so single-token checking alone
// left this needs_review. generateJoinedCandidates() below produces every
// deterministic CONTIGUOUS concatenation of the tokens in their original
// order ("600302"+"8" -> "6003028") as additional candidates alongside the
// individual tokens - never a prefix guess, never an arbitrary
// truncation/append, just literal concatenation of tokens exactly as
// Azure returned them. A joined candidate is accepted under the exact
// same rule as any other candidate: only if it exactly matches ONE
// distinct active catalog SKU. If a joined candidate (or any other
// candidate) would match more than one distinct active product, the
// whole resolution is ambiguous - never silently chosen.

// Every contiguous multi-token join, in original order:
// ["600302", "8"] -> ["6003028"]; ["a","b","c"] -> ["ab", "bc", "abc"].
// Bounded (O(n^2) for n tokens - trivial for a real ProductCode's small
// token count) and fully deterministic - no combinatorial guessing, every
// contiguous window is checked against the real catalog and only an exact
// unique match is ever accepted.
function generateJoinedCandidates(tokens: string[]): string[] {
  const joined: string[] = [];
  for (let start = 0; start < tokens.length; start += 1) {
    let accumulated = tokens[start];
    for (let end = start + 1; end < tokens.length; end += 1) {
      accumulated += tokens[end];
      joined.push(accumulated);
    }
  }
  return joined;
}

export interface ProductCodeResolution {
  status: 'validated' | 'ambiguous' | 'no_catalog_match' | 'no_evidence';
  normalizedProductCode: string | null;
  candidateTokens: string[];
  // Contiguous multi-token joins tried in addition to the individual
  // tokens above (see generateJoinedCandidates()) - empty when there was
  // only one token to begin with.
  joinedCandidates: string[];
  matchedSkus: string[];
  // The real catalog product id(s) behind matchedSkus - used by
  // normalizeOcrLine()'s cross-evidence check against barcode evidence.
  matchedProductIds: string[];
  // true when the source ProductCode text had to be split into more than
  // one token to find the match (e.g. "600302 9" or "600302 8") - used by
  // normalizeOcrLine() to decide whether this counts as a "correction" or
  // was already clean.
  wasMultiToken: boolean;
  // Which literal candidate string (a single token or a joined
  // multi-token string) actually produced the match - traceability only,
  // null when status isn't 'validated'.
  matchedFrom: string | null;
}

export function resolveProductCode(productCode: string | null, catalog: ProductCatalog): ProductCodeResolution {
  if (!productCode || !productCode.trim()) {
    return {
      status: 'no_evidence',
      normalizedProductCode: null,
      candidateTokens: [],
      joinedCandidates: [],
      matchedSkus: [],
      matchedProductIds: [],
      wasMultiToken: false,
      matchedFrom: null,
    };
  }

  const tokens = tokenizeCodeText(productCode);
  const joinedCandidates = generateJoinedCandidates(tokens);
  const skuIndex = buildSkuIndex(catalog);

  const matchedProductIds = new Set<string>();
  const matchedSkus = new Set<string>();
  let hadCatalogLevelCollision = false;
  let matchedFrom: string | null = null;

  // Individual tokens and joined candidates are checked the same way,
  // against the same real catalog index - a joined candidate is never
  // given priority or special treatment over a plain token match, and
  // vice versa. Whatever the FULL set of distinct real products found
  // across every candidate is what determines validated/ambiguous below.
  for (const candidate of [...tokens, ...joinedCandidates]) {
    const normalized = normalizeCatalogText(candidate);
    if (!normalized) continue;
    const candidateMatches = skuIndex.get(normalized);
    if (!candidateMatches || candidateMatches.length === 0) continue;
    if (candidateMatches.length > 1) hadCatalogLevelCollision = true;
    for (const product of candidateMatches) {
      matchedProductIds.add(product.id);
      matchedSkus.add(product.sku);
    }
    if (matchedFrom === null) matchedFrom = candidate;
  }

  const wasMultiToken = tokens.length > 1;

  if (matchedProductIds.size === 0) {
    return {
      status: 'no_catalog_match',
      normalizedProductCode: null,
      candidateTokens: tokens,
      joinedCandidates,
      matchedSkus: [],
      matchedProductIds: [],
      wasMultiToken,
      matchedFrom: null,
    };
  }

  if (matchedProductIds.size > 1 || hadCatalogLevelCollision) {
    return {
      status: 'ambiguous',
      normalizedProductCode: null,
      candidateTokens: tokens,
      joinedCandidates,
      matchedSkus: [...matchedSkus],
      matchedProductIds: [...matchedProductIds],
      wasMultiToken,
      matchedFrom: null,
    };
  }

  return {
    status: 'validated',
    normalizedProductCode: [...matchedSkus][0],
    candidateTokens: tokens,
    joinedCandidates,
    matchedSkus: [...matchedSkus],
    matchedProductIds: [...matchedProductIds],
    wasMultiToken,
    matchedFrom,
  };
}

// --- CASES B/C/F: quantity/amount/unit-price numeric consistency -----------------
// Azure sometimes selects the wrong numeric token as Quantity (real
// observed cases: SKU 411005's Quantity=13 should be 20; SKU 411007's
// Quantity=10.5 should be 50 - both because quantity*unitPrice didn't
// reconcile with Amount, but a raw numeric token elsewhere in the same row
// DID). unit_price/total are never corrected here - only carried through
// unchanged - because every real observed case is specifically a wrong
// Quantity selection, never a wrong UnitPrice/Amount.

export interface QuantityReconciliation {
  status: 'consistent' | 'corrected_from_raw' | 'inconsistent' | 'incomplete';
  normalizedQuantity: number | null;
  impliedQuantity: number | null;
  reason: string | null;
  rawTokensConsidered: number[];
}

export function reconcileQuantity(
  quantity: number | null,
  unitPrice: number | null,
  total: number | null,
  rawNumericTokens: number[],
): QuantityReconciliation {
  // Not enough evidence to even attempt reconciliation - distinct from
  // "inconsistent" (which means reconciliation was attempted and failed).
  // The original quantity (if any) passes through untouched; there is no
  // contradiction to react to, only missing data.
  if (quantity == null || unitPrice == null || total == null) {
    return {
      status: 'incomplete',
      normalizedQuantity: quantity ?? null,
      impliedQuantity: null,
      reason: 'missing_quantity_unit_price_or_amount',
      rawTokensConsidered: [],
    };
  }

  const expectedAmount = quantity * unitPrice;
  if (isCloseEnough(expectedAmount, total, AMOUNT_TOLERANCE)) {
    return {
      status: 'consistent',
      normalizedQuantity: quantity,
      impliedQuantity: null,
      reason: null,
      rawTokensConsidered: [],
    };
  }

  if (unitPrice <= 0) {
    // Can't derive an implied quantity by dividing by a non-positive
    // price - nothing further to try.
    return {
      status: 'inconsistent',
      normalizedQuantity: null,
      impliedQuantity: null,
      reason: 'unit_price_not_positive',
      rawTokensConsidered: [],
    };
  }

  const impliedQuantity = total / unitPrice;
  const matchingToken = rawNumericTokens.find((token) => isCloseEnough(token, impliedQuantity, QUANTITY_MATCH_TOLERANCE));

  if (matchingToken !== undefined) {
    // Prefer the raw token's own exact value over the (possibly
    // rounding-noisy) division result - the raw token is real textual
    // evidence, the division is only what led us to look for it.
    return {
      status: 'corrected_from_raw',
      normalizedQuantity: matchingToken,
      impliedQuantity,
      reason: 'amount_unit_price_consistency',
      rawTokensConsidered: rawNumericTokens,
    };
  }

  // The math suggests a different quantity than Azure reported, but
  // nothing in the row's own raw text corroborates a specific value - per
  // the task's own instruction, never invent a value without evidence.
  return {
    status: 'inconsistent',
    normalizedQuantity: null,
    impliedQuantity,
    reason: 'no_raw_token_matches_implied_quantity',
    rawTokensConsidered: rawNumericTokens,
  };
}

// --- CASE E: barcode evidence ------------------------------------------------------
// Evidence only, never authoritative - see the task's own note that Stage
// 1 already found one real duplicate barcode in the catalog
// (753287487971, shared by two distinct products).

export interface BarcodeResolution {
  status: 'unique' | 'ambiguous' | 'no_match' | 'no_evidence';
  // The original token exactly as extracted from raw text (e.g.
  // "0602697128922") - never modified.
  token: string | null;
  // The leading-zeros-stripped form actually used for comparison (e.g.
  // "602697128922") - see normalizeBarcodeToken().
  normalizedToken: string | null;
  matchedProductIds: string[];
}

export function resolveBarcodeEvidence(rowText: string, catalog: ProductCatalog): BarcodeResolution {
  const tokens = extractBarcodeTokens(rowText);
  if (tokens.length === 0) {
    return { status: 'no_evidence', token: null, normalizedToken: null, matchedProductIds: [] };
  }

  const barcodeIndex = buildBarcodeIndex(catalog);
  // A receipt row is not expected to contain more than one genuine
  // barcode - only the first 13-digit token found is evaluated. Still
  // evidence-only regardless of outcome.
  const token = tokens[0];
  const normalizedToken = normalizeBarcodeToken(token);
  const matches = barcodeIndex.get(normalizedToken) ?? [];

  if (matches.length === 0) return { status: 'no_match', token, normalizedToken, matchedProductIds: [] };
  if (matches.length > 1) return { status: 'ambiguous', token, normalizedToken, matchedProductIds: matches.map((m) => m.id) };
  return { status: 'unique', token, normalizedToken, matchedProductIds: [matches[0].id] };
}

// --- STAGE 2.1: SKU / barcode cross-evidence -------------------------------------
// Two independent pieces of evidence (a uniquely-resolved ProductCode and
// a uniquely-matched barcode) that happen to agree on the same real
// product are strong corroboration - recorded for traceability, but this
// alone is never what changes normalized_product_code (resolveProductCode()
// already produced it on its own evidence). The dangerous case is the
// opposite: two independent, each-individually-unique signals pointing at
// TWO DIFFERENT products. Neither is ever silently preferred over the
// other - this always forces needs_review with normalized_product_code
// cleared, even though resolveProductCode() alone would have been
// confident.

export interface CrossEvidenceResult {
  // true only when both a unique ProductCode resolution and a unique
  // barcode match exist AND agree on the same product.
  agrees: boolean;
  // true only when both exist and disagree - the dangerous case.
  conflict: boolean;
  productId: string | null;
}

function computeCrossEvidence(
  productCodeResolution: ProductCodeResolution,
  barcodeResolution: BarcodeResolution,
): CrossEvidenceResult {
  const skuProductId =
    productCodeResolution.status === 'validated' && productCodeResolution.matchedProductIds.length === 1
      ? productCodeResolution.matchedProductIds[0]
      : null;
  const barcodeProductId = barcodeResolution.status === 'unique' ? barcodeResolution.matchedProductIds[0] : null;

  if (skuProductId && barcodeProductId) {
    if (skuProductId === barcodeProductId) {
      return { agrees: true, conflict: false, productId: skuProductId };
    }
    return { agrees: false, conflict: true, productId: null };
  }

  return { agrees: false, conflict: false, productId: null };
}

// --- CASE D: merged-item detection + evidence-based row recovery -----------------
// Real observed case: one receipt_ocr_line's raw_item contained BOTH
// ProductCode "411208" and "414001", and two Description lines. Detection
// requires TWO independent pieces of evidence agreeing: (1) more than one
// DISTINCT active catalog SKU among the ProductCode field's own tokens,
// and (2) the Description field splitting into exactly that many
// newline-separated segments. Only when both agree is a row ever split -
// otherwise the item is flagged merged/needs_review with nothing
// fabricated. Deliberately does not use bounding-region pixel coordinates
// (see the task's own warning about brittle per-photo layout rules) -
// content/text evidence only, which is stable across rotation/skew/
// distance/layout differences a photographed invoice can have.

export interface RecoveredRowCandidate {
  productCode: string;
  description: string;
}

export interface MergeDetectionResult {
  detected: boolean;
  reason: string | null;
  matchedSkus: string[];
  descriptionSegmentCount: number;
  // null when no split was attempted or evidence was insufficient; an
  // array (possibly checked via .length) once a positionally-paired
  // recovery was actually produced.
  recoveredRows: RecoveredRowCandidate[] | null;
}

function extractAzureFieldText(rawItem: unknown, fieldName: string): string | null {
  const item = rawItem as Record<string, unknown> | null | undefined;
  const valueObject = item?.valueObject as Record<string, unknown> | undefined;
  const field = valueObject?.[fieldName] as Record<string, unknown> | undefined;
  if (!field) return null;
  if (typeof field.content === 'string' && field.content.trim()) return field.content;
  if (typeof field.valueString === 'string' && field.valueString.trim()) return field.valueString;
  return null;
}

export function detectMergedItem(rawItem: unknown, catalog: ProductCatalog): MergeDetectionResult {
  const productCodeText = extractAzureFieldText(rawItem, 'ProductCode');

  if (!productCodeText) {
    return { detected: false, reason: null, matchedSkus: [], descriptionSegmentCount: 0, recoveredRows: null };
  }

  const codeTokens = tokenizeCodeText(productCodeText);
  const skuIndex = buildSkuIndex(catalog);

  // Distinct active products among the tokens, in first-appearance order -
  // a token that is itself ambiguous at the catalog level (>1 product)
  // is skipped here (not this function's concern; resolveProductCode()
  // already surfaces that separately for the non-merged case).
  const seenProductIds = new Set<string>();
  const orderedMatches: CatalogProduct[] = [];
  for (const token of codeTokens) {
    const normalized = normalizeCatalogText(token);
    if (!normalized) continue;
    const candidates = skuIndex.get(normalized);
    if (!candidates || candidates.length !== 1) continue;
    const product = candidates[0];
    if (!seenProductIds.has(product.id)) {
      seenProductIds.add(product.id);
      orderedMatches.push(product);
    }
  }

  if (orderedMatches.length < 2) {
    // Zero or one real SKU found - this is CASE A's territory (a single
    // valid code plus noise), not a merge.
    return { detected: false, reason: null, matchedSkus: orderedMatches.map((p) => p.sku), descriptionSegmentCount: 0, recoveredRows: null };
  }

  const descriptionText = extractAzureFieldText(rawItem, 'Description') ?? '';
  const descriptionSegments = descriptionText
    .split(/\r?\n+/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (descriptionSegments.length !== orderedMatches.length) {
    // Strong evidence of a merge (multiple real, distinct SKUs), but not
    // enough evidence to safely pair each one with its own description -
    // per the task's own instruction, do not guess a pairing.
    return {
      detected: true,
      reason: 'description_segment_count_mismatch',
      matchedSkus: orderedMatches.map((p) => p.sku),
      descriptionSegmentCount: descriptionSegments.length,
      recoveredRows: null,
    };
  }

  return {
    detected: true,
    reason: 'multiple_distinct_sku_tokens_with_matching_description_segments',
    matchedSkus: orderedMatches.map((p) => p.sku),
    descriptionSegmentCount: descriptionSegments.length,
    recoveredRows: orderedMatches.map((product, index) => ({
      productCode: product.sku,
      description: descriptionSegments[index],
    })),
  };
}

// --- Per-line orchestrator ---------------------------------------------------------

export interface NormalizedLineInput {
  productCode: string | null;
  detectedQuantity: number | null;
  detectedUnitPrice: number | null;
  detectedTotal: number | null;
  rawText: string;
  rawItem: unknown;
}

export type NormalizationStatus = 'clean' | 'corrected' | 'ambiguous' | 'needs_review';

export interface NormalizedLineResult {
  normalizedProductCode: string | null;
  normalizedQuantity: number | null;
  normalizedUnitPrice: number | null;
  normalizedTotal: number | null;
  normalizationStatus: NormalizationStatus;
  // Full traceability - every sub-resolution's own status/reason/evidence,
  // never just the final numbers (see the task's own worked example:
  // original quantity=13, normalized=20, status=corrected_from_raw,
  // reason=amount_unit_price_consistency - all of that lives here, one
  // level down from the small top-level normalizationStatus).
  normalizationNotes: Record<string, unknown>;
  // Non-null only when a merge was detected (successfully split or not) -
  // see normalizeAndPersistOcrLines() for how these become new rows.
  recoveredRows: RecoveredRowCandidate[] | null;
}

// Gathers every piece of raw text associated with this one row (the
// cleaned rawText Stage 1 already persisted, plus the raw item's own
// content and each structured sub-field's content, when present) - the
// numeric/barcode token search scope for THIS row only, never the whole
// document/other rows.
function collectRowRawText(input: NormalizedLineInput): string {
  const parts: string[] = [input.rawText || ''];
  const item = input.rawItem as Record<string, unknown> | null | undefined;
  if (typeof item?.content === 'string') parts.push(item.content);
  const valueObject = item?.valueObject as Record<string, unknown> | undefined;
  if (valueObject) {
    for (const key of ['Description', 'ProductCode', 'Quantity', 'UnitPrice', 'Amount']) {
      const field = valueObject[key] as Record<string, unknown> | undefined;
      if (field && typeof field.content === 'string') parts.push(field.content);
    }
  }
  return parts.join(' ');
}

// Combines every CASE A/B/C/D/E resolution into one row-level result.
// Status precedence (highest first) - a merged item always wins (its own
// fields are never authoritative once evidence shows it's actually 2+
// rows), then anything needing a human look, then ambiguity, then a
// successful correction, then clean:
//   merge detected -> needs_review (regardless of split success - the
//     PARENT row's own single set of fields is never presented as
//     authoritative once it's known to represent more than one product)
//   quantity inconsistent, or product code present but matches no active
//     SKU at all -> needs_review
//   STAGE 2.1: a unique product-code resolution and a unique barcode
//     match that point at TWO DIFFERENT products -> needs_review,
//     normalized_product_code cleared (see computeCrossEvidence() -
//     neither independent signal is ever silently preferred)
//   product code ambiguous, or barcode ambiguous -> ambiguous
//   quantity corrected, or product code needed multi-token cleanup
//     -> corrected
//   otherwise -> clean
export function normalizeOcrLine(input: NormalizedLineInput, catalog: ProductCatalog): NormalizedLineResult {
  const rowText = collectRowRawText(input);
  const mergeResult = detectMergedItem(input.rawItem, catalog);

  const productCodeResolution = resolveProductCode(input.productCode, catalog);
  const rawNumericTokens = extractNumericTokens(rowText);
  const quantityResolution = reconcileQuantity(input.detectedQuantity, input.detectedUnitPrice, input.detectedTotal, rawNumericTokens);
  const barcodeResolution = resolveBarcodeEvidence(rowText, catalog);
  const crossEvidence = computeCrossEvidence(productCodeResolution, barcodeResolution);

  const notes: Record<string, unknown> = {
    productCode: productCodeResolution,
    quantity: quantityResolution,
    barcode: barcodeResolution,
    merge: mergeResult,
    crossEvidence,
  };

  if (mergeResult.detected) {
    // Never keep a merged item's single product_code/quantity/etc. as if
    // authoritative for one product - true whether or not the split
    // itself succeeded.
    return {
      normalizedProductCode: null,
      normalizedQuantity: null,
      normalizedUnitPrice: null,
      normalizedTotal: null,
      normalizationStatus: 'needs_review',
      normalizationNotes: notes,
      recoveredRows: mergeResult.recoveredRows,
    };
  }

  let status: NormalizationStatus;
  let normalizedProductCode = productCodeResolution.normalizedProductCode;

  if (quantityResolution.status === 'inconsistent' || productCodeResolution.status === 'no_catalog_match') {
    status = 'needs_review';
  } else if (crossEvidence.conflict) {
    // Two independent, each-individually-unique signals disagree - never
    // choose either silently, even though resolveProductCode() alone was
    // confident.
    status = 'needs_review';
    normalizedProductCode = null;
  } else if (productCodeResolution.status === 'ambiguous' || barcodeResolution.status === 'ambiguous') {
    status = 'ambiguous';
  } else if (quantityResolution.status === 'corrected_from_raw' || (productCodeResolution.status === 'validated' && productCodeResolution.wasMultiToken)) {
    status = 'corrected';
  } else {
    status = 'clean';
  }

  return {
    normalizedProductCode,
    normalizedQuantity: quantityResolution.normalizedQuantity,
    normalizedUnitPrice: input.detectedUnitPrice,
    normalizedTotal: input.detectedTotal,
    normalizationStatus: status,
    normalizationNotes: notes,
    recoveredRows: null,
  };
}

// --- Persistence (server-side, service-role client only) --------------------------

export interface NormalizeAndPersistOutcome {
  sourceItemCount: number;
  normalizedRowCount: number;
  correctedCount: number;
  ambiguousCount: number;
  needsReviewCount: number;
  mergedRecoveredCount: number;
  cleanCount: number;
}

// Reads back the lines Stage 1 just persisted for this OCR result,
// normalizes each one, writes the derived fields onto the SAME row
// (never touching raw_text/raw_item/product_code/detected_*/*_confidence
// - see migration 022's own comments), and inserts any evidence-based
// recovered split rows. Idempotent by construction: this is only ever
// called right after persistOcrResult() has just done its own full
// delete-then-insert of every receipt_ocr_lines row for this
// ocr_result_id (see ocrPersistence.ts) - including any previously
// recovered rows, which belong to the same ocr_result_id and get swept by
// that same delete. There is never a stale/duplicate recovered row left
// over from an earlier run to reconcile; every re-run starts from the
// same fresh Stage 1 evidence and deterministically regenerates the same
// normalization output from it.
export async function normalizeAndPersistOcrLines(
  adminClient: SupabaseClient,
  ocrResultId: string,
): Promise<NormalizeAndPersistOutcome> {
  const outcome: NormalizeAndPersistOutcome = {
    sourceItemCount: 0,
    normalizedRowCount: 0,
    correctedCount: 0,
    ambiguousCount: 0,
    needsReviewCount: 0,
    mergedRecoveredCount: 0,
    cleanCount: 0,
  };

  const { data: lineRows, error: fetchError } = await adminClient
    .from('receipt_ocr_lines')
    .select('id, line_index, raw_text, product_code, detected_quantity, detected_unit_price, detected_total, raw_item')
    .eq('ocr_result_id', ocrResultId)
    .order('line_index', { ascending: true });

  if (fetchError) {
    throw new Error(`Failed to load receipt_ocr_lines for normalization: ${fetchError.message}`);
  }

  const lines = (lineRows ?? []) as Array<Record<string, unknown>>;
  outcome.sourceItemCount = lines.length;

  if (lines.length === 0) {
    return outcome;
  }

  const catalog = await loadActiveProductCatalog(adminClient);

  let nextLineIndex = Math.max(...lines.map((row) => row.line_index as number)) + 1;
  const recoveredRowsToInsert: Record<string, unknown>[] = [];

  for (const row of lines) {
    const result = normalizeOcrLine(
      {
        productCode: (row.product_code as string | null) ?? null,
        detectedQuantity: (row.detected_quantity as number | null) ?? null,
        detectedUnitPrice: (row.detected_unit_price as number | null) ?? null,
        detectedTotal: (row.detected_total as number | null) ?? null,
        rawText: (row.raw_text as string) ?? '',
        rawItem: row.raw_item ?? null,
      },
      catalog,
    );

    const { error: updateError } = await adminClient
      .from('receipt_ocr_lines')
      .update({
        normalized_product_code: result.normalizedProductCode,
        normalized_quantity: result.normalizedQuantity,
        normalized_unit_price: result.normalizedUnitPrice,
        normalized_total: result.normalizedTotal,
        normalization_status: result.normalizationStatus,
        normalization_notes: result.normalizationNotes,
      })
      .eq('id', row.id as string);

    if (updateError) {
      throw new Error(`Failed to persist normalization for receipt_ocr_lines id=${row.id}: ${updateError.message}`);
    }

    switch (result.normalizationStatus) {
      case 'clean':
        outcome.cleanCount += 1;
        break;
      case 'corrected':
        outcome.correctedCount += 1;
        break;
      case 'ambiguous':
        outcome.ambiguousCount += 1;
        break;
      case 'needs_review':
        outcome.needsReviewCount += 1;
        break;
    }

    if (result.recoveredRows && result.recoveredRows.length > 0) {
      for (const recovered of result.recoveredRows) {
        recoveredRowsToInsert.push({
          ocr_result_id: ocrResultId,
          line_index: nextLineIndex,
          raw_text: recovered.description,
          // The literal token extracted from the parent's own Azure
          // ProductCode content - real evidence, not fabricated, copied
          // into the same Stage 1 column a normal row would have it in.
          product_code: recovered.productCode,
          normalized_product_code: recovered.productCode,
          normalization_status: 'merged_recovered',
          normalization_notes: { recoveredFromOcrLineId: row.id, parentLineIndex: row.line_index },
          source_ocr_line_id: row.id,
          is_recovered_row: true,
        });
        nextLineIndex += 1;
        outcome.mergedRecoveredCount += 1;
      }
    }
  }

  if (recoveredRowsToInsert.length > 0) {
    const { error: insertError } = await adminClient.from('receipt_ocr_lines').insert(recoveredRowsToInsert);
    if (insertError) {
      throw new Error(`Failed to insert recovered OCR rows: ${insertError.message}`);
    }
  }

  outcome.normalizedRowCount = lines.length + recoveredRowsToInsert.length;

  return outcome;
}