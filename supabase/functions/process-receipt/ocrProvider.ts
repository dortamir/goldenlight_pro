// Thin abstraction over whichever OCR provider extracts text from a receipt
// image. Only one provider (Azure Document Intelligence) is planned today,
// but process-receipt/index.ts talks only to this module, never to a vendor
// SDK/API directly - swapping or adding a provider later stays isolated
// here.
//
// PROVIDER ADAPTER CONTRACT: on success, every provider adapter (this one,
// or any future one) must resolve to a NormalizedOcrResult (defined in
// ocrParser.ts) - a plain { rawText, lines[] } shape with no Azure-specific
// (or any other vendor-specific) fields. index.ts hands that result to
// ocrParser.parseOcrResult() for cleanup/validation before anything is
// persisted, so this module's only job is producing that normalized shape -
// it does not clean text, validate numbers, or assign line_index itself.
//
// IMPORTANT: this module must never fabricate OCR output. Until real
// provider credentials are configured (see the env var names below),
// runOcrProvider() always resolves to a controlled "not configured" /
// "provider error" result instead of pretending to succeed.

import type { NormalizedOcrResult } from './ocrParser.ts';

export type OcrProviderResult =
  | { ok: true; provider: string; result: NormalizedOcrResult }
  | { ok: false; reason: 'not_configured' | 'provider_error'; message: string };

// Future secrets, read only from the Edge Function's own environment
// (Supabase project secrets), never from source control and never from the
// Expo app. Names only - no values are hardcoded or required yet:
//   AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT
//   AZURE_DOCUMENT_INTELLIGENCE_KEY
function getAzureConfig(): { endpoint: string; key: string } | null {
  const endpoint = Deno.env.get('AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT');
  const key = Deno.env.get('AZURE_DOCUMENT_INTELLIGENCE_KEY');

  if (!endpoint || !key) {
    return null;
  }

  return { endpoint, key };
}

// Runs OCR on a single receipt file. The caller downloads the file from the
// private `receipts` bucket (using the service-role client) and passes the
// raw bytes in here - this module never touches Storage or the database
// itself, keeping it a pure provider adapter.
export async function runOcrProvider(
  _fileBytes: Uint8Array,
  _contentType: string,
): Promise<OcrProviderResult> {
  const azureConfig = getAzureConfig();

  if (!azureConfig) {
    return {
      ok: false,
      reason: 'not_configured',
      message: 'OCR provider not configured',
    };
  }

  // Azure Document Intelligence integration goes here once credentials are
  // available and this stage is explicitly approved. Deliberately left
  // unimplemented for this foundation - no fake/sample OCR output is ever
  // produced by this function.
  //
  // Expected shape once implemented, roughly:
  //   const response = await fetch(`${azureConfig.endpoint}/documentModels/...`, {
  //     method: 'POST',
  //     headers: { 'Ocp-Apim-Subscription-Key': azureConfig.key, 'Content-Type': _contentType },
  //     body: _fileBytes,
  //   });
  //   ...poll for the result, then translate Azure's response into the
  //   generic NormalizedOcrResult contract (do NOT leak Azure-specific
  //   field names/shapes past this function):
  //   return {
  //     ok: true,
  //     provider: 'azure_document_intelligence',
  //     result: { rawText, lines: [{ text, quantity, unitPrice, total }, ...] },
  //   };
  return {
    ok: false,
    reason: 'provider_error',
    message: 'Azure Document Intelligence integration is not implemented yet',
  };
}
