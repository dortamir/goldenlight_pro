// Repeatable Golden Light product catalog importer - Stage 7.
//
// WHAT THIS IS: a standalone Node script, deliberately separate from the
// Expo app (see package.json in this folder) and from the SQL migrations
// (see supabase/migrations/018_product_catalog_foundation.sql). Schema
// changes belong in a migration; importing/updating the actual product
// data belongs here, run whenever a new or updated official source exists
// - never hardcoded into a migration, and never inferred from OCR/receipt
// data (this script has no concept of a receipt - it only ever reads an
// explicitly-supplied official source file).
//
// TWO INPUT FORMATS, both funnel into the same validation/import pipeline:
//
// 1. Family Excel files (unchanged from before Stage 7 - the real
//    GBOX.xlsx/GSWITCH.xlsx/GTECH.xlsx files continue to work exactly as
//    they did):
//
//      node import-product-catalog.mjs GBOX="../../../GBOX.xlsx" GSWITCH="../../../GSWITCH.xlsx"
//
// 2. The Stage 7 canonical JSON catalog format (see readJsonCatalogFile()
//    below for the exact shape) - for official data delivered as
//    structured records rather than a positional spreadsheet, and the only
//    format that can carry aliases[]:
//
//      node import-product-catalog.mjs --json="../../../golden-light-catalog.json"
//
// Both forms can be combined in one run (e.g. --json for a new family that
// also has known aliases, alongside existing family Excel files) - append
// --dry-run to preview without connecting, or omit it (with real
// credentials in the environment) to actually write.
//
// CREDENTIALS: reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the
// environment (e.g. `SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node
// import-product-catalog.mjs ...`, or a local .env this script does NOT
// read automatically - export them in your shell first). The service-role
// key is required because public.products/product_aliases grant NO
// insert/update access to the anon or authenticated role
// (018_product_catalog_foundation.sql) - this is intentional: catalog
// writes are trusted/backend only, never reachable from the mobile app.
// This key must never be committed, never hardcoded, and never bundled
// into the Expo app - this script lives under supabase/scripts, entirely
// outside the app's own bundle.
//
// DRY RUN: `--dry-run` always previews without connecting or writing.
// Missing credentials ALSO forces a (file-only) dry run automatically,
// exactly as before. The difference from the pre-Stage-7 script: when
// credentials ARE available and --dry-run is passed, this script now
// CONNECTS READ-ONLY (SELECT only, never INSERT/UPDATE) to compare the
// source file(s) against the live catalog and report exactly what an
// apply run would do - new products, unchanged products, products that
// would be enriched (and with which fields), SKU conflicts, duplicate/
// ambiguous barcodes, aliases that would be inserted, and duplicate/
// conflicting aliases. Without credentials, only the file-level checks
// (malformed rows, in-batch duplicates/conflicts, missing barcodes) can be
// reported - there is no live catalog to compare against.
//
// CONFLICT-SAFE UPSERT STRATEGY (Stage 7 - replaces the old blind
// upsert-on-sku from before this stage): existing SKU with IDENTICAL data
// -> no-op. Existing SKU where the source only supplies data for
// currently-NULL fields -> enrichment, only those specific fields are
// written. Existing SKU where the source supplies a DIFFERENT value for a
// field that already has a real value -> conflict - NOTHING is written
// for that SKU (not even its otherwise-safe enrichable fields), and it is
// reported in full so a human can decide. New SKU -> inserted as an
// active Golden Light product. Nothing is ever deleted or deactivated by
// this script - is_active only defaults to true for a brand-new product;
// an existing product's is_active is never silently changed (see
// classifyRow() below) - deactivation remains an explicit, separate admin
// decision this script does not make.

import { createClient } from '@supabase/supabase-js';
import XLSX from 'xlsx';
import { readFileSync } from 'node:fs';

import { normalizeCatalogText } from '../../src/services/productMatching.js';

const REQUIRED_BRAND = 'Golden Light';

