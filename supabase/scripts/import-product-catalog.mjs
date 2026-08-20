// Repeatable Golden Light product catalog importer.
//
// WHAT THIS IS: a standalone Node script, deliberately separate from the
// Expo app (see package.json in this folder) and from the SQL migrations
// (see supabase/migrations/018_product_catalog_foundation.sql). Schema
// changes belong in a migration; importing/updating the actual 211+ rows
// of product data belongs here, run whenever a new or updated source file
// exists - never hardcoded into a migration.
//
// WHAT IT DOES: reads one or more family Excel files (GBOX.xlsx,
// GSWITCH.xlsx, GTECH.xlsx today - more families can be added later by
// passing more files, no code change needed), validates every row,
// reports every data-quality issue found (missing barcode, duplicate
// barcode, duplicate item_code, malformed row) WITHOUT ever silently
// dropping a row, and upserts the result into public.products keyed on
// the official item_code (stored in the `sku` column - see the migration
// for why the column keeps its existing name).
//
// USAGE (run from this directory, after `npm install`):
//
//   node import-product-catalog.mjs GBOX="../../../GBOX.xlsx" GSWITCH="../../../GSWITCH.xlsx" GTECH="../../../GTECH.xlsx"
//
// Each positional argument is FAMILY=path/to/file.xlsx - the family name
// is never inferred from the filename, so it's always explicit. Repeat
// for as many family files as needed; a future NEW family just needs one
// more FAMILY=path argument, no code change.
//
// CREDENTIALS: reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the
// environment (e.g. `SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node
// import-product-catalog.mjs ...`, or a local .env this script does NOT
// read automatically - export them in your shell first). The service-role
// key is required because public.products/product_aliases grant NO
// insert/update access to the anon or authenticated role (see the
// migration) - this is intentional: catalog writes are trusted/backend
// only, never reachable from the mobile app. This key must never be
// committed, never hardcoded, and never bundled into the Expo app.
//
// DRY RUN: if the credentials are missing, or --dry-run is passed
// explicitly, the script parses and validates every source file and
// prints the full report below WITHOUT connecting to Supabase at all - no
// row is inserted or updated. This is the safe way to preview a new/
// updated source file before actually importing it.
//
// UPSERT STRATEGY: every row is upserted on `sku` (the item_code) -
// existing sku -> description/barcode/product_family/is_active are
// updated to the new file's values; new sku -> a new row is inserted.
// is_active is always set to true by this script - marking a product
// inactive (e.g. discontinued, no longer in the source file) is an
// intentional admin decision this script does not make automatically; a
// future admin UI stage will handle that explicitly (see
// AGENTS/task notes - "Admin product management" is explicitly NOT built
// in this stage).

import { createClient } from '@supabase/supabase-js';
import XLSX from 'xlsx';

function parseArgs(argv) {
  const files = [];
  let dryRun = false;

  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    const eqIndex = arg.indexOf('=');
    if (eqIndex <= 0) {
      throw new Error(`Unrecognized argument "${arg}" - expected FAMILY=path/to/file.xlsx or --dry-run.`);
    }
    const family = arg.slice(0, eqIndex).trim();
    const path = arg.slice(eqIndex + 1).trim();
    if (!family || !path) {
      throw new Error(`Malformed FAMILY=path argument: "${arg}".`);
    }
    files.push({ family, path });
  }

  return { files, dryRun };
}

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
    const itemCode = itemCodeRaw != null ? String(itemCodeRaw).trim() : '';
    const description = descriptionRaw != null ? String(descriptionRaw).trim() : '';
    const barcodeText = barcodeRaw != null ? String(barcodeRaw).trim() : '';

    return {
      family,
      sourceFile: path,
      rowNumber: index + 2, // +1 for header row, +1 for 1-based row numbers
      itemCode,
      description,
      barcode: barcodeText || null,
    };
  });
}

// Validates every row, separating malformed rows (never imported, always
// reported) from valid ones, and reports missing-barcode / duplicate-
// barcode / duplicate-item_code data quality issues WITHOUT ever silently
// dropping a row from the report (a duplicate item_code row is still
// reported, even though only its last occurrence is actually imported -
// "last file/row wins" - a real conflict must never be silently resolved
// without saying so).
function analyzeRows(allRows) {
  const malformed = [];
  const valid = [];

  for (const row of allRows) {
    if (!row.itemCode || !row.description) {
      malformed.push(row);
    } else {
      valid.push(row);
    }
  }

  const missingBarcode = valid.filter((row) => !row.barcode);

  const barcodeGroups = new Map();
  for (const row of valid) {
    if (!row.barcode) continue;
    if (!barcodeGroups.has(row.barcode)) barcodeGroups.set(row.barcode, []);
    barcodeGroups.get(row.barcode).push(row);
  }
  const duplicateBarcodes = [...barcodeGroups.entries()].filter(([, rows]) => rows.length > 1);

  const itemCodeGroups = new Map();
  for (const row of valid) {
    if (!itemCodeGroups.has(row.itemCode)) itemCodeGroups.set(row.itemCode, []);
    itemCodeGroups.get(row.itemCode).push(row);
  }
  const duplicateItemCodes = [...itemCodeGroups.entries()].filter(([, rows]) => rows.length > 1);

  // "Last one wins" for the actual import payload when the same item_code
  // appears more than once (e.g. an updated file re-lists an item_code
  // that also appeared earlier in the same batch) - sku is a real unique
  // constraint on public.products, so exactly one row per item_code must
  // be sent. The conflict itself is still fully reported above regardless.
  const dedupedByItemCode = [...itemCodeGroups.values()].map((rows) => rows[rows.length - 1]);

  return { malformed, valid, missingBarcode, duplicateBarcodes, duplicateItemCodes, dedupedByItemCode };
}

