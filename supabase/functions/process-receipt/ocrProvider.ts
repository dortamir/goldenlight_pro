// Thin abstraction over whichever OCR provider extracts text from a receipt
// image. Only one provider (Azure Document Intelligence) is implemented
// today, but process-receipt/index.ts talks only to this module, never to
// a vendor SDK/API directly - swapping or adding a provider later stays
// isolated here.
//
// PROVIDER ADAPTER CONTRACT: on success, every provider adapter (this one,
// or any future one) must resolve to a NormalizedOcrResult (defined in
// ocrParser.ts) - a plain { rawText, lines[] } shape. index.ts hands that
// result to ocrParser.parseOcrResult() for cleanup/validation before
// anything is persisted, so this module's only job is producing that
// normalized shape - it does not clean text, validate numbers, or assign
// line_index itself. Azure-specific extraction (extractInvoiceItems,
// buildNormalizedResult below) IS allowed to set the Azure-specific
// optional fields on NormalizedOcrLine (productCode, *Confidence, rawItem)
// - those fields exist in the contract specifically to carry
// provider-specific structured evidence through, without leaking
// Azure-only field/response shapes into index.ts or ocrParser.ts itself.
//
// IMPORTANT: this module must never fabricate OCR output, and must never
// "fix"/clean a value Azure returned (e.g. splitting a ProductCode like
// "600302 9") - Stage 1's job is faithful extraction only. Until real
// provider credentials are configured, runOcrProvider() always resolves to
// a controlled "not configured" result instead of pretending to succeed.

import type { NormalizedOcrLine, NormalizedOcrResult } from './ocrParser.ts';

export const AZURE_MODEL_ID = 'prebuilt-invoice';
export const AZURE_API_VERSION = '2024-11-30';

// Bounded polling: Azure invoice analysis for a single-page receipt
// typically completes in a few seconds. 2s between polls, up to 45
// attempts (~90s total) comfortably covers a slow/busy Azure instance
// without polling forever - if it's still not done by then, this is
// treated as a timeout failure rather than hanging the Edge Function
// indefinitely (Supabase Edge Functions also have their own wall-clock
// limit, so this must stay well under that regardless).
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 45;
// Per-HTTP-call timeout (both the initial submit and each poll) - guards
// against a hung connection, independent of the overall polling budget
// above.
const REQUEST_TIMEOUT_MS = 20000;

export type OcrProviderResult =
  | {
      ok: true;
      provider: 'azure_document_intelligence';
      modelId: string;
      apiVersion: string;
      result: NormalizedOcrResult;
      // The complete Azure analyzeResult JSON, passed through untouched
      // for receipt_ocr_results.raw_response - never inspected by
      // index.ts/ocrParser.ts, only stored.
      rawResponse: unknown;
    }
  | {
      ok: false;
      reason: 'not_configured' | 'timeout' | 'http_error' | 'analysis_failed' | 'invalid_response';
      // Safe to log/persist - never contains the Azure key or any request
      // header. See buildSafeErrorMessage()/each failure site below.
      message: string;
      // Present whenever an Azure call was actually attempted (i.e. not
      // 'not_configured'), so the caller can still record which
      // model/version was tried even on failure.
      modelId?: string;
      apiVersion?: string;
      // Azure's own error body (from a failed poll) or a minimal envelope
      // for an HTTP-level error, when available - safe to persist (never
      // contains the subscription key), useful for later debugging.
      rawResponse?: unknown;
    };

function getAzureConfig(): { endpoint: string; key: string } | null {
  const endpoint = Deno.env.get('AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT');
  const key = Deno.env.get('AZURE_DOCUMENT_INTELLIGENCE_KEY');

  if (!endpoint || !key) {
    return null;
  }

  // A trailing slash on the configured endpoint would otherwise produce a
  // double-slash in the built URL below - normalized once, here, rather
  // than at every call site.
  return { endpoint: endpoint.replace(/\/+$/, ''), key };
}

function withTimeout(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timeoutId) };
}

// Never includes the subscription key or any header - only Azure's own
// response status/body (already safe, since Azure never echoes the
// caller's key back), truncated so an oversized/malformed body can never
// blow up a log line.
export function buildSafeErrorMessage(prefix: string, status: number, bodyText: string): string {
  const truncatedBody = bodyText.length > 500 ? `${bodyText.slice(0, 500)}...` : bodyText;
  return `${prefix} (HTTP ${status}): ${truncatedBody}`;
}