function parseArgs(argv) {
  const excelFiles = [];
  const jsonFiles = [];
  let dryRun = false;

  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg.startsWith('--json=')) {
      const path = arg.slice('--json='.length).trim();
      if (!path) {
        throw new Error(`Malformed --json argument: "${arg}".`);
      }
      jsonFiles.push(path);
      continue;
    }
    const eqIndex = arg.indexOf('=');
    if (eqIndex <= 0) {
      throw new Error(`Unrecognized argument "${arg}" - expected FAMILY=path/to/file.xlsx, --json=path/to/file.json, or --dry-run.`);
    }
    const family = arg.slice(0, eqIndex).trim();
    const path = arg.slice(eqIndex + 1).trim();
    if (!family || !path) {
      throw new Error(`Malformed FAMILY=path argument: "${arg}".`);
    }
    excelFiles.push({ family, path });
  }

  return { excelFiles, jsonFiles, dryRun };
}

// --- Reading: Excel family files (unchanged from before Stage 7) -----------

// Reads one family file. Columns are read by POSITION, not by header text
// - every known source file uses [item_code, description, barcode] in
// that order, but the header LABEL on the third column is unreliable:
// GTECH's header literally says "מחיר יציאה" ("exit price"), but its
// actual values are 13-digit barcode-shaped numbers identical in shape to
// GBOX/GSWITCH's real barcodes (verified by inspecting every GTECH row -
// none of them look like a plausible ₪ price). This script deliberately
// treats GTECH's third column as `barcode`, matching what the data
// actually is rather than what its header claims - documented here rather
// than silently assumed. No pricing data or architecture is introduced
// anywhere by this script.
function readFamilyFile(family, path) {
  const workbook = XLSX.readFile(path);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
  const dataRows = rows.slice(1); // skip header row

  return dataRows.map((row, index) => {
    const [itemCodeRaw, descriptionRaw, barcodeRaw] = row;
    const sku = itemCodeRaw != null ? String(itemCodeRaw).trim() : '';
    const name = descriptionRaw != null ? String(descriptionRaw).trim() : '';
    const barcodeText = barcodeRaw != null ? String(barcodeRaw).trim() : '';

    if (!sku || !name) {
      return {
        valid: false,
        source: `${family} (Excel)`,
        position: `row ${index + 2}`, // +1 header, +1 one-based
        reason: 'missing sku or name',
        raw: { sku, name },
      };
    }

    return {
      valid: true,
      source: `${family} (Excel)`,
      position: `row ${index + 2}`,
      sku,
      name,
      barcode: barcodeText || null,
      brand: null, // not supplied by this source - DB default applies on insert, never touched on an existing row
      category: null, // not supplied by this source
      productFamily: family,
      isActive: true, // this source format has no concept of inactive - see module header
      aliases: [], // this source format carries no alias data
    };
  });
}