function printReport({ perFamilyCounts, totalRows, analysis, writeResult }) {
  console.log('\n================ Golden Light product catalog import report ================\n');

  console.log('Rows parsed per family:');
  for (const [family, count] of perFamilyCounts) {
    console.log(`  ${family}: ${count}`);
  }
  console.log(`  TOTAL: ${totalRows}`);

  console.log(`\nMalformed rows (missing item_code or description - never imported): ${analysis.malformed.length}`);
  for (const row of analysis.malformed) {
    console.log(`  [${row.family} row ${row.rowNumber}] item_code="${row.itemCode}" description="${row.description}"`);
  }

  console.log(`\nRows with missing barcode (imported with barcode = null): ${analysis.missingBarcode.length}`);
  for (const row of analysis.missingBarcode) {
    console.log(`  [${row.family}] item_code=${row.itemCode} ("${row.description}")`);
  }

  console.log(`\nDuplicate barcode conflicts (all rows still imported - not blocked): ${analysis.duplicateBarcodes.length}`);
  for (const [barcode, rows] of analysis.duplicateBarcodes) {
    console.log(`  barcode ${barcode}:`);
    for (const row of rows) {
      console.log(`    [${row.family}] item_code=${row.itemCode} ("${row.description}")`);
    }
  }

  console.log(`\nDuplicate item_code conflicts within this batch (only the LAST occurrence is imported): ${analysis.duplicateItemCodes.length}`);
  for (const [itemCode, rows] of analysis.duplicateItemCodes) {
    console.log(`  item_code ${itemCode}:`);
    for (const row of rows) {
      console.log(`    [${row.family}] "${row.description}" (barcode=${row.barcode ?? 'null'})`);
    }
  }

  console.log(`\nValid rows ready to import (after de-duplication): ${analysis.dedupedByItemCode.length}`);

  if (writeResult) {
    if (writeResult.dryRun) {
      console.log('\nDRY RUN - no database connection was made, nothing was written.');
      console.log('Run again with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY set (and without --dry-run) to actually import.');
    } else if (writeResult.error) {
      console.log(`\nIMPORT FAILED: ${writeResult.error}`);
    } else {
      console.log(`\nImport succeeded:`);
      console.log(`  Inserted (new item_code): ${writeResult.insertedCount}`);
      console.log(`  Updated (existing item_code): ${writeResult.updatedCount}`);
    }
  }

  console.log('\n===============================================================================\n');
}

async function writeToSupabase(payload) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return { dryRun: true };
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const skus = payload.map((row) => row.sku);

  const { data: existingRows, error: selectError } = await supabase
    .from('products')
    .select('sku')
    .in('sku', skus);

  if (selectError) {
    return { dryRun: false, error: selectError.message };
  }

  const existingSkus = new Set((existingRows ?? []).map((row) => row.sku));

  const { error: upsertError } = await supabase
    .from('products')
    .upsert(payload, { onConflict: 'sku' });

  if (upsertError) {
    return { dryRun: false, error: upsertError.message };
  }

  return {
    dryRun: false,
    insertedCount: payload.length - existingSkus.size,
    updatedCount: existingSkus.size,
  };
}

async function main() {
  const { files, dryRun } = parseArgs(process.argv.slice(2));

  if (files.length === 0) {
    console.error('Usage: node import-product-catalog.mjs FAMILY=path/to/file.xlsx [FAMILY2=path2.xlsx ...] [--dry-run]');
    process.exitCode = 1;
    return;
  }

  const allRows = [];
  const perFamilyCounts = [];

  for (const { family, path } of files) {
    const rows = readFamilyFile(family, path);
    allRows.push(...rows);
    perFamilyCounts.push([family, rows.length]);
  }

  const analysis = analyzeRows(allRows);

  const payload = analysis.dedupedByItemCode.map((row) => ({
    sku: row.itemCode,
    name: row.description,
    barcode: row.barcode,
    product_family: row.family,
    is_active: true,
  }));

  let writeResult;
  if (dryRun) {
    writeResult = { dryRun: true };
  } else {
    writeResult = await writeToSupabase(payload);
  }

  printReport({
    perFamilyCounts,
    totalRows: allRows.length,
    analysis,
    writeResult,
  });

  if (writeResult && writeResult.error) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Import failed:', error);
  process.exitCode = 1;
});