// --- Step 1: submit the document for analysis -------------------------------
// POST {endpoint}/documentintelligence/documentModels/{modelId}:analyze?api-version={apiVersion}
// with the raw file bytes as the body. A successful submission returns 202
// Accepted with an Operation-Location header pointing at the poll URL - it
// does NOT return the analysis result itself.
async function submitAnalysis(
  endpoint: string,
  key: string,
  fileBytes: Uint8Array,
  contentType: string,
): Promise<{ ok: true; operationLocation: string } | { ok: false; message: string; rawResponse?: unknown }> {
  const url = `${endpoint}/documentintelligence/documentModels/${AZURE_MODEL_ID}:analyze?api-version=${AZURE_API_VERSION}`;
  const { signal, cancel } = withTimeout(REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': contentType || 'application/octet-stream',
      },
      // Cast needed only to satisfy the editor's DOM-lib fetch typings
      // (see supabase/functions/tsconfig.json's own note on this) - a
      // Uint8Array is a valid fetch body in every real runtime, Deno
      // included; this has no effect on behavior.
      body: fileBytes as BodyInit,
      signal,
    });
  } catch (err) {
    cancel();
    if ((err as Error)?.name === 'AbortError') {
      return { ok: false, message: 'Azure analyze request timed out' };
    }
    return { ok: false, message: 'Azure analyze request failed (network error)' };
  }
  cancel();

  if (response.status !== 202) {
    const bodyText = await response.text().catch(() => '');
    let rawResponse: unknown;
    try {
      rawResponse = bodyText ? JSON.parse(bodyText) : undefined;
    } catch {
      rawResponse = undefined;
    }
    return {
      ok: false,
      message: buildSafeErrorMessage('Azure analyze request rejected', response.status, bodyText),
      rawResponse,
    };
  }

  const operationLocation = response.headers.get('operation-location') || response.headers.get('Operation-Location');
  if (!operationLocation) {
    return { ok: false, message: 'Azure analyze response missing Operation-Location header' };
  }

  return { ok: true, operationLocation };
}

// --- Step 2: poll until the analysis finishes --------------------------------
// GET the Operation-Location URL until status is 'succeeded' or 'failed',
// bounded by MAX_POLL_ATTEMPTS - never polls forever.
async function pollAnalysisResult(
  operationLocation: string,
  key: string,
): Promise<
  | { ok: true; analyzeResult: unknown; rawResponse: unknown }
  | { ok: false; reason: 'timeout' | 'http_error' | 'analysis_failed' | 'invalid_response'; message: string; rawResponse?: unknown }
> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    const { signal, cancel } = withTimeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(operationLocation, {
        method: 'GET',
        headers: { 'Ocp-Apim-Subscription-Key': key },
        signal,
      });
    } catch (err) {
      cancel();
      if ((err as Error)?.name === 'AbortError') {
        continue; // A single slow poll doesn't abandon the whole run - retry on the next attempt.
      }
      return { ok: false, reason: 'http_error', message: 'Azure poll request failed (network error)' };
    }
    cancel();

    const bodyText = await response.text().catch(() => '');

    if (!response.ok) {
      let rawResponse: unknown;
      try {
        rawResponse = bodyText ? JSON.parse(bodyText) : undefined;
      } catch {
        rawResponse = undefined;
      }
      return {
        ok: false,
        reason: 'http_error',
        message: buildSafeErrorMessage('Azure poll request failed', response.status, bodyText),
        rawResponse,
      };
    }

    let body: Record<string, unknown>;
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      return { ok: false, reason: 'invalid_response', message: 'Azure poll response was not valid JSON' };
    }

    const status = typeof body.status === 'string' ? body.status : null;

    if (status === 'succeeded') {
      if (!body.analyzeResult || typeof body.analyzeResult !== 'object') {
        return { ok: false, reason: 'invalid_response', message: 'Azure reported success with no analyzeResult', rawResponse: body };
      }
      return { ok: true, analyzeResult: body.analyzeResult, rawResponse: body };
    }

    if (status === 'failed') {
      const errorObj = body.error as Record<string, unknown> | undefined;
      const safeCode = typeof errorObj?.code === 'string' ? errorObj.code : 'unknown';
      const safeMessage = typeof errorObj?.message === 'string' ? errorObj.message : 'no message';
      return {
        ok: false,
        reason: 'analysis_failed',
        message: `Azure analysis failed (${safeCode}): ${safeMessage}`,
        rawResponse: body,
      };
    }

    // status is 'notStarted' or 'running' (or missing/unexpected) - keep polling.
  }

  return { ok: false, reason: 'timeout', message: `Azure analysis did not complete within ${MAX_POLL_ATTEMPTS} polls` };
}

// --- Step 3: translate Azure's analyzeResult into the provider-neutral -------
// NormalizedOcrResult contract. Pure/no I/O - exported for unit testing
// against realistic fixture JSON without any network access (see
// ocrProvider.test.ts).
//
// Extraction is deliberately minimal and defensive: every field is read via
// optional chaining with a documented fallback order, nothing is inferred
// from surrounding text, and a numeric value is only kept if Azure itself
// typed it as a number/currency - a string-typed value is never parsed
// into a number here (the same "never guess" posture as
// normalizeNonNegativeNumber() in ocrParser.ts). The complete raw item
// object is always attached as rawItem regardless of what could be
// extracted from it, so nothing Azure returned is ever lost even if a
// future response shape doesn't match what's read explicitly below.
interface AzureField {
  valueString?: unknown;
  valueNumber?: unknown;
  valueCurrency?: { amount?: unknown } | null;
  content?: unknown;
  confidence?: unknown;
}