// --- Reading: Stage 7 canonical JSON catalog format -------------------------
//
// A plain JSON array of objects. Required (because public.products itself
// requires them - see 004_create_product_catalog.sql/018_product_catalog_
// foundation.sql): sku, name, product_family - all as JSON STRINGS (a bare
// JSON number is rejected outright, never coerced - see validateJsonRow()
// below; this is what guarantees a SKU like "0041" keeps its leading zero,
// since JSON numbers cannot even syntactically carry one).
//
// Optional (fill in only what you actually know - never guess): barcode
// (string or null - "legitimately has no barcode" per the task's own
// rule), brand (string - must be exactly "Golden Light" if supplied at
// all, since this importer is scoped to the Golden Light catalog only;
// omit it and the database's own default applies), category (string),
// is_active (boolean, defaults to true for a brand-new product; see
// classifyRow() for why an existing product's is_active is never silently
// changed by this script), aliases (array of non-empty strings - alternate
// official/common names for this SAME product; never auto-generated from
// OCR text, always exactly what the source file says).
//
// Example:
// [
//   {
//     "sku": "6003028",
//     "name": "לוח חשמל תחת הטיח 54 מודול GBOX",
//     "barcode": "0602697128922",
//     "brand": "Golden Light",
//     "category": "לוחות חשמל",
//     "product_family": "GBOX",
//     "is_active": true,
//     "aliases": ["לוח 54 מודול", "GBOX 54 מודול"]
//   }
// ]
function readJsonCatalogFile(path) {
  const raw = readFileSync(path, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse JSON catalog file "${path}": ${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`JSON catalog file "${path}" must be a top-level array of product objects.`);
  }

  return parsed.map((entry, index) => validateJsonRow(entry, index, path));
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateJsonRow(entry, index, sourceFile) {
  const position = `entry ${index + 1}`;
  const source = `${sourceFile} (JSON)`;

  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { valid: false, source, position, reason: 'entry is not an object', raw: entry };
  }

  // "Hard" failures reject the WHOLE row (never imported) - missing
  // required fields, or a field whose value/type is structurally wrong
  // (Section 9's "malformed required structure"/"invalid boolean/state
  // fields"). "Soft" issues (an individual bad alias entry within an
  // otherwise-fine aliases array) only drop that one alias and are
  // reported as a warning on an otherwise-valid, still-imported row -
  // never enough on their own to reject the whole product.
  const hardReasons = [];
  const softWarnings = [];

  if (!isNonEmptyString(entry.sku)) {
    hardReasons.push(typeof entry.sku === 'number' ? 'sku must be a JSON string, not a number (leading zeros would be lost)' : 'missing/empty sku');
  }
  if (!isNonEmptyString(entry.name)) {
    hardReasons.push('missing/empty name');
  }
  if (!isNonEmptyString(entry.product_family)) {
    hardReasons.push('missing/empty product_family');
  }
  if (entry.barcode !== undefined && entry.barcode !== null && !isNonEmptyString(entry.barcode)) {
    hardReasons.push('barcode must be a non-empty string or null');
  }
  if (entry.brand !== undefined && entry.brand !== null) {
    if (!isNonEmptyString(entry.brand)) {
      hardReasons.push('brand must be a non-empty string if supplied');
    } else if (entry.brand.trim() !== REQUIRED_BRAND) {
      hardReasons.push(`brand "${entry.brand}" is not "${REQUIRED_BRAND}" - this importer only accepts Golden Light catalog data`);
    }
  }
  if (entry.category !== undefined && entry.category !== null && !isNonEmptyString(entry.category)) {
    hardReasons.push('category must be a non-empty string if supplied');
  }
  if (entry.is_active !== undefined && typeof entry.is_active !== 'boolean') {
    hardReasons.push('is_active must be a real boolean (true/false) if supplied');
  }
  let aliases = [];
  if (entry.aliases !== undefined) {
    if (!Array.isArray(entry.aliases)) {
      hardReasons.push('aliases must be an array of strings if supplied');
    } else {
      aliases = entry.aliases.filter((alias) => isNonEmptyString(alias)).map((alias) => alias.trim());
      const invalidAliasCount = entry.aliases.length - aliases.length;
      if (invalidAliasCount > 0) {
        softWarnings.push(`${invalidAliasCount} alias entr${invalidAliasCount === 1 ? 'y is' : 'ies are'} blank/not a string and will be skipped`);
      }
    }
  }

  if (hardReasons.length > 0) {
    return { valid: false, source, position, reason: hardReasons.join('; '), raw: entry };
  }

  return {
    valid: true,
    source,
    position,
    sku: entry.sku.trim(),
    name: entry.name.trim(),
    barcode: isNonEmptyString(entry.barcode) ? entry.barcode.trim() : null,
    brand: isNonEmptyString(entry.brand) ? entry.brand.trim() : null,
    category: isNonEmptyString(entry.category) ? entry.category.trim() : null,
    productFamily: entry.product_family.trim(),
    isActive: entry.is_active === undefined ? true : entry.is_active,
    aliases,
    // Non-fatal issues (bad alias entries, etc.) on an otherwise-valid row -
    // surfaced in the report, never silently dropped.
    warnings: softWarnings,
  };
}

// --- Batch-level analysis: malformed rows, missing barcodes, in-batch ------
// --- SKU conflicts, in-batch duplicate barcodes -----------------------------

// Two rows for the same SKU are "equivalent" if every field that BOTH rows
// actually specify agrees - a row that simply omits a field (leaves it
// null/unset) never conflicts with another row's real value for that same
// field; only two ACTUAL differing values conflict. isActive is
// deliberately excluded from this comparison - see classifyRow() below for
// why is_active is never part of conflict detection.
function rowsAreEquivalent(a, b) {
  const fields = ['name', 'barcode', 'brand', 'category', 'productFamily'];
  return fields.every((field) => {
    if (a[field] == null || b[field] == null) return true;
    return a[field] === b[field];
  });
}

