// Dev-only local tests for ocrProvider.ts's pure Azure response translation
// (extractInvoiceItems/buildNormalizedResult), using Deno's built-in test
// runner, matching the same approach as ocrParser.test.ts/
// productMatcher.test.ts. Run locally with:
//
//   deno test supabase/functions/process-receipt/ocrProvider.test.ts
//
// These never touch the network, Azure, or Supabase - they exercise only
// the pure JSON-shape translation against realistic fixture objects
// modeled on Azure Document Intelligence's real prebuilt-invoice response
// shape (documents[0].fields.Items.valueArray[].valueObject.{Description,
// ProductCode,Quantity,UnitPrice,Amount}), each field carrying
// value/content/confidence like the real API. runOcrProvider() itself
// (the actual HTTP submit/poll) is not covered here - that requires a live
// Azure endpoint/credentials and is documented as a live-verification item
// in the Stage 1 report, not something faked with a mock in this suite.

import { assertEquals, assertExists } from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { buildNormalizedResult, extractInvoiceItems } from './ocrProvider.ts';

function azureField(opts: { valueString?: string; valueNumber?: number; amount?: number; content?: string; confidence?: number }) {
  const field: Record<string, unknown> = {};
  if (opts.valueString !== undefined) field.valueString = opts.valueString;
  if (opts.valueNumber !== undefined) field.valueNumber = opts.valueNumber;
  if (opts.amount !== undefined) field.valueCurrency = { amount: opts.amount, currencyCode: 'ILS' };
  if (opts.content !== undefined) field.content = opts.content;
  if (opts.confidence !== undefined) field.confidence = opts.confidence;
  return field;
}

// CASE A: ProductCode "600302 9" (a real observed case - a stray adjacent
// row number glued onto the actual SKU) must be preserved EXACTLY as Azure
// returned it - never split/cleaned at this stage.
Deno.test('CASE A: preserves a ProductCode with a stray adjacent token exactly as Azure returned it', () => {
  const analyzeResult = {
    content: 'חשבונית...',
    documents: [
      {
        fields: {
          Items: {
            type: 'array',
            valueArray: [
              {
                type: 'object',
                content: '600302 9  ספוט לד גולדן לייט  3  10.50  31.50',
                confidence: 0.88,
                valueObject: {
                  Description: azureField({ valueString: 'ספוט לד גולדן לייט', content: 'ספוט לד גולדן לייט', confidence: 0.9 }),
                  ProductCode: azureField({ valueString: '600302 9', content: '600302 9', confidence: 0.85 }),
                  Quantity: azureField({ valueNumber: 3, content: '3', confidence: 0.95 }),
                  UnitPrice: azureField({ amount: 10.5, content: '10.50', confidence: 0.9 }),
                  Amount: azureField({ amount: 31.5, content: '31.50', confidence: 0.92 }),
                },
              },
            ],
          },
        },
      },
    ],
  };

  const lines = extractInvoiceItems(analyzeResult);

  assertEquals(lines.length, 1);
  // Exactly as Azure returned it - NOT cleaned to "600302".
  assertEquals(lines[0].productCode, '600302 9');
  assertEquals(lines[0].productCodeConfidence, 0.85);
  assertEquals(lines[0].quantity, 3);
  assertEquals(lines[0].unitPrice, 10.5);
  assertEquals(lines[0].total, 31.5);
  assertExists(lines[0].rawItem);
});