function fieldContent(field: AzureField | undefined | null): string | null {
  if (!field) return null;
  if (typeof field.content === 'string' && field.content.trim()) return field.content;
  if (typeof field.valueString === 'string' && field.valueString.trim()) return field.valueString;
  return null;
}

function fieldNumber(field: AzureField | undefined | null): number | null {
  if (!field) return null;
  if (typeof field.valueCurrency?.amount === 'number') return field.valueCurrency.amount;
  if (typeof field.valueNumber === 'number') return field.valueNumber;
  return null;
}

function fieldConfidence(field: AzureField | undefined | null): number | null {
  if (!field || typeof field.confidence !== 'number') return null;
  return field.confidence;
}

export function extractInvoiceItems(analyzeResult: unknown): NormalizedOcrLine[] {
  const documents = (analyzeResult as Record<string, unknown> | undefined)?.documents;
  const firstDocument = Array.isArray(documents) ? (documents[0] as Record<string, unknown> | undefined) : undefined;
  const fields = firstDocument?.fields as Record<string, unknown> | undefined;
  const itemsField = fields?.Items as Record<string, unknown> | undefined;
  const valueArray = Array.isArray(itemsField?.valueArray) ? (itemsField!.valueArray as unknown[]) : [];

  const lines: NormalizedOcrLine[] = [];

  for (const rawItem of valueArray) {
    const item = rawItem as Record<string, unknown> | undefined;
    const valueObject = item?.valueObject as Record<string, unknown> | undefined;

    const descriptionField = valueObject?.Description as AzureField | undefined;
    const productCodeField = valueObject?.ProductCode as AzureField | undefined;
    const quantityField = valueObject?.Quantity as AzureField | undefined;
    const unitPriceField = valueObject?.UnitPrice as AzureField | undefined;
    const amountField = valueObject?.Amount as AzureField | undefined;

    // The row's "text" prefers the whole item's own content (the full
    // extracted row text, which is what a receipt line has always meant in
    // this schema) and falls back to the Description field's own content/
    // value only if the item itself has none.
    const rowContent = typeof item?.content === 'string' && item.content.trim() ? item.content : null;
    const text = rowContent ?? fieldContent(descriptionField) ?? '';

    lines.push({
      text,
      quantity: fieldNumber(quantityField),
      unitPrice: fieldNumber(unitPriceField),
      total: fieldNumber(amountField),
      productCode: fieldContent(productCodeField),
      descriptionConfidence: fieldConfidence(descriptionField),
      productCodeConfidence: fieldConfidence(productCodeField),
      quantityConfidence: fieldConfidence(quantityField),
      unitPriceConfidence: fieldConfidence(unitPriceField),
      amountConfidence: fieldConfidence(amountField),
      // The complete raw item - every field's value/content/confidence/
      // boundingRegions/spans - preserved verbatim regardless of what was
      // extracted above.
      rawItem: item ?? null,
    });
  }

  return lines;
}

// The full document text (analyzeResult.content) - already includes every
// line Azure's OCR layer detected, independent of which rows made it into
// the structured Items array. This is the raw evidence a later fallback
// parser needs for a row Items omitted (see CASE B in the Stage 1 spec) -
// it is persisted as-is via rawText/receipt_ocr_results.raw_text, and the
// complete analyzeResult (including .pages[].lines[] with per-line spans)
// is separately preserved in full via receipt_ocr_results.raw_response.
export function buildNormalizedResult(analyzeResult: unknown): NormalizedOcrResult {
  const content = (analyzeResult as Record<string, unknown> | undefined)?.content;
  const rawText = typeof content === 'string' ? content : '';
  return { rawText, lines: extractInvoiceItems(analyzeResult) };
}

// --- Main entry point ---------------------------------------------------------
export async function runOcrProvider(fileBytes: Uint8Array, contentType: string): Promise<OcrProviderResult> {
  const azureConfig = getAzureConfig();

  if (!azureConfig) {
    return { ok: false, reason: 'not_configured', message: 'OCR provider not configured' };
  }

  const submitOutcome = await submitAnalysis(azureConfig.endpoint, azureConfig.key, fileBytes, contentType);
  if (!submitOutcome.ok) {
    return {
      ok: false,
      reason: 'http_error',
      message: submitOutcome.message,
      modelId: AZURE_MODEL_ID,
      apiVersion: AZURE_API_VERSION,
      rawResponse: submitOutcome.rawResponse,
    };
  }

  const pollOutcome = await pollAnalysisResult(submitOutcome.operationLocation, azureConfig.key);
  if (!pollOutcome.ok) {
    return {
      ok: false,
      reason: pollOutcome.reason,
      message: pollOutcome.message,
      modelId: AZURE_MODEL_ID,
      apiVersion: AZURE_API_VERSION,
      rawResponse: pollOutcome.rawResponse,
    };
  }

  return {
    ok: true,
    provider: 'azure_document_intelligence',
    modelId: AZURE_MODEL_ID,
    apiVersion: AZURE_API_VERSION,
    result: buildNormalizedResult(pollOutcome.analyzeResult),
    rawResponse: pollOutcome.rawResponse,
  };
}