function analyzeBatch(allRows) {
  const malformed = allRows.filter((row) => !row.valid);
  const valid = allRows.filter((row) => row.valid);

  const missingBarcode = valid.filter((row) => !row.barcode);

  const skuGroups = new Map();
  for (const row of valid) {
    if (!skuGroups.has(row.sku)) skuGroups.set(row.sku, []);
    skuGroups.get(row.sku).push(row);
  }

  const dedupedRows = [];
  const inBatchConflicts = [];
  for (const [sku, rows] of skuGroups) {
    if (rows.length === 1) {
      dedupedRows.push(rows[0]);
      continue;
    }
    const allEquivalent = rows.every((row, i) => i === 0 || rowsAreEquivalent(rows[0], row));
    if (allEquivalent) {
      // Merge non-null fields across the duplicate rows (a later row may
      // supply a field an earlier one omitted) rather than arbitrarily
      // picking one - still exactly one row per SKU, never a silent pick
      // between genuinely differing data.
      const merged = rows.reduce((acc, row) => ({
        ...acc,
        barcode: acc.barcode ?? row.barcode,
        brand: acc.brand ?? row.brand,
        category: acc.category ?? row.category,
        aliases: [...acc.aliases, ...row.aliases],
      }));
      dedupedRows.push({ ...merged, aliases: Array.from(new Set(merged.aliases)) });
    } else {
      inBatchConflicts.push({ sku, rows });
    }
  }

  const barcodeGroups = new Map();
  for (const row of dedupedRows) {
    if (!row.barcode) continue;
    if (!barcodeGroups.has(row.barcode)) barcodeGroups.set(row.barcode, []);
    barcodeGroups.get(row.barcode).push(row);
  }
  const duplicateBarcodesInBatch = [...barcodeGroups.entries()].filter(([, rows]) => rows.length > 1);

  return { malformed, missingBarcode, dedupedRows, inBatchConflicts, duplicateBarcodesInBatch };
}

// --- Classification against the live catalog (dry-run and apply share this) -

const ENRICHABLE_FIELDS = [
  { key: 'name', column: 'name' },
  { key: 'barcode', column: 'barcode' },
  { key: 'brand', column: 'brand' },
  { key: 'category', column: 'category' },
  { key: 'productFamily', column: 'product_family' },
];

// existingRow: the current public.products row for this SKU, or null/
// undefined for a brand-new SKU. Returns one of:
//   { category: 'new', payload: {...} }                     - insert
//   { category: 'unchanged' }                                - no-op
//   { category: 'enrich', patch: {...}, filledFields: [...] } - targeted update
//   { category: 'conflict', conflicts: [{ field, existing, incoming }] } - hold, no write
//
// is_active is deliberately NEVER compared/enriched/conflicted for an
// EXISTING row - only a brand-new row's is_active (explicit or the true
// default) is ever written. This is what makes "deactivation must be
// explicit" and "do not delete/deactivate merely because a product is
// absent from one import" true by construction: nothing in this function
// can ever change an existing row's is_active, in either direction.
function classifyRow(row, existingRow) {
  if (!existingRow) {
    return {
      category: 'new',
      payload: {
        sku: row.sku,
        name: row.name,
        barcode: row.barcode,
        ...(row.brand ? { brand: row.brand } : {}),
        category: row.category,
        product_family: row.productFamily,
        is_active: row.isActive,
      },
    };
  }

  const patch = {};
  const filledFields = [];
  const conflicts = [];

  for (const { key, column } of ENRICHABLE_FIELDS) {
    const incoming = row[key];
    if (incoming == null) continue; // no new information supplied - never touch this field
    const existing = existingRow[column];
    if (existing == null) {
      patch[column] = incoming;
      filledFields.push(column);
    } else if (existing !== incoming) {
      conflicts.push({ field: column, existing, incoming });
    }
  }

  if (conflicts.length > 0) {
    return { category: 'conflict', conflicts };
  }
  if (Object.keys(patch).length > 0) {
    return { category: 'enrich', patch, filledFields };
  }
  return { category: 'unchanged' };
}

// --- Alias planning ----------------------------------------------------------

