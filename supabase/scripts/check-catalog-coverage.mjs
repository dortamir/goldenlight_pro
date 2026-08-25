// Catalog coverage diagnostic - Stage 7.
//
// WHAT THIS IS: a read-only diagnostic for a specific question: "if this
// OCR evidence (a product code + description, exactly as Azure/Stage 1
// captured it) were seen again today, would the CURRENT live catalog let
// Stage 3's real matcher resolve it?" It never writes anything - not to
// products/product_aliases, and NEVER to receipt_ocr_lines/
// receipt_line_matches/receipt_manual_items. It does not look at, and has
// no way to look at, any real receipt at all - it only ever takes evidence
// you explicitly supply (either the three examples below, or your own
// --input=file.json).
//
// WHY THIS EXISTS: after importing/expanding the catalog
// (import-product-catalog.mjs), it's useful to know in advance which of
// today's known "unknown" receipt lines a catalog update would actually
// resolve, WITHOUT touching any historical receipt - Stage 6's own rule
// ("a finalized receipt's classification never changes on its own") means
// nothing here ever should, or does, reach back into receipt_manual_items.
//
// HOW MATCHING IS EVALUATED: reuses the REAL, unmodified matching
// functions from src/services/productMatching.js (matchManualItem,
// normalizeCatalogText) - the exact same plain-JS port of
// productMatcher.ts's cascade that AdminReportDetailScreen.js's live
// product-match modal already uses. This script does not reimplement or
// alter any matching rule. The one small piece of logic this script DOES
// add is a faithful, read-only mirror of Stage 2's own joined-token SKU
// candidate generation (tokenizeCodeText/generateJoinedCandidates in
// supabase/functions/process-receipt/ocrNormalization.ts) - reproduced
// here (not imported - that file is a Deno Edge Function module and can't
// be required from plain Node) so a multi-token ProductCode like
// "600302 8" is tried as "6003028" here exactly the way the real live
// pipeline already would, not a different guess.
//
// USAGE:
//   node check-catalog-coverage.mjs                    # the 3 built-in examples below
//   node check-catalog-coverage.mjs --input=cases.json  # your own evidence records
//
// --input file format: a JSON array of
//   { "label": "A", "productCode": "90294 BK", "description": "..." }
// (barcode is optional - include it only if you separately know a
// candidate barcode for the line; this tool never guesses one from
// productCode/description).
//
// CREDENTIALS: reads SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY from the
// environment, same as import-product-catalog.mjs - a service-role
// connection is used only to SELECT the active catalog; nothing is ever
// written by this script.

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

import { matchManualItem } from '../../src/services/productMatching.js';

// The task's own three live "unknown" examples - used whenever no
// --input file is supplied.
const DEFAULT_EXAMPLES = [
  {
    label: 'A',
    productCode: '90294 BK',
    description: 'מנורת קיר אוריה לשימוש בשבת 3W 3000K 7016D שחור',
  },
  {
    label: 'B',
    productCode: '3',
    description: '50A GOLDEN LIGHT',
  },
  {
    label: 'C',
    productCode: '1',
    description: 'גלאי עשן GD',
  },
];