// CASE B: Azure's structured Items contains fewer rows than the raw OCR
// text actually shows (a real observed case - a visible invoice row Azure
// omitted from the table). Stage 1 must preserve the raw text evidence for
// the missing row without ever fabricating a structured line for it.
Deno.test('CASE B: raw text evidence for a row missing from structured Items is preserved, not fabricated as a line', () => {
  const analyzeResult = {
    content: 'שורה 1\nשורה 2\nשורה 3\nשורה 4\nשורה חמישית שלא הופיעה בטבלה המובנית',
    documents: [
      {
        fields: {
          Items: {
            type: 'array',
            valueArray: [1, 2, 3, 4].map((n) => ({
              type: 'object',
              content: `שורה ${n}`,
              valueObject: {
                Description: azureField({ valueString: `שורה ${n}`, content: `שורה ${n}`, confidence: 0.9 }),
              },
            })),
          },
        },
      },
    ],
  };

  const normalized = buildNormalizedResult(analyzeResult);

  // Only 4 structured lines - the 5th row is never fabricated as a
  // receipt_ocr_lines row.
  assertEquals(normalized.lines.length, 4);
  // But the raw text (-> receipt_ocr_results.raw_text) still contains the
  // 5th row's evidence, for a later fallback parser to find.
  assertEquals(normalized.rawText.includes('שורה חמישית שלא הופיעה בטבלה המובנית'), true);
});

// CASE C: low-confidence Quantity/ProductCode are persisted with their
// confidence value, never treated as authoritative (there is no
// "authoritative" flag anywhere in this module - persistence alone,
// exactly as returned).
Deno.test('CASE C: low-confidence fields are extracted with their real (low) confidence value, not discarded or upgraded', () => {
  const analyzeResult = {
    content: 'invoice',
    documents: [
      {
        fields: {
          Items: {
            type: 'array',
            valueArray: [
              {
                type: 'object',
                content: 'unclear row',
                valueObject: {
                  Description: azureField({ valueString: 'unclear row', content: 'unclear row', confidence: 0.4 }),
                  ProductCode: azureField({ valueString: 'GX?12', content: 'GX?12', confidence: 0.21 }),
                  Quantity: azureField({ valueNumber: 1, content: '1', confidence: 0.15 }),
                },
              },
            ],
          },
        },
      },
    ],
  };

  const lines = extractInvoiceItems(analyzeResult);

  assertEquals(lines[0].productCode, 'GX?12');
  assertEquals(lines[0].productCodeConfidence, 0.21);
  assertEquals(lines[0].quantityConfidence, 0.15);
  // Still extracted (not dropped) despite low confidence - Stage 1 never
  // filters/hides data based on a confidence threshold, it only persists
  // the confidence value for a later stage to use.
  assertEquals(lines[0].quantity, 1);
});

Deno.test('a row missing UnitPrice/Amount entirely yields null, never a guessed number', () => {
  const analyzeResult = {
    content: 'invoice',
    documents: [
      {
        fields: {
          Items: {
            type: 'array',
            valueArray: [
              {
                type: 'object',
                content: 'row with no price fields',
                valueObject: {
                  Description: azureField({ valueString: 'row with no price fields', content: 'row with no price fields' }),
                },
              },
            ],
          },
        },
      },
    ],
  };

  const lines = extractInvoiceItems(analyzeResult);

  assertEquals(lines[0].unitPrice, null);
  assertEquals(lines[0].total, null);
  assertEquals(lines[0].unitPriceConfidence, null);
  assertEquals(lines[0].amountConfidence, null);
});

Deno.test('a string-typed numeric-looking value is never parsed into a number - only a real Azure number/currency type is used', () => {
  const analyzeResult = {
    content: 'invoice',
    documents: [
      {
        fields: {
          Items: {
            type: 'array',
            valueArray: [
              {
                type: 'object',
                content: 'row',
                valueObject: {
                  Description: azureField({ valueString: 'row', content: 'row' }),
                  // Azure typed this as a string field (e.g. low
                  // confidence in numeric parsing) rather than a number -
                  // this must stay null, never string-parsed here.
                  Quantity: { valueString: '3', content: '3', confidence: 0.5 },
                },
              },
            ],
          },
        },
      },
    ],
  };

  const lines = extractInvoiceItems(analyzeResult);

  assertEquals(lines[0].quantity, null);
});

Deno.test('an analyzeResult with no documents/Items produces zero lines but is not an error', () => {
  const lines = extractInvoiceItems({ content: 'no items here' });
  assertEquals(lines.length, 0);
});

Deno.test('buildNormalizedResult falls back to empty rawText when content is missing', () => {
  const normalized = buildNormalizedResult({});
  assertEquals(normalized.rawText, '');
  assertEquals(normalized.lines.length, 0);
});