// Only ever called for a row that is NOT in conflict - a conflicted
// product's aliases are held back this run too, exactly like its product
// fields, so the whole SKU stays a single reviewable unit.
function planAliasesForRow(row, productId, existingAliasesByNormalized, stagedNormalizedAliases) {
  const toInsert = [];
  const duplicates = [];
  const conflicts = [];

  for (const alias of row.aliases) {
    const normalized = normalizeCatalogText(alias);
    if (!normalized) {
      continue; // already filtered at read time, defensive only
    }

    const existing = existingAliasesByNormalized.get(normalized);
    if (existing) {
      if (existing.product_id === productId) {
        duplicates.push({ sku: row.sku, alias, reason: 'already exists for this exact product' });
      } else {
        conflicts.push({ sku: row.sku, alias, reason: `already assigned to a different product (${existing.product_id})` });
      }
      continue;
    }

    const stagedFor = stagedNormalizedAliases.get(normalized);
    if (stagedFor && stagedFor !== row.sku) {
      conflicts.push({ sku: row.sku, alias, reason: `also claimed by SKU ${stagedFor} earlier in this same batch` });
      continue;
    }
    if (stagedFor === row.sku) {
      duplicates.push({ sku: row.sku, alias, reason: 'duplicate alias within this same batch for this product' });
      continue;
    }

    stagedNormalizedAliases.set(normalized, row.sku);
    toInsert.push({ productId, sku: row.sku, alias, normalized });
  }

  return { toInsert, duplicates, conflicts };
}

// --- Reporting -----------------------------------------------------------------

function printReport({ analysis, classified, aliasPlan, barcodeAmbiguity, connected, applyResult }) {
  console.log('\n================ Golden Light product catalog import report ================\n');

  console.log(`Malformed/invalid rows (never imported): ${analysis.malformed.length}`);
  for (const row of analysis.malformed) {
    console.log(`  [${row.source} ${row.position}] ${row.reason}`);
  }

  const warned = analysis.dedupedRows.filter((row) => row.warnings && row.warnings.length > 0);
  if (warned.length > 0) {
    console.log(`\nRows imported with non-fatal warnings: ${warned.length}`);
    for (const row of warned) {
      console.log(`  [${row.source} ${row.position}] sku=${row.sku}: ${row.warnings.join('; ')}`);
    }
  }

  console.log(`\nRows with no barcode supplied (barcode stays null): ${analysis.missingBarcode.length}`);

  console.log(`\nIn-batch SKU conflicts (same SKU, differing data across rows - EXCLUDED from import): ${analysis.inBatchConflicts.length}`);
  for (const { sku, rows } of analysis.inBatchConflicts) {
    console.log(`  sku ${sku}:`);
    for (const row of rows) {
      console.log(`    [${row.source} ${row.position}] name="${row.name}" barcode=${row.barcode ?? 'null'} family=${row.productFamily}`);
    }
  }

  console.log(`\nDuplicate barcodes within this batch (all rows still imported - informational only): ${analysis.duplicateBarcodesInBatch.length}`);
  for (const [barcode, rows] of analysis.duplicateBarcodesInBatch) {
    console.log(`  barcode ${barcode}: ${rows.map((r) => r.sku).join(', ')}`);
  }

  if (!connected) {
    console.log('\nNo database connection was made (dry run without live comparison) - the categorization below only reflects the source file(s) themselves.');
    console.log(`Rows that would be sent for import (after in-batch de-duplication): ${analysis.dedupedRows.length}`);
    console.log('\n===============================================================================\n');
    return;
  }

  console.log(`\nNew products (would be inserted): ${classified.new.length}`);
  for (const row of classified.new) {
    console.log(`  sku=${row.sku} name="${row.name}" family=${row.productFamily}`);
  }

  console.log(`\nUnchanged products (already fully up to date, no write): ${classified.unchanged.length}`);

  console.log(`\nProducts that would be enriched (currently-null fields filled in): ${classified.enrich.length}`);
  for (const { row, result } of classified.enrich) {
    console.log(`  sku=${row.sku}: filling ${result.filledFields.join(', ')}`);
  }

  console.log(`\nSKU conflicts against the LIVE catalog (existing value differs - NOTHING written for these SKUs): ${classified.conflict.length}`);
  for (const { row, result } of classified.conflict) {
    console.log(`  sku=${row.sku} [${row.source} ${row.position}]:`);
    for (const c of result.conflicts) {
      console.log(`    ${c.field}: existing="${c.existing}" vs incoming="${c.incoming}"`);
    }
  }

  if (barcodeAmbiguity.length > 0) {
    console.log(`\nBarcodes shared with a DIFFERENT existing product (informational only, not blocked): ${barcodeAmbiguity.length}`);
    for (const entry of barcodeAmbiguity) {
      console.log(`  barcode ${entry.barcode}: incoming sku=${entry.incomingSku} already used by existing sku=${entry.existingSku}`);
    }
  }

  console.log(`\nAliases that would be inserted: ${aliasPlan.toInsert.length}`);
  for (const a of aliasPlan.toInsert) {
    console.log(`  sku=${a.sku}: "${a.alias}"`);
  }
  console.log(`\nDuplicate aliases (already present, no-op): ${aliasPlan.duplicates.length}`);
  for (const a of aliasPlan.duplicates) {
    console.log(`  sku=${a.sku}: "${a.alias}" - ${a.reason}`);
  }
  console.log(`\nAlias conflicts (claimed by a different product - NOT inserted): ${aliasPlan.conflicts.length}`);
  for (const a of aliasPlan.conflicts) {
    console.log(`  sku=${a.sku}: "${a.alias}" - ${a.reason}`);
  }

  if (applyResult) {
    if (applyResult.dryRun) {
      console.log('\nDRY RUN - no rows were written. Run again without --dry-run (with SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY set) to apply exactly the changes reported above.');
    } else if (applyResult.error) {
      console.log(`\nIMPORT FAILED: ${applyResult.error}`);
    } else {
      console.log('\nImport applied:');
      console.log(`  Inserted: ${applyResult.insertedCount}`);
      console.log(`  Enriched: ${applyResult.enrichedCount}`);
      console.log(`  Aliases inserted: ${applyResult.aliasesInsertedCount}`);
      console.log(`  Skipped (SKU conflicts, unresolved): ${classified.conflict.length}`);
      console.log(`  Skipped (alias conflicts, unresolved): ${aliasPlan.conflicts.length}`);
    }
  }

  console.log('\n===============================================================================\n');
}