// Verbatim mirror of ocrNormalization.ts's tokenizeCodeText() - see that
// file for the authoritative version this must stay in sync with.
function tokenizeCodeText(text) {
  return (text ?? '')
    .split(/[\s\r\n]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

// Verbatim mirror of ocrNormalization.ts's generateJoinedCandidates() -
// every contiguous multi-token join, in original order:
// ["600302", "8"] -> ["6003028"]; ["a","b","c"] -> ["ab", "bc", "abc"].
function generateJoinedCandidates(tokens) {
  const joined = [];
  for (let start = 0; start < tokens.length; start += 1) {
    let accumulated = tokens[start];
    for (let end = start + 1; end < tokens.length; end += 1) {
      accumulated += tokens[end];
      joined.push(accumulated);
    }
  }
  return joined;
}

function parseArgs(argv) {
  let inputPath = null;
  for (const arg of argv) {
    if (arg.startsWith('--input=')) {
      inputPath = arg.slice('--input='.length).trim();
    }
  }
  return { inputPath };
}

function loadExamples(inputPath) {
  if (!inputPath) return DEFAULT_EXAMPLES;
  const raw = readFileSync(inputPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`--input file "${inputPath}" must be a JSON array of evidence records.`);
  }
  return parsed;
}

async function loadActiveCatalog(supabase) {
  const { data: productRows, error: productsError } = await supabase
    .from('products')
    .select('id, sku, name, barcode, is_active')
    .eq('is_active', true);
  if (productsError) throw new Error(`Failed to load products: ${productsError.message}`);

  const { data: aliasRows, error: aliasesError } = await supabase
    .from('product_aliases')
    .select('product_id, alias, normalized_alias');
  if (aliasesError) throw new Error(`Failed to load aliases: ${aliasesError.message}`);

  return {
    products: (productRows ?? []).map((p) => ({ id: p.id, sku: p.sku, name: p.name, barcode: p.barcode, isActive: p.is_active })),
    aliases: (aliasRows ?? []).map((a) => ({ productId: a.product_id, alias: a.alias, normalizedAlias: a.normalized_alias })),
  };
}

// Runs the REAL matcher against every distinct candidate code derived from
// productCode (individual tokens, then joined multi-token candidates - a
// direct mirror of Stage 2's own candidate set, see the header above),
// plus once against the description alone (covers alias-exact/
// description-exact/description-fuzzy, none of which depend on a code at
// all). Returns every attempt that produced anything other than a plain
// unmatched, so the report can show EXACTLY which piece of evidence (if
// any) resolves the line - never a black-box yes/no.
function checkCoverage(example, catalog) {
  const tokens = tokenizeCodeText(example.productCode);
  const joinedCandidates = generateJoinedCandidates(tokens);
  const barcodeCandidate = example.barcode ? [example.barcode] : [];

  const attempts = [];

  for (const code of [...new Set([...tokens, ...joinedCandidates, ...barcodeCandidate])]) {
    const kind = joinedCandidates.includes(code)
      ? 'joined_sku_candidate'
      : barcodeCandidate.includes(code)
        ? 'supplied_barcode'
        : 'individual_token';
    const result = matchManualItem({ description: null, code }, catalog);
    if (result.status !== 'unmatched') {
      attempts.push({ kind, candidate: code, result });
    }
  }

  const descriptionResult = matchManualItem({ description: example.description, code: null }, catalog);
  if (descriptionResult.status !== 'unmatched') {
    attempts.push({ kind: 'description_alias_or_name', candidate: example.description, result: descriptionResult });
  }

  const matched = attempts.find((a) => a.result.status === 'matched');
  const needsReview = attempts.filter((a) => a.result.status === 'needs_review');

  return {
    tokens,
    joinedCandidates,
    attempts,
    verdict: matched ? 'resolvable' : needsReview.length > 0 ? 'candidate_only' : 'unknown',
    matched: matched ?? null,
    needsReview,
  };
}

function printReport(results, connected) {
  console.log('\n================ Golden Light catalog coverage check ================\n');

  if (!connected) {
    console.log('No database connection - set SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY to run this for real.\n');
    return;
  }

  for (const { example, coverage } of results) {
    console.log(`[${example.label ?? '?'}] productCode="${example.productCode ?? ''}" description="${example.description ?? ''}"`);
    console.log(`  tokens: ${JSON.stringify(coverage.tokens)}  joined candidates: ${JSON.stringify(coverage.joinedCandidates)}`);

    if (coverage.verdict === 'resolvable') {
      const { kind, candidate, result } = coverage.matched;
      console.log(`  RESOLVABLE - matched via ${kind} ("${candidate}") -> sku=${result.productId ? '(see catalog)' : ''} method=${result.method} confidence=${result.confidence}`);
    } else if (coverage.verdict === 'candidate_only') {
      console.log(`  CANDIDATE ONLY (needs_review, not an exact match) - ${coverage.needsReview.length} candidate group(s):`);
      for (const a of coverage.needsReview) {
        console.log(`    via ${a.kind} ("${a.candidate}"): reason=${a.result.reviewReason}, ${a.result.candidates.length} candidate product(s)`);
      }
    } else {
      console.log('  UNKNOWN - no exact SKU, joined SKU, barcode, alias, or name match in the current catalog. This does NOT mean "not Golden Light" - see Stage 6.');
    }
    console.log('');
  }

  console.log('Note: this is a coverage diagnostic only. It never reads or writes any real receipt/receipt_manual_items row, and never retroactively changes a finalized receipt\'s classification.');
  console.log('\n========================================================================\n');
}

async function main() {
  const { inputPath } = parseArgs(process.argv.slice(2));
  const examples = loadExamples(inputPath);

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    printReport([], false);
    return;
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const catalog = await loadActiveCatalog(supabase);

  const results = examples.map((example) => ({ example, coverage: checkCoverage(example, catalog) }));
  printReport(results, true);
}

main().catch((error) => {
  console.error('Coverage check failed:', error);
  process.exitCode = 1;
});