// --- Supabase I/O (read-only for dry-run-with-credentials, read+write for apply) -

async function loadExistingProducts(supabase, skus) {
  const { data, error } = await supabase
    .from('products')
    .select('id, sku, name, barcode, brand, category, product_family, is_active')
    .in('sku', skus);
  if (error) throw new Error(`Failed to load existing products: ${error.message}`);
  const bySku = new Map();
  for (const row of data ?? []) bySku.set(row.sku, row);
  return bySku;
}

async function loadExistingAliases(supabase, normalizedAliases) {
  if (normalizedAliases.length === 0) return new Map();
  const { data, error } = await supabase
    .from('product_aliases')
    .select('product_id, alias, normalized_alias')
    .in('normalized_alias', normalizedAliases);
  if (error) throw new Error(`Failed to load existing aliases: ${error.message}`);
  const byNormalized = new Map();
  for (const row of data ?? []) byNormalized.set(row.normalized_alias, row);
  return byNormalized;
}

async function computeBarcodeAmbiguity(supabase, dedupedRows) {
  const barcodes = Array.from(new Set(dedupedRows.filter((r) => r.barcode).map((r) => r.barcode)));
  if (barcodes.length === 0) return [];
  const { data, error } = await supabase.from('products').select('sku, barcode').in('barcode', barcodes);
  if (error) throw new Error(`Failed to check barcode ambiguity: ${error.message}`);

  const ambiguity = [];
  for (const row of dedupedRows) {
    if (!row.barcode) continue;
    const existingWithSameBarcode = (data ?? []).filter((p) => p.barcode === row.barcode && p.sku !== row.sku);
    for (const existing of existingWithSameBarcode) {
      ambiguity.push({ barcode: row.barcode, incomingSku: row.sku, existingSku: existing.sku });
    }
  }
  return ambiguity;
}

async function applyChanges(supabase, classified, aliasPlan) {
  let insertedCount = 0;
  let enrichedCount = 0;
  let aliasesInsertedCount = 0;

  const skuToProductId = new Map();

  if (classified.new.length > 0) {
    const { data, error } = await supabase
      .from('products')
      .insert(classified.new.map((row) => row.payload))
      .select('id, sku');
    if (error) throw new Error(`Insert failed: ${error.message}`);
    for (const row of data ?? []) skuToProductId.set(row.sku, row.id);
    insertedCount = data?.length ?? 0;
  }

  for (const { row, result } of classified.enrich) {
    const { error } = await supabase.from('products').update(result.patch).eq('sku', row.sku);
    if (error) throw new Error(`Enrich failed for sku ${row.sku}: ${error.message}`);
    enrichedCount += 1;
  }

  if (aliasPlan.toInsert.length > 0) {
    const rows = aliasPlan.toInsert.map((a) => ({
      product_id: skuToProductId.get(a.sku) ?? a.productId,
      alias: a.alias,
    }));
    const { data, error } = await supabase.from('product_aliases').insert(rows).select('id');
    if (error) throw new Error(`Alias insert failed: ${error.message}`);
    aliasesInsertedCount = data?.length ?? 0;
  }

  return { dryRun: false, insertedCount, enrichedCount, aliasesInsertedCount };
}

async function main() {
  const { excelFiles, jsonFiles, dryRun } = parseArgs(process.argv.slice(2));

  if (excelFiles.length === 0 && jsonFiles.length === 0) {
    console.error(
      'Usage: node import-product-catalog.mjs FAMILY=path/to/file.xlsx [FAMILY2=path2.xlsx ...] [--json=path/to/catalog.json ...] [--dry-run]',
    );
    process.exitCode = 1;
    return;
  }

  const allRows = [];
  for (const { family, path } of excelFiles) {
    allRows.push(...readFamilyFile(family, path));
  }
  for (const path of jsonFiles) {
    allRows.push(...readJsonCatalogFile(path));
  }

  const analysis = analyzeBatch(allRows);

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const canConnect = Boolean(supabaseUrl && serviceRoleKey);

  if (!canConnect) {
    printReport({ analysis, connected: false });
    return;
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const skus = analysis.dedupedRows.map((r) => r.sku);
  const existingBySku = await loadExistingProducts(supabase, skus);

  const classified = { new: [], unchanged: [], enrich: [], conflict: [] };
  for (const row of analysis.dedupedRows) {
    const result = classifyRow(row, existingBySku.get(row.sku));
    if (result.category === 'new') classified.new.push({ ...row, payload: result.payload });
    else if (result.category === 'unchanged') classified.unchanged.push(row);
    else if (result.category === 'enrich') classified.enrich.push({ row, result });
    else classified.conflict.push({ row, result });
  }

  const barcodeAmbiguity = await computeBarcodeAmbiguity(supabase, analysis.dedupedRows);

  // Aliases: only for rows that are not held back by a SKU conflict. A
  // brand-new row's product_id isn't known until after insert (apply mode
  // only) - dry-run reports alias plans using a placeholder so the SAME
  // codepath can preview them before any product actually exists yet.
  const aliasableRows = [...classified.new.map((r) => ({ row: r, productId: null })), ...classified.unchanged.map((row) => ({ row, productId: existingBySku.get(row.sku)?.id })), ...classified.enrich.map(({ row }) => ({ row, productId: existingBySku.get(row.sku)?.id }))];

  const allNormalizedAliases = Array.from(
    new Set(aliasableRows.flatMap(({ row }) => row.aliases.map((a) => normalizeCatalogText(a))).filter(Boolean)),
  );
  const existingAliasesByNormalized = await loadExistingAliases(supabase, allNormalizedAliases);

  const aliasPlan = { toInsert: [], duplicates: [], conflicts: [] };
  const stagedNormalizedAliases = new Map();
  for (const { row, productId } of aliasableRows) {
    if (row.aliases.length === 0) continue;
    const plan = planAliasesForRow(row, productId, existingAliasesByNormalized, stagedNormalizedAliases);
    aliasPlan.toInsert.push(...plan.toInsert);
    aliasPlan.duplicates.push(...plan.duplicates);
    aliasPlan.conflicts.push(...plan.conflicts);
  }
  for (const { row } of classified.conflict) {
    if (row.aliases.length > 0) {
      aliasPlan.conflicts.push(
        ...row.aliases.map((alias) => ({ sku: row.sku, alias, reason: 'product itself has an unresolved SKU conflict - resolve it first' })),
      );
    }
  }

  let applyResult;
  if (dryRun) {
    applyResult = { dryRun: true };
  } else {
    try {
      applyResult = await applyChanges(supabase, classified, aliasPlan);
    } catch (err) {
      applyResult = { dryRun: false, error: err.message };
    }
  }

  printReport({ analysis, classified, aliasPlan, barcodeAmbiguity, connected: true, applyResult });

  if (applyResult && applyResult.error) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Import failed:', error);
  process.exitCode = 1;
});