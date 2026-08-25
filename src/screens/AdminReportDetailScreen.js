import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import AdminShell from '../components/admin/AdminShell';
import AppInput from '../components/common/AppInput';
import PrimaryButton from '../components/common/PrimaryButton';
import {
  awardPurchasePoints,
  finalizePurchaseReport,
  getAdminReceiptSignedUrl,
  getAdminReportDetail,
  loadCatalogForMatching,
  rejectAdminReport,
  REVIEWABLE_STATUSES,
  saveAdminManualItems,
} from '../services/adminReportService';
import { getProductSuggestions } from '../services/productMatching';
import { colors, radius, shadows, spacing, typography } from '../theme';
import { isolateLTR } from '../utils/bidiText';

// Below this content width, the manual-entry table collapses to stacked
// fields per row instead of a horizontal table row - a real Hebrew label +
// input pair no longer fits five-across at phone/narrow-tablet widths.
const MANUAL_TABLE_MIN_WIDTH = 720;

// line_total is intentionally NOT part of this form - see
// 016_simplify_eligible_amount_calc.sql (still true: the eligible amount is
// always quantity * unit_price, never line_total). The row has exactly
// these four visible columns - there is no separate SKU/barcode column or
// field anywhere in the row. `row.sku` still exists internally (still sent
// to save_manual_receipt_items(), unchanged from 019) but is never directly
// typed by the admin anymore - it is only ever set by applyProductToRow()
// below, synchronized to whichever product the admin selected in the
// product-match modal, which is the ONE place any catalog lookup (by SKU,
// barcode, or description/name) happens - see getProductSuggestions in
// src/services/productMatching.js.
const MANUAL_COLUMNS = [
  { key: 'description', label: 'תיאור מוצר', flex: 3.4 },
  { key: 'quantity', label: 'כמות', flex: 1.1 },
  { key: 'unit_price', label: 'מחיר ליחידה', flex: 1.5 },
  { key: 'match_status', label: `מוצר ${isolateLTR('Golden Light')}`, flex: 1.3 },
];

let manualRowSeq = 0;
function createEmptyManualRow() {
  manualRowSeq += 1;
  return {
    key: `row-${manualRowSeq}`,
    description: '',
    sku: '',
    quantity: '',
    unit_price: '',
    product_id: null,
    match_type: null,
    match_confidence: null,
    match_status: 'unresolved',
    matched_product_sku: null,
    matched_product_name: null,
    // The admin's own receipt wording, captured right before a selected
    // suggestion overwrote `description` with the catalog's canonical name
    // (see applyProductToRow) - null whenever the typed text already was
    // the canonical name/sku, or nothing has been matched yet. Sent to
    // save_manual_receipt_items() as `alias_source_text` so alias learning
    // keeps working even though `description` itself is now always
    // synchronized to the matched product - see
    // 020_manual_item_alias_source_text.sql.
    alias_candidate_text: null,
  };
}

// Preloads the editable form with the saved rows, or a single empty row
// when none exist yet - "not zero, not multiple blank rows". Shared by the
// always-editable reviewable-report table and the post-approval
// "עריכת טיפול" correction flow. matched_product_sku/matched_product_name
// come from get_admin_manual_items()'s join to public.products
// (019_product_matching_manual_items.sql) - display-only convenience
// fields, never sent back to the server (buildManualItemsPayload below
// never reads them). alias_candidate_text always starts null for a saved
// row - it only exists transiently while editing, between selecting a
// suggestion and saving.
function buildRowsFromManualItems(items) {
  return items && items.length > 0
    ? items.map((item) => ({
        key: item.id,
        description: item.description || '',
        sku: item.sku || '',
        quantity: item.quantity != null ? String(item.quantity) : '',
        unit_price: item.unit_price != null ? String(item.unit_price) : '',
        product_id: item.product_id || null,
        match_type: item.match_type || null,
        match_confidence: item.match_confidence ?? null,
        alias_candidate_text: null,
        match_status: item.match_status || 'unresolved',
        matched_product_sku: item.matched_product_sku || null,
        matched_product_name: item.matched_product_name || null,
      }))
    : [createEmptyManualRow()];
}

// OCR ADMIN REVIEW INTEGRATION (Stage 4): the SEED-ONLY fallback used when
// a report has no receipt_manual_items yet (see loadDetail below - this is
// never called once real manual items exist, matching
// buildRowsFromManualItems' own "authoritative once saved" rule). Builds
// the exact same editable row shape buildRowsFromManualItems/
// createEmptyManualRow/applyProductToRow already use - this is not a
// second row format, just a different initial source for it.
//
// One review row per matchable OCR line (ocrLines - from
// get_admin_ocr_lines(), already includes Stage 2's normalized_* columns)
// joined in memory to its receipt_line_matches row (lineMatches - already
// enriched with matched_product_sku/matched_product_name by
// adminReportService.js, no extra query here). A merged-item PARENT row is
// never shown on its own - same exact check Stage 3's own
// wasMergedParent() uses (normalization_notes.merge.detected === true),
// read-only here, never recomputed differently. Its recovered children
// (their own real OCR lines, no merge key of their own) are never
// filtered out by this check and appear like any other row, in the order
// get_admin_ocr_lines() already returns (line_index ascending - recovered
// children naturally sort after the original rows, since Stage 2 assigns
// them a continuing line_index).
//
// quantity/unit_price prefer Stage 2's normalized_quantity/
// normalized_unit_price, falling back to Stage 1's detected_quantity/
// detected_unit_price only when no normalized value exists - an admin
// must never see the known-wrong original Azure quantity as the main
// editable value once Stage 2 already corrected it (see the task's own
// live example: detected_quantity 195, normalized_quantity 42 - the row
// must show 42).
//
// A 'matched' OCR line (receipt_line_matches.match_status === 'matched'
// AND a real product_id) is prefilled EXACTLY like applyProductToRow()
// already treats a manual selection - description/sku overwritten to the
// matched product's own canonical values, so this row can never violate
// the existing "matched row's description always equals matched_product_
// name" invariant updateManualRow() relies on to detect a stale match.
// match_type is the real Stage 3 match_method (e.g. 'normalized_sku_exact'),
// never 'manual' - alias learning (save_manual_receipt_items(), gated on
// match_type === 'manual') is therefore never triggered by an OCR-driven
// match, only by a genuine admin selection, exactly as before.
//
// Anything NOT confidently 'matched' (Stage 3 'needs_review' or
// 'unmatched' alike - see the Stage 4 task's own CASE B/C, which are
// deliberately identical here: receipt_line_matches never persists a
// candidate product for either state today) becomes 'unresolved' - never
// 'not_golden_light', which stays an explicit admin-only decision. The
// admin uses the exact same product-match modal/search either way.
//
// STAGE 4 FIX: raw_text/normalized_text (receipt_ocr_lines) hold the ENTIRE
// Azure line item's text - SKU, barcode, quantity, unit price, amount, and
// description all concatenated (see ocrProvider.ts's extractInvoiceItems():
// `text = item.content ?? ...`, where item.content is the whole row).
// raw_item (also returned by get_admin_ocr_lines(), see 021/022) is the
// COMPLETE Azure item object for that same row - it always carries a
// structured valueObject.Description field (the actual Azure invoice-item
// Description field, confidence-scored independently of the row's other
// fields), which is what an admin review row's description should show.
// raw_text is only used as a last-resort fallback, for the rare row whose
// raw_item is missing/shaped unexpectedly.
function getOcrLineDescription(line) {
  const descriptionField = line?.raw_item?.valueObject?.Description;
  const structured =
    (typeof descriptionField?.valueString === 'string' && descriptionField.valueString.trim()) ||
    (typeof descriptionField?.content === 'string' && descriptionField.content.trim()) ||
    '';
  return structured || (line?.raw_text || '').trim();
}

function buildRowsFromOcrEvidence(ocrLines, lineMatches) {
  // Keys normalized to String() on both sides of the join - ocr_line_id/id
  // are uuid columns on both receipt_line_matches and the get_admin_ocr_lines()
  // RPC, so they're always plain strings in practice, but this makes the
  // ocr_line_id -> id association robust to either side ever coming back as
  // something other than a bare JS string, without changing behavior for the
  // normal case.
  const matchByOcrLineId = new Map((lineMatches || []).map((match) => [String(match.ocr_line_id), match]));

  const matchableLines = (ocrLines || []).filter((line) => {
    const notes = line.normalization_notes;
    const merge = notes && typeof notes === 'object' ? notes.merge : null;
    return !(merge && merge.detected === true);
  });

  if (matchableLines.length === 0) {
    return [createEmptyManualRow()];
  }

  return matchableLines.map((line) => {
    const match = matchByOcrLineId.get(String(line.id)) || null;
    const isMatched = Boolean(match && match.match_status === 'matched' && match.product_id);
    const ocrDescription = getOcrLineDescription(line);

    const quantity = line.normalized_quantity != null ? line.normalized_quantity : line.detected_quantity;
    const unitPrice = line.normalized_unit_price != null ? line.normalized_unit_price : line.detected_unit_price;

    const base = {
      key: `ocr-${line.id}`,
      quantity: quantity != null ? String(quantity) : '',
      unit_price: unitPrice != null ? String(unitPrice) : '',
      // Prefill-only hint, never sent to save_manual_receipt_items() -
      // buildManualItemsPayload() below never reads this key. Drives the
      // subtle "זוהה ותוקן אוטומטית"-style caption in the row render.
      normalizationStatus: line.normalization_status || null,
    };

    if (isMatched) {
      return {
        ...base,
        description: match.matched_product_name || ocrDescription,
        sku: match.matched_product_sku || '',
        product_id: match.product_id,
        match_type: match.match_method,
        match_confidence: match.confidence,
        match_status: 'matched',
        matched_product_sku: match.matched_product_sku || null,
        matched_product_name: match.matched_product_name || null,
        alias_candidate_text: null,
      };
    }

    return {
      ...base,
      description: ocrDescription,
      sku: '',
      product_id: null,
      match_type: null,
      match_confidence: null,
      match_status: 'unresolved',
      matched_product_sku: null,
      matched_product_name: null,
      alias_candidate_text: null,
    };
  });
}

// Small, non-alarming caption shown under a prefilled row's description -
// never raw confidence/JSON (see the task's own "screen should remain
// clean" rule). null (nothing rendered) for a plain manually-entered row
// or a 'clean'/never-normalized OCR row. Stays visible for the row's
// lifetime once shown (not cleared on edit) - purely informational, never
// blocking, and every field it describes remains fully visible/editable
// either way.
function getOcrNormalizationHint(status) {
  switch (status) {
    case 'corrected':
      return 'זוהה ותוקן אוטומטית - מומלץ לוודא';
    case 'needs_review':
    case 'ambiguous':
      return 'נדרשת בדיקה - הפרטים לא ודאיים';
    default:
      return null;
  }
}

// A trimmed numeric-looking string -> a finite number, or null for
// blank/invalid input. Used only by the lenient live preview below - never
// by validation, which goes through buildManualItemsPayload()'s stricter
// parseOptionalPositiveNumber/parseOptionalNonNegativeNumber instead.
function toNumberOrNull(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    return null;
  }
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
}

// Mirrors the exact rule public.award_purchase_points() (migration 016)
// uses in Postgres: quantity * unit_price when BOTH are present and valid;
// otherwise null ("contributes 0"). This is a preview only - the database
// is the sole authoritative source for the real award. Never reads
// line_total, sku, VAT, or an invoice grand total.
function computeLineAmount(quantity, unitPrice) {
  if (
    quantity != null &&
    unitPrice != null &&
    Number.isFinite(quantity) &&
    Number.isFinite(unitPrice) &&
    quantity > 0 &&
    unitPrice >= 0
  ) {
    return quantity * unitPrice;
  }
  return null;
}

// Sums computeLineAmount() over every is_golden_light row, and separately
// reports which eligible rows are missing a valid quantity/unit_price, so
// the UI can visibly flag them (per the "missing price information"
// requirement) rather than silently treating them as an intentional ₪0
// line.
function summarizeEligibleRows(rows, getFields) {
  let total = 0;
  const missingPriceKeys = [];

  rows.forEach((row, index) => {
    const { key, isGoldenLight, quantity, unitPrice } = getFields(row, index);
    if (!isGoldenLight) {
      return;
    }
    const amount = computeLineAmount(quantity, unitPrice);
    if (amount == null) {
      missingPriceKeys.push(key);
    } else {
      total += amount;
    }
  });

  return { total, missingPriceKeys };
}

function parseOptionalPositiveNumber(value, errorCode) {
  if (!value) {
    return null;
  }
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(errorCode);
  }
  return num;
}

function parseOptionalNonNegativeNumber(value, errorCode) {
  if (!value) {
    return null;
  }
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    throw new Error(errorCode);
  }
  return num;
}

// Builds the payload sent to finalizePurchaseReport()/saveAdminManualItems()
// from the editable rows, validating client-side first for immediate
// feedback - the server-side RPCs re-validate every rule themselves
// regardless, so this is a UX convenience, not the security boundary. A row
// left completely untouched (every field blank, no product matched) is
// dropped silently - the common case after pressing "+ הוספת שורה" and not
// using it; a row with SOME data but a missing description is rejected as
// an error.
//
// line_total is always sent as null - this form never collects it (see
// 016_simplify_eligible_amount_calc.sql). product_id/match_type/
// match_confidence are only sent when match_status is 'matched' - a row
// that is 'unresolved' or 'not_golden_light' always sends null for all
// three, regardless of what a stale row object might otherwise carry (the
// database independently enforces this same rule - see
// 019_product_matching_manual_items.sql - this is just matching UX
// consistency, not the real security boundary).
function buildManualItemsPayload(rows) {
  const trimmedRows = rows.map((row) => ({
    description: row.description.trim(),
    sku: (row.sku || '').trim(),
    quantity: row.quantity.trim(),
    unit_price: row.unit_price.trim(),
    product_id: row.product_id || null,
    match_type: row.match_type || null,
    match_confidence: row.match_confidence ?? null,
    match_status: row.match_status || 'unresolved',
    alias_candidate_text: row.alias_candidate_text || null,
  }));

  const nonEmptyRows = trimmedRows.filter(
    (row) => row.description || row.quantity || row.unit_price || row.product_id,
  );

  if (nonEmptyRows.length === 0) {
    throw new Error('items_required');
  }

  return nonEmptyRows.map((row) => {
    if (!row.description) {
      throw new Error('description_required');
    }
    if (row.description.length > 500) {
      throw new Error('description_too_long');
    }

    const isMatched = row.match_status === 'matched';

    return {
      description: row.description,
      sku: row.sku || null,
      quantity: parseOptionalPositiveNumber(row.quantity, 'invalid_quantity'),
      unit_price: parseOptionalNonNegativeNumber(row.unit_price, 'invalid_unit_price'),
      line_total: null,
      product_id: isMatched ? row.product_id : null,
      match_type: isMatched ? row.match_type : null,
      match_confidence: isMatched ? row.match_confidence : null,
      match_status: row.match_status || 'unresolved',
      // The admin's original receipt wording, if a selected suggestion
      // overwrote `description` with the catalog's canonical name and that
      // wording differed - see applyProductToRow. Only ever meaningful for
      // a 'matched' row; null otherwise. Consumed by
      // save_manual_receipt_items()'s alias-learning step (see
      // 020_manual_item_alias_source_text.sql), which falls back to
      // `description` itself when this is absent.
      alias_source_text: isMatched ? row.alias_candidate_text || null : null,
    };
  });
}

function isPdfFile(name) {
  return /\.pdf$/i.test(String(name || ''));
}

// Fits the receipt's real natural width/height inside a (maxWidth,
// maxHeight) box, preserving the true aspect ratio exactly - equivalent to
// the math behind CSS `object-fit: contain`, computed here so the CONTAINER
// itself is already the correct shape (no leftover letterbox space inside
// the card, no distortion). Most receipts are portrait phone photos, so a
// tall/narrow natural size naturally produces a tall/narrow box here,
// clamped by maxHeight before it ever gets unreasonably tall; a wide/
// landscape photo naturally produces a wide box, clamped by maxWidth.
// (Plain CSS `aspectRatio` + `maxWidth`/`maxHeight` together can't express
// this: Yoga clamps height to maxHeight without re-deriving width from the
// new height, which leaves a portrait image sitting in a much-too-wide box.)
// Falls back to the box's own max dimensions (a neutral, non-distorting
// placeholder box) until the real natural size has loaded.
function fitReceiptDisplaySize(naturalWidth, naturalHeight, maxWidth, maxHeight) {
  if (!naturalWidth || !naturalHeight || !maxWidth || !maxHeight) {
    return { width: maxWidth || 0, height: maxHeight || 0 };
  }
  const aspectRatio = naturalWidth / naturalHeight;
  let width = maxWidth;
  let height = width / aspectRatio;
  if (height > maxHeight) {
    height = maxHeight;
    width = height * aspectRatio;
  }
  return { width, height };
}

function formatReportDate(value) {
  const date = new Date(value);

  if (!value || Number.isNaN(date.getTime())) {
    return '';
  }

  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${day}.${month}.${year} ${hours}:${minutes}`;
}

// Same admin-specific status vocabulary as AdminHomeScreen - see that
// file's own copy for why submitted/needs_review are labeled distinctly
// (not extracted into a shared helper, matching the existing per-screen
// convention already used throughout the customer app).
function getStatusMeta(status) {
  switch (status) {
    case 'processing':
      return { label: 'בטיפול', backgroundColor: colors.primarySoft, textColor: colors.primary };
    case 'needs_review':
      return { label: 'דורשת בדיקה', backgroundColor: colors.surfaceMuted, textColor: colors.textMuted };
    case 'approved':
      return { label: 'אושרה', backgroundColor: colors.successSoft, textColor: colors.success };
    case 'rejected':
      return { label: 'נדחתה', backgroundColor: colors.errorSoft, textColor: colors.error };
    case 'submitted':
    default:
      return { label: 'נשלחה לבדיקה', backgroundColor: colors.primarySoft, textColor: colors.primaryPressed };
  }
}

// Three-state status for a receipt_manual_items row (019_product_matching_
// manual_items.sql). 'unresolved' (the default - nothing decided yet) must
// never be visually confused with 'not_golden_light' (an explicit admin
// decision that this line is NOT a Golden Light product) - see the task's
// "three distinct states" rule.
function getManualMatchStatusMeta(status) {
  switch (status) {
    case 'matched':
      return { label: 'זוהה מוצר', icon: 'checkmark-circle', color: colors.success };
    case 'not_golden_light':
      return { label: `לא מוצר ${isolateLTR('GL')}`, icon: 'close-circle', color: colors.textMuted };
    case 'unresolved':
    default:
      return { label: 'טרם הוגדר', icon: 'help-circle-outline', color: colors.textMuted };
  }
}

// Maps the short error identifiers raised by public.finalize_purchase_report()
// (migration 015 - the unified "אישור וסיום טיפול" action, which internally
// reuses save_manual_receipt_items()/award_purchase_points()'s own error
// codes), public.review_purchase_report() (migration 010, rejection only),
// public.save_manual_receipt_items() (migration 011, extended by migration
// 014), and public.award_purchase_points() (migration 014, fallback award
// path) to safe Hebrew UI text - the raw Postgres error is never shown to
// the admin.
function getActionErrorMessage(err) {
  switch (err?.message) {
    case 'rejection_reason_required':
      return 'יש להזין סיבת דחייה.';
    case 'rejection_reason_too_long':
      return 'סיבת הדחייה ארוכה מדי.';
    case 'report_not_reviewable':
      return 'החשבונית כבר טופלה.';
    case 'report_not_found':
      return 'החשבונית לא נמצאה.';
    case 'items_required':
    case 'invalid_items':
      return 'יש להזין לפחות שורה אחת עם תיאור מוצר.';
    case 'description_required':
      return 'כל שורה חייבת לכלול תיאור מוצר.';
    case 'description_too_long':
      return 'תיאור המוצר ארוך מדי.';
    case 'sku_too_long':
      return 'המק״ט ארוך מדי.';
    case 'invalid_quantity':
      return 'כמות לא תקינה.';
    case 'invalid_unit_price':
      return 'מחיר ליחידה לא תקין.';
    case 'invalid_line_total':
      return 'סה״כ לא תקין.';
    case 'invalid_is_golden_light':
      return `ערך לא תקין עבור סימון מוצר ${isolateLTR('Golden Light')}.`;
    case 'invalid_match_status':
      return 'סטטוס התאמת מוצר לא תקין.';
    case 'invalid_product':
      return 'המוצר שנבחר אינו קיים או אינו פעיל. נסו לבחור מוצר מחדש.';
    case 'match_type_required':
      return 'יש לבחור מוצר מהקטלוג לפני השמירה.';
    case 'too_many_items':
      return 'יותר מדי שורות.';
    case 'report_not_approved':
      return 'ניתן להעניק נקודות רק לחשבונית מאושרת.';
    case 'points_already_awarded':
      return 'כבר הוענקו נקודות לחשבונית זו.';
    case 'no_eligible_amount':
      return 'לא קיים סכום מזכה עבור החשבונית.';
    case 'no_points_to_award':
      return 'הסכום הזכאי אינו מספיק להענקת נקודות.';
    default:
      return 'לא ניתן היה לעדכן את החשבונית. נסו שוב.';
  }
}

// Every error public.finalize_purchase_report() (and the
// save_manual_receipt_items()/award_purchase_points() calls it makes
// internally) can raise BEFORE writing anything that matters - each one
// rolls back the whole atomic transaction, so a client that sees one of
// these knows with certainty the report was NOT approved and no points
// were awarded. Deliberately excludes 'report_not_reviewable' and
// 'points_already_awarded' - both mean the report already reached a
// terminal state, which could be from an EARLIER call (ours or someone
// else's) that actually succeeded - see handleFinalize's read-back-on-
// ambiguous-failure logic below, which treats anything not in this set the
// same way.
const FINALIZE_KNOWN_SAFE_ERRORS = new Set([
  'not_admin',
  'report_not_found',
  'invalid_items',
  'items_required',
  'too_many_items',
  'description_required',
  'description_too_long',
  'sku_too_long',
  'invalid_quantity',
  'invalid_unit_price',
  'invalid_line_total',
  'invalid_is_golden_light',
  'invalid_match_status',
  'invalid_product',
  'match_type_required',
  'no_eligible_amount',
  'no_points_to_award',
]);

// Client-side-only gate for enabling "אישור וסיום טיפול" - re-validates the
// exact same rules the database will (buildManualItemsPayload, then the
// Golden-Light-eligibility/points rules public.finalize_purchase_report()
// enforces via save_manual_receipt_items()/award_purchase_points()), purely
// so the button can stay disabled with a specific, actionable explanation
// instead of letting the admin submit and only then see a generic failure.
// The database remains the real authority regardless - this can never be
// used to bypass anything server-side.
//
// STAGE 5 CORRECTION (024_allow_unresolved_finalize.sql): an 'unresolved'
// row is deliberately NOT a blocker here (023's now-removed
// 'unresolved_items_remain' guard briefly made it one). A row still sitting
// at 'unresolved' is simply excluded from the eligible total below - same
// as 'not_golden_light' - never treated as an error. Only a 'matched' row
// missing a valid quantity/unit_price, or a report with no positive
// eligible amount, still blocks finalization (both already existed before
// Stage 5 and are unrelated to this correction).
function getFinalizeBlockingReason(rows) {
  let payload;
  try {
    payload = buildManualItemsPayload(rows);
  } catch (err) {
    return getActionErrorMessage(err);
  }

  const summary = summarizeEligibleRows(payload, (item, index) => ({
    key: index,
    isGoldenLight: item.match_status === 'matched',
    quantity: item.quantity,
    unitPrice: item.unit_price,
  }));

  if (summary.missingPriceKeys.length > 0) {
    return `יש להזין כמות ומחיר ליחידה תקינים עבור כל מוצרי ה-${isolateLTR('Golden Light')} המסומנים.`;
  }
  if (summary.total <= 0) {
    return `יש לסמן לפחות מוצר ${isolateLTR('Golden Light')} אחד עם סכום זכאי תקין לפני האישור.`;
  }
  if (Math.floor(summary.total * 0.2) <= 0) {
    return 'הסכום הזכאי אינו מספיק להענקת נקודות.';
  }
  return null;
}

// Below this many characters, no autocomplete dropdown is shown at all - a
// single character would match too much of the catalog to be a useful
// "meaningful search" and would just be noisy while the admin is still
// typing.
const DESCRIPTION_SUGGESTION_MIN_LENGTH = 2;
const DESCRIPTION_SUGGESTION_LIMIT = 6;

// Inline "as you type" autocomplete for the "תיאור מוצר" input - a small
// floating panel anchored directly under the field it belongs to (absolute
// position, not in-flow), so it never pushes the rest of the receipt-items
// table down while open. Built on getProductSuggestions() (productMatching.js)
// - the SAME ranked search the product-match modal's search box uses, so
// there is exactly one search/ranking implementation behind both surfaces.
// Purely presentational: onSelect (wired to applyProductToRow) is the only
// way a suggestion ever becomes an authoritative match - this component
// never selects anything on its own.
function DescriptionSuggestionDropdown({ suggestions, onSelect }) {
  if (!suggestions || suggestions.length === 0) {
    return null;
  }
  return (
    <View style={styles.descriptionSuggestionDropdown}>
      <View style={styles.descriptionSuggestionScroll}>
        {suggestions.map((product, index) => (
          <Pressable
            key={product.id}
            onPress={() => onSelect(product)}
            style={({ pressed, hovered }) => [
              styles.descriptionSuggestionRow,
              index > 0 && styles.descriptionSuggestionRowSeparator,
              (pressed || hovered) && styles.descriptionSuggestionRowActive,
            ]}
            accessibilityRole="button">
            <Text style={styles.descriptionSuggestionName} numberOfLines={2}>
              {product.name}
            </Text>
            <Text style={styles.descriptionSuggestionSku} numberOfLines={1}>
              {`מק״ט ${isolateLTR(product.sku)}`}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export default function AdminReportDetailScreen() {
  const { id } = useLocalSearchParams();
  const router = useRouter();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const isWideManualTable = windowWidth >= MANUAL_TABLE_MIN_WIDTH;
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [imageState, setImageState] = useState({ status: 'idle', url: null });
  // The receipt's real natural pixel size, fetched once the signed image
  // URL is available - drives the preview's aspectRatio style so the box is
  // exactly the receipt's true shape (never stretched/cropped), instead of
  // guessing a fixed aspect ratio. null until it resolves.
  const [imageNaturalSize, setImageNaturalSize] = useState(null);
  // Click-to-enlarge lightbox - same pattern already proven on the
  // customer-facing PurchaseReportDetailsScreen (dark overlay Modal,
  // resizeMode="contain", explicit close button).
  const [previewOpen, setPreviewOpen] = useState(false);

  // The unified review form - always editable while the report is
  // reviewable (submitted/needs_review), and also reused (in a clearly
  // separate, points-safe mode) for post-approval correction. See
  // postApprovalEditing below.
  const [manualRows, setManualRows] = useState([]);

  // "אישור וסיום טיפול" - the single final action for a reviewable report.
  const [finalizeModalOpen, setFinalizeModalOpen] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState('');

  // "דחיית חשבונית" - stays a separate, simpler action (migration 010,
  // unchanged). Never touches receipt_manual_items or points.
  const [rejectModalOpen, setRejectModalOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [rejectError, setRejectError] = useState('');

  // "עריכת טיפול" - post-approval correction of receipt_manual_items ONLY
  // (via the existing saveAdminManualItems()/save_manual_receipt_items()
  // RPC, never finalize_purchase_report() or award_purchase_points()). This
  // can never touch points_transactions/points_awarded/points_balance - see
  // the notice shown in this mode below.
  const [postApprovalEditing, setPostApprovalEditing] = useState(false);
  const [manualSaving, setManualSaving] = useState(false);
  const [manualError, setManualError] = useState('');

  // Fallback-only points-award path (see awardPurchasePoints() in
  // adminReportService.js) - reachable only for a report that is already
  // 'approved' but has no points_transactions row yet, which the unified
  // finalize flow can no longer produce; kept for a report that reached
  // 'approved' before this workflow existed.
  const [awardModalOpen, setAwardModalOpen] = useState(false);
  const [awarding, setAwarding] = useState(false);
  const [pointsError, setPointsError] = useState('');

  // The active Golden Light catalog (products + aliases), loaded ONCE per
  // review session (not per report, not per row) via loadCatalogForMatching
  // (adminReportService.js) - a plain read using the admin's own
  // authenticated session, same as any other screen (see that function's
  // comment for why no service-role key or new RPC is involved). Reused for
  // every row's auto-suggestion and manual search below - no N+1 query
  // pattern regardless of how many rows a receipt has.
  const [catalog, setCatalog] = useState({ products: [], aliases: [] });
  const [catalogError, setCatalogError] = useState('');

  // The per-row "בחירת מוצר Golden Light" modal - one shared modal reused
  // for whichever row's status cell was pressed (identified by rowKey),
  // rather than one modal instance per row.
  const [matchModal, setMatchModal] = useState({ open: false, rowKey: null, searchQuery: '' });

  // Which row's "תיאור מוצר" input currently has focus - drives the inline
  // autocomplete dropdown below it (see DescriptionSuggestionDropdown and
  // the row render below). Only one row's input can be focused at a time,
  // so a single shared value is enough - no need for per-row local state.
  const [focusedDescriptionRowKey, setFocusedDescriptionRowKey] = useState(null);
  // A short delay before actually clearing focus on blur - long enough for
  // a suggestion Pressable's onPress (which fires on release, shortly
  // after the input blurs) to register first, short enough that closing
  // still feels immediate once the admin genuinely moves on. This is the
  // standard fix for the well-known "blur hides the list before the click
  // is registered" race condition in web autocomplete UIs.
  const descriptionBlurTimeoutRef = useRef(null);

  useEffect(
    () => () => {
      if (descriptionBlurTimeoutRef.current) {
        clearTimeout(descriptionBlurTimeoutRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    loadCatalogForMatching()
      .then(setCatalog)
      .catch((err) => {
        if (__DEV__) {
          console.error('[Admin] Failed to load product catalog for matching', err);
        }
        setCatalogError('לא ניתן היה לטעון את קטלוג המוצרים להתאמה אוטומטית. ניתן עדיין לסמן שורות ידנית.');
      });
  }, []);

  const loadDetail = useCallback(() => {
    if (!id) {
      return;
    }

    setLoading(true);
    setError('');
    setNotFound(false);
    setImageState({ status: 'idle', url: null });
    setImageNaturalSize(null);
    setPreviewOpen(false);
    setManualRows([]);
    setFinalizeModalOpen(false);
    setFinalizeError('');
    setRejectModalOpen(false);
    setRejectReason('');
    setRejectError('');
    setPostApprovalEditing(false);
    setManualError('');
    setAwardModalOpen(false);
    setPointsError('');
    setMatchModal({ open: false, rowKey: null, searchQuery: '' });
    setFocusedDescriptionRowKey(null);

    getAdminReportDetail(id)
      .then((data) => {
        if (!data) {
          setNotFound(true);
          return;
        }

        setReport(data);

        // A reviewable report's line-item table is always editable - no
        // separate "start editing" step. Source priority (Stage 4): real
        // saved receipt_manual_items are ALWAYS authoritative once they
        // exist - this branch is unchanged from before Stage 4 in that
        // case, protecting any existing admin edits. Only when NO manual
        // items exist yet (data.manualItems is empty - a brand-new,
        // never-saved report) does the form seed itself from OCR +
        // product-matching evidence instead of a single blank row -
        // buildRowsFromOcrEvidence() itself falls back to one blank row
        // when there's no usable OCR evidence either (missing/failed OCR,
        // or zero matchable lines), so a report with no OCR data behaves
        // exactly as it always has. OCR is only ever the INITIAL seed:
        // nothing here writes receipt_manual_items - that still only
        // happens when the admin actually saves/finalizes (see
        // saveAdminManualItems/finalizePurchaseReport below), at which
        // point real manual items start existing and every future load of
        // this report takes the manual-items branch instead, permanently.
        if (REVIEWABLE_STATUSES.includes(data.status)) {
          setManualRows(
            data.manualItems && data.manualItems.length > 0
              ? buildRowsFromManualItems(data.manualItems)
              : buildRowsFromOcrEvidence(data.ocrLines, data.lineMatches),
          );
        }

        if (!isPdfFile(data.original_filename) && data.receipt_path) {
          setImageState({ status: 'loading', url: null });
          getAdminReceiptSignedUrl(data.receipt_path)
            .then((url) => setImageState({ status: url ? 'ready' : 'error', url }))
            .catch(() => setImageState({ status: 'error', url: null }));
        }
      })
      .catch(() => setError('לא הצלחנו לטעון את פרטי החשבונית'))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  // Fetches the receipt's real natural pixel size once its signed URL is
  // ready, so the preview box can be sized to the image's true aspect
  // ratio via the aspectRatio style instead of a guessed/fixed ratio. A
  // failure here just leaves imageNaturalSize null - the preview box still
  // renders (as a neutral box) and resizeMode="contain" still displays the
  // image correctly, this only affects how tightly the box fits it.
  useEffect(() => {
    if (imageState.status !== 'ready' || !imageState.url) {
      return;
    }
    let isActive = true;
    Image.getSize(
      imageState.url,
      (width, height) => {
        if (isActive) {
          setImageNaturalSize({ width, height });
        }
      },
      () => {
        if (isActive) {
          setImageNaturalSize(null);
        }
      },
    );
    return () => {
      isActive = false;
    };
  }, [imageState.status, imageState.url]);

  const addManualRow = () => {
    setManualRows((rows) => [...rows, createEmptyManualRow()]);
  };

  // If this is the only remaining row, clear it in place instead of
  // removing it - the form must never end up with zero rows while editing.
  const removeManualRow = (key) => {
    setManualRows((rows) => {
      if (rows.length <= 1) {
        return rows.map((row) =>
          row.key === key
            ? {
                ...row,
                description: '',
                sku: '',
                quantity: '',
                unit_price: '',
                product_id: null,
                match_type: null,
                match_confidence: null,
                match_status: 'unresolved',
                matched_product_sku: null,
                matched_product_name: null,
                alias_candidate_text: null,
              }
            : row,
        );
      }
      return rows.filter((row) => row.key !== key);
    });
  };

  // Plain field edits (description, quantity, unit_price). `sku` is never
  // edited this way anymore - it is only ever set by applyProductToRow()
  // below, synchronized to whichever product the admin selected in the
  // product-match modal. When the edited field is description AND the row
  // already has an authoritative product match, checks whether the new
  // text still equals that product's own canonical name - if not, the
  // match is stale and is cleared back to 'unresolved' in the SAME update
  // (never a separate effect/render pass, so the UI never shows a
  // "matched" row whose visible description no longer corresponds to
  // matched_product_name - a stale product_id must never persist). Falls
  // back to 'unresolved', not 'not_golden_light' - nothing was explicitly
  // decided, the row just needs to be matched again via the modal.
  const updateManualRow = (key, field, value) => {
    setManualRows((rows) =>
      rows.map((row) => {
        if (row.key !== key) {
          return row;
        }
        const nextRow = { ...row, [field]: value };
        if (row.match_status === 'matched' && field === 'description') {
          const stillMatchesDescription = nextRow.description.trim() === (row.matched_product_name || '');
          if (!stillMatchesDescription) {
            nextRow.product_id = null;
            nextRow.match_type = null;
            nextRow.match_confidence = null;
            nextRow.match_status = 'unresolved';
            nextRow.matched_product_sku = null;
            nextRow.matched_product_name = null;
            nextRow.alias_candidate_text = null;
          }
        }
        return nextRow;
      }),
    );
  };

  const applyRowMatch = (key, patch) => {
    setManualRows((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  // Seeds the modal's single search box with whatever the admin already
  // typed into "תיאור מוצר" for this row - so opening the modal for a row
  // that already has a description immediately shows relevant suggestions
  // without retyping it. The admin can still freely replace the text with a
  // SKU or barcode instead - the same box (getProductSuggestions) searches
  // all three regardless of what's typed there.
  const openMatchModal = (key) => {
    const row = manualRows.find((candidate) => candidate.key === key);
    setMatchModal({ open: true, rowKey: key, searchQuery: row?.description?.trim() || '' });
  };

  const closeMatchModal = () => {
    setMatchModal({ open: false, rowKey: null, searchQuery: '' });
  };

  const setMatchModalSearchQuery = (value) => {
    setMatchModal((state) => ({ ...state, searchQuery: value }));
  };

  // Inline "תיאור מוצר" autocomplete focus tracking - see
  // focusedDescriptionRowKey above. Any pending blur-close from a
  // previously focused row is cancelled first, so switching focus directly
  // between two description inputs never leaves a stale timer running.
  const handleDescriptionFocus = (key) => {
    if (descriptionBlurTimeoutRef.current) {
      clearTimeout(descriptionBlurTimeoutRef.current);
      descriptionBlurTimeoutRef.current = null;
    }
    setFocusedDescriptionRowKey(key);
  };

  const handleDescriptionBlur = (key) => {
    descriptionBlurTimeoutRef.current = setTimeout(() => {
      setFocusedDescriptionRowKey((current) => (current === key ? null : current));
      descriptionBlurTimeoutRef.current = null;
    }, 200);
  };

  // THE ONE place description/sku/product_id/match_status are ever
  // synchronized together - called whenever the admin picks a product from
  // the product-match modal's single search box (the ONLY catalog-lookup
  // surface in this whole screen - see the modal's render below). Always
  // overwrites description and sku to the selected product's own canonical
  // values, so a row can never end up in a "description = product A, sku =
  // product B" mismatch.
  //
  // `method`/`confidence` are 'manual'/null for every selection made this
  // way (the admin is always explicitly picking a search result) - which is
  // also what makes the selection eligible for alias learning below (see
  // 019_product_matching_manual_items.sql's alias-learning rule, keyed on
  // exactly this 'manual' tag).
  //
  // Alias-candidate capture: if this is a 'manual' selection and the
  // admin's PRE-selection description text differs from the product's own
  // canonical name/sku (i.e. genuine custom receipt wording, like "מפסק 1M
  // לבן" for official product "מפסק יחיד 1 מודול לבן"), that original text
  // is captured into alias_candidate_text BEFORE description is overwritten
  // - buildManualItemsPayload sends it as `alias_source_text`, and
  // 020_manual_item_alias_source_text.sql's save_manual_receipt_items()
  // uses it (instead of the now-canonical `description`) to learn the
  // alias, exactly preserving the existing alias-learning mechanism even
  // though the visible description field is now always synchronized.
  const applyProductToRow = (key, product, method, confidence) => {
    setManualRows((rows) =>
      rows.map((row) => {
        if (row.key !== key) {
          return row;
        }
        const priorDescription = row.description.trim();
        const isAlreadyCanonical =
          !priorDescription ||
          priorDescription.toLowerCase() === (product.name || '').trim().toLowerCase() ||
          priorDescription.toLowerCase() === (product.sku || '').trim().toLowerCase();
        return {
          ...row,
          description: product.name || '',
          sku: product.sku || '',
          product_id: product.id,
          match_type: method,
          match_confidence: confidence,
          match_status: 'matched',
          matched_product_sku: product.sku,
          matched_product_name: product.name,
          alias_candidate_text: method === 'manual' && !isAlreadyCanonical ? priorDescription : null,
        };
      }),
    );
  };

  // Applies to whichever row the modal is currently open for, then closes
  // it - the modal's search-result rows below are the only caller.
  const selectRowProduct = (product, method, confidence) => {
    if (!matchModal.rowKey) {
      return;
    }
    applyProductToRow(matchModal.rowKey, product, method, confidence);
    closeMatchModal();
  };

  const markRowNotGoldenLight = () => {
    if (!matchModal.rowKey) {
      return;
    }
    applyRowMatch(matchModal.rowKey, {
      product_id: null,
      match_type: null,
      match_confidence: null,
      match_status: 'not_golden_light',
      matched_product_sku: null,
      matched_product_name: null,
      alias_candidate_text: null,
    });
    closeMatchModal();
  };

  const resetRowMatch = () => {
    if (!matchModal.rowKey) {
      return;
    }
    applyRowMatch(matchModal.rowKey, {
      product_id: null,
      match_type: null,
      match_confidence: null,
      match_status: 'unresolved',
      matched_product_sku: null,
      matched_product_name: null,
      alias_candidate_text: null,
    });
  };

  const openFinalizeModal = () => {
    setFinalizeError('');
    setFinalizeModalOpen(true);
  };

  const closeFinalizeModal = () => {
    if (finalizing) {
      return;
    }
    setFinalizeModalOpen(false);
    setFinalizeError('');
  };

  // The single final action: saves the current rows, marks the report
  // approved, and awards points - all in one atomic RPC call
  // (finalize_purchase_report, migration 015). Never a separate save, then
  // approve, then award.
  const handleFinalize = async () => {
    if (!report || finalizing) {
      return;
    }

    let payload;
    try {
      payload = buildManualItemsPayload(manualRows);
    } catch (err) {
      setFinalizeError(getActionErrorMessage(err));
      return;
    }

    setFinalizing(true);
    setFinalizeError('');

    try {
      await finalizePurchaseReport(report.id, payload);
      setFinalizeModalOpen(false);
      loadDetail();
    } catch (err) {
      // Dev-only: the real Supabase/Postgres error - never shown to the
      // admin, who only ever sees the safe Hebrew message below.
      if (__DEV__) {
        console.error('[Admin finalize report]', err);
      }

      // finalize_purchase_report() is one atomic transaction (save items ->
      // approve -> recalculate membership -> award points) - there is no
      // partial state to worry about, but the CLIENT can still fail to
      // receive the response after the server already committed (a
      // gateway/network timeout - observed live as an HTTP 504 while the
      // report had already been approved and awarded in the database).
      // FINALIZE_KNOWN_SAFE_ERRORS is every error finalize_purchase_report()
      // can raise BEFORE any write that matters - each one rolls back the
      // whole transaction, so there is nothing to double-check. Everything
      // else is treated as ambiguous and read back from the database rather
      // than guessed at: that deliberately includes 'report_not_reviewable'/
      // 'points_already_awarded' (which can only mean an earlier call -
      // ours or someone else's - already finished this exact report), and
      // any unrecognized error (a raw gateway timeout's body, a network
      // exception, ...), since either could mean the real outcome was never
      // actually delivered to us.
      const isAmbiguous = !FINALIZE_KNOWN_SAFE_ERRORS.has(err?.message);

      if (!isAmbiguous) {
        setFinalizeError(getActionErrorMessage(err));
        return;
      }

      // Read the real, current state back from the database rather than
      // guessing - never re-invoke finalizePurchaseReport() here, under any
      // outcome, to avoid ever risking a second attempt at the authoritative
      // write.
      let confirmed = null;
      try {
        confirmed = await getAdminReportDetail(report.id);
      } catch (readBackErr) {
        if (__DEV__) {
          console.error('[Admin finalize report] read-back failed', readBackErr);
        }
      }

      if (confirmed && confirmed.status === 'approved') {
        // Our call (or an earlier one) already succeeded server-side - this
        // is a real success, not a failure to report.
        setFinalizeModalOpen(false);
        setFinalizeError('');
        loadDetail();
      } else if (confirmed) {
        // Read-back succeeded and genuinely shows the report is still
        // reviewable (or rejected) - the failure was real.
        setFinalizeError(getActionErrorMessage(err));
      } else {
        // Could not even confirm the outcome - never silently retry;
        // let the admin refresh and check for themselves.
        setFinalizeError(
          'לא ניתן היה לאמת האם האישור הושלם בהצלחה. רעננו את המסך ובדקו את סטטוס החשבונית לפני ניסיון נוסף.',
        );
      }
    } finally {
      setFinalizing(false);
    }
  };

  const openRejectModal = () => {
    setRejectError('');
    setRejectReason('');
    setRejectModalOpen(true);
  };

  const closeRejectModal = () => {
    if (rejecting) {
      return;
    }
    setRejectModalOpen(false);
    setRejectError('');
    setRejectReason('');
  };

  const handleReject = async () => {
    if (!report || rejecting) {
      return;
    }

    const trimmedReason = rejectReason.trim();
    if (!trimmedReason) {
      setRejectError('יש להזין סיבת דחייה.');
      return;
    }

    setRejecting(true);
    setRejectError('');

    try {
      await rejectAdminReport(report.id, trimmedReason);
      setRejectModalOpen(false);
      setRejectReason('');
      loadDetail();
    } catch (err) {
      // Dev-only: the real Supabase/Postgres error - never shown to the
      // admin, who only ever sees the safe Hebrew message below. Matches
      // the same dev-logging convention already used by handleFinalize/
      // handleAwardPoints above.
      if (__DEV__) {
        console.error('[Admin reject report]', err);
      }
      setRejectError(getActionErrorMessage(err));
    } finally {
      setRejecting(false);
    }
  };

  const startPostApprovalEdit = () => {
    if (!report) {
      return;
    }
    setManualRows(buildRowsFromManualItems(report.manualItems));
    setManualError('');
    setPostApprovalEditing(true);
  };

  // Discards the in-progress draft and returns to the read-only view of the
  // last SAVED data - never persists anything.
  const cancelPostApprovalEdit = () => {
    if (manualSaving) {
      return;
    }
    setPostApprovalEditing(false);
    setManualError('');
  };

  // Post-approval correction: replaces receipt_manual_items only, via the
  // same save_manual_receipt_items() RPC the reviewable-report flow used to
  // use directly. This can NEVER touch points_transactions,
  // purchase_reports.points_awarded, or profiles.points_balance - the
  // already-awarded points for this report are not recalculated here,
  // exactly as required (a real correction would need a separate,
  // explicit adjustment-ledger stage that does not exist yet).
  const savePostApprovalEdit = async () => {
    if (!report || manualSaving) {
      return;
    }

    setManualError('');

    let payload;
    try {
      payload = buildManualItemsPayload(manualRows);
    } catch (err) {
      setManualError(getActionErrorMessage(err));
      return;
    }

    setManualSaving(true);

    try {
      await saveAdminManualItems(report.id, payload);
      setPostApprovalEditing(false);
      loadDetail();
    } catch (err) {
      if (__DEV__) {
        console.error('[Admin manual receipt save]', err);
      }
      setManualError(getActionErrorMessage(err));
    } finally {
      setManualSaving(false);
    }
  };

  const openAwardModal = () => {
    setPointsError('');
    setAwardModalOpen(true);
  };

  const closeAwardModal = () => {
    if (awarding) {
      return;
    }
    setAwardModalOpen(false);
    setPointsError('');
  };

  const handleAwardPoints = async () => {
    if (!report || awarding) {
      return;
    }

    setAwarding(true);
    setPointsError('');

    try {
      await awardPurchasePoints(report.id);
      setAwardModalOpen(false);
      loadDetail();
    } catch (err) {
      if (__DEV__) {
        console.error('[Admin award points]', err);
      }
      setPointsError(getActionErrorMessage(err));
    } finally {
      setAwarding(false);
    }
  };

  const isPdf = report ? isPdfFile(report.original_filename) : false;
  const canOpenPreview = !isPdf && imageState.status === 'ready' && Boolean(imageState.url);
  // The preview box's available width is derived analytically from
  // useWindowDimensions() (synchronous, always available on first render)
  // and AdminShell's own content-column layout constants, rather than
  // measured via the image card's onLayout - onLayout's firing isn't
  // guaranteed before first paint (confirmed empirically: it can go
  // multiple seconds without firing at some viewport widths), which would
  // otherwise leave the image sized wrong until some unrelated re-render
  // happens to trigger it. ADMIN_CONTENT_MAX_WIDTH/paddings mirror
  // AdminShell's bodyContent (maxWidth 1100, horizontal padding
  // spacing.xl) and this card's own padding (spacing.lg) - if either
  // changes, update the numbers here too.
  const ADMIN_CONTENT_MAX_WIDTH = 1100;
  const availableContentWidth = Math.min(windowWidth, ADMIN_CONTENT_MAX_WIDTH) - spacing.xl * 2 - spacing.lg * 2;
  // Height is capped generously so even a very tall portrait photo stays
  // inspectable without scrolling the whole page; width is additionally
  // capped lower on wide desktop so a landscape receipt doesn't sprawl
  // edge-to-edge on a ~1100px-wide admin page.
  const receiptBoxMaxWidth = isWideManualTable ? Math.min(availableContentWidth, 560) : availableContentWidth;
  const receiptBoxMaxHeight = isWideManualTable ? 640 : 460;
  const receiptDisplaySize = fitReceiptDisplaySize(
    imageNaturalSize?.width,
    imageNaturalSize?.height,
    receiptBoxMaxWidth,
    receiptBoxMaxHeight,
  );
  // Fullscreen lightbox bounding box - nearly the full viewport, leaving a
  // comfortable margin on every side. resizeMode="contain" then letterboxes
  // the real image within this box, so it's always fully visible (never
  // cropped, never stretched) regardless of aspect ratio or screen size.
  const fullscreenPreviewWidth = Math.max(windowWidth - spacing.xl * 2, 0);
  const fullscreenPreviewHeight = Math.max(windowHeight - spacing.xxl * 2, 0);
  const statusMeta = report ? getStatusMeta(report.status) : null;
  const isReviewable = report ? REVIEWABLE_STATUSES.includes(report.status) : false;
  const isApproved = report?.status === 'approved';
  const isRejected = report?.status === 'rejected';
  const isFinalized = isApproved || isRejected;
  const hasManualItems = Boolean(report?.manualItems && report.manualItems.length > 0);
  const hasPointsAward = Boolean(report?.pointsAward);
  const isEditingRows = isReviewable || postApprovalEditing;
  // STAGE 8: single source of truth for "is a row-level control disabled
  // right now" (a save/finalize request is in flight) - was previously
  // repeated inline as `manualSaving || finalizing`/`!manualSaving &&
  // !finalizing` at every input/button call site below. Also drives
  // rowControlDisabled (a visible dimming), since disabling a control
  // without any visual change left no indication anything had changed -
  // see Section 11's "disabled/loading state must be visually clear".
  const rowsDisabled = manualSaving || finalizing;

  // Live draft preview - recomputed on every render from the in-progress
  // manualRows editing state (never persisted), so it updates immediately
  // as the admin marks/unmarks "מוצר Golden Light" or edits
  // quantity/unit_price. Admin-only, never sent anywhere. Used both for the
  // reviewable-report finalize flow and the post-approval correction
  // preview.
  const draftEligibleSummary = summarizeEligibleRows(manualRows, (row) => ({
    key: row.key,
    isGoldenLight: row.match_status === 'matched',
    quantity: toNumberOrNull(row.quantity),
    unitPrice: toNumberOrNull(row.unit_price),
  }));
  const draftPointsPreview = Math.floor(draftEligibleSummary.total * 0.2);
  const finalizeBlockingReason = isReviewable ? getFinalizeBlockingReason(manualRows) : null;

  // The fallback award-section preview - recomputed from report.manualItems,
  // the last SAVED data, since that is exactly what
  // public.award_purchase_points() itself will sum when pressed. Still only
  // a JS preview - the RPC independently recalculates the authoritative
  // value in NUMERIC arithmetic.
  const savedEligibleSummary = summarizeEligibleRows(report?.manualItems || [], (item) => ({
    key: item.id,
    isGoldenLight: item.match_status === 'matched',
    quantity: item.quantity,
    unitPrice: item.unit_price,
  }));
  const savedPointsPreview = Math.floor(savedEligibleSummary.total * 0.2);
  const hasEligibleAmount = savedEligibleSummary.total > 0;

  // Derived state for the product-match modal - recomputed on every render
  // from whichever row is currently open (matchModal.rowKey) and the
  // once-loaded catalog. Cheap: getProductSuggestions is a pure, in-memory,
  // O(catalog size) operation over ~211 products, not a query. This is the
  // ONE search mechanism the modal offers - the single search box below
  // understands SKU, barcode, and description/name together (see
  // getProductSuggestions in productMatching.js), so there is no separate
  // "automatic" vs "manual" search path to reconcile.
  const activeMatchRow = matchModal.open ? manualRows.find((row) => row.key === matchModal.rowKey) : null;
  const matchSearchResults = matchModal.open ? getProductSuggestions(matchModal.searchQuery, catalog, 20) : [];

  // Inline "תיאור מוצר" autocomplete - computed ONCE here (not per-row
  // inside the row map below), since only one row's description input can
  // ever be focused at a time. hasOpenDescriptionSuggestions is what
  // elevates the WHOLE manual-items section card above its sibling cards
  // (the eligible-total summary, "פעולות בדיקה", ...) while the dropdown is
  // open - see manualSectionElevated below. Elevating only the row itself
  // is not enough: the row's zIndex only wins against ITS OWN siblings
  // inside the same section card, since none of the ancestor cards
  // establish their own stacking context on their own - the section card
  // as a whole still needs a higher zIndex than its sibling section cards
  // for the dropdown (however deep inside it) to actually paint above them.
  const focusedDescriptionRow = manualRows.find((row) => row.key === focusedDescriptionRowKey) || null;
  const focusedDescriptionSuggestions =
    focusedDescriptionRow &&
    focusedDescriptionRow.match_status !== 'matched' &&
    focusedDescriptionRow.description.trim().length >= DESCRIPTION_SUGGESTION_MIN_LENGTH
      ? getProductSuggestions(focusedDescriptionRow.description, catalog, DESCRIPTION_SUGGESTION_LIMIT)
      : [];
  const hasOpenDescriptionSuggestions = focusedDescriptionSuggestions.length > 0;

  // router.back() unconditionally throws the React Navigation "GO_BACK was
  // not handled" warning whenever this screen has no history to go back to
  // - reached via a direct URL, a browser refresh, or any entry point that
  // didn't itself push this route from within the app. canGoBack() is the
  // correct Expo Router guard for this: only pop when there's real history,
  // otherwise land on "כל החשבוניות" (/admin/reports, the existing
  // reports-list route) rather than assuming history exists.
  const handleBackPress = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/admin/reports');
    }
  };

  return (
    <AdminShell activeKey="dashboard">
      <Pressable onPress={handleBackPress} style={styles.backRow} accessibilityRole="button">
        <Ionicons name="chevron-forward" size={18} color={colors.primary} />
        <Text style={styles.backText}>חזרה לרשימה</Text>
      </Pressable>

      {loading ? (
        <View style={styles.stateCard}>
          <ActivityIndicator color={colors.primary} size="small" />
        </View>
      ) : error ? (
        <View style={styles.stateCard}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable onPress={loadDetail} accessibilityRole="button">
            <Text style={styles.retryText}>נסו שוב</Text>
          </Pressable>
        </View>
      ) : notFound || !report ? (
        <View style={styles.stateCard}>
          <Text style={styles.errorText}>החשבונית לא נמצאה</Text>
        </View>
      ) : (
        <>
          <View style={styles.headerCard}>
            <View style={styles.headerTopRow}>
              <Text style={styles.customerName} numberOfLines={1}>
                {report.customerName || 'משתמש ללא שם'}
              </Text>
              <View style={[styles.statusBadge, { backgroundColor: statusMeta.backgroundColor }]}>
                <Text style={[styles.statusBadgeText, { color: statusMeta.textColor }]}>{statusMeta.label}</Text>
              </View>
            </View>
            {/* ONE small, subtle "who + when" line - deliberately the only
                upload metadata shown here. No filename, file type, size, or
                other technical attachment detail belongs in this header -
                see the large preview below for actually inspecting the
                receipt. */}
            <Text style={styles.uploadMetaLine}>
              {`הועלה ע״י ${report.customerName || 'משתמש ללא שם'} · ${isolateLTR(
                formatReportDate(report.created_at).replace(' ', ', '),
              )}`}
            </Text>
            {report.points_awarded > 0 ? (
              <Text style={styles.pointsLine}>{`נצברו ${isolateLTR(report.points_awarded)} נק׳`}</Text>
            ) : null}
          </View>

          <Pressable
            style={({ hovered, pressed }) => [
              styles.imageCard,
              canOpenPreview && hovered && styles.imageCardHovered,
              canOpenPreview && pressed && styles.imageCardPressed,
            ]}
            onPress={() => canOpenPreview && setPreviewOpen(true)}
            disabled={!canOpenPreview}
            accessibilityRole={canOpenPreview ? 'button' : undefined}
            accessibilityLabel="הגדלת תמונת החשבונית">
            {isPdf ? (
              <View style={styles.imagePlaceholder}>
                <Ionicons name="document-text-outline" size={28} color={colors.textMuted} />
                <Text style={styles.imagePlaceholderText}>{`קובץ ${isolateLTR('PDF')}`}</Text>
              </View>
            ) : imageState.status === 'ready' && imageState.url ? (
              <>
                <Image
                  source={{ uri: imageState.url }}
                  style={[
                    styles.receiptImage,
                    receiptDisplaySize.width > 0
                      ? { width: receiptDisplaySize.width, height: receiptDisplaySize.height }
                      : null,
                  ]}
                  resizeMode="contain"
                />
                <View style={styles.enlargeHint} pointerEvents="none">
                  <Ionicons name="expand-outline" size={13} color={colors.white} />
                  <Text style={styles.enlargeHintText}>הגדלה</Text>
                </View>
              </>
            ) : imageState.status === 'loading' ? (
              <View style={styles.imagePlaceholder}>
                <ActivityIndicator color={colors.primary} size="small" />
              </View>
            ) : (
              <View style={styles.imagePlaceholder}>
                <Text style={styles.imagePlaceholderText}>לא ניתן לטעון את התמונה</Text>
              </View>
            )}
          </Pressable>

          {/* Unified "פרטי החשבונית" section - always editable while the
              report is reviewable (isEditingRows via isReviewable), or
              editable in the clearly separate, points-safe "עריכת טיפול"
              mode for an approved report. Otherwise (rejected, processing,
              or an approved report not currently being corrected) it's a
              plain read-only display of the last saved rows. */}
          {isEditingRows || hasManualItems ? (
            <View style={[styles.sectionCard, hasOpenDescriptionSuggestions && styles.manualSectionElevated]}>
              {isEditingRows ? (
                <>
                  <Text style={styles.sectionTitle}>פרטי החשבונית</Text>

                  {postApprovalEditing ? (
                    <Text style={styles.postApprovalNoticeText}>
                      עריכה זו מעדכנת את פרטי החשבונית בלבד ואינה משפיעה על הנקודות שכבר הוענקו.
                    </Text>
                  ) : null}

                  {isWideManualTable ? (
                    <View style={styles.manualTableHeaderRow}>
                      {MANUAL_COLUMNS.map((column) => (
                        <Text
                          key={column.key}
                          style={[
                            styles.manualTableHeaderText,
                            { flex: column.flex },
                            column.key === 'match_status' && styles.manualTableHeaderTextCentered,
                          ]}>
                          {column.label}
                        </Text>
                      ))}
                      <View style={styles.manualTableDeleteHeaderCell} />
                    </View>
                  ) : null}

                  <View style={[styles.manualFormRows, hasOpenDescriptionSuggestions && styles.manualRowElevated]}>
                    {manualRows.map((row, index) => {
                      // Computed once above (focusedDescriptionSuggestions) -
                      // only the currently-focused row ever shows anything,
                      // since only one description input can be focused at
                      // a time.
                      const descriptionSuggestions =
                        row.key === focusedDescriptionRowKey ? focusedDescriptionSuggestions : [];
                      const handleSelectDescriptionSuggestion = (product) => {
                        applyProductToRow(row.key, product, 'manual', null);
                        setFocusedDescriptionRowKey(null);
                      };
                      // Raises this specific row above its OWN siblings
                      // within the same section card (other rows, the
                      // eligible-total summary below the list) while its
                      // dropdown is open. On its own this is not enough to
                      // clear sibling SECTION CARDS below "פרטי החשבונית"
                      // (e.g. "פעולות בדיקה") - see manualSectionElevated
                      // on the section card itself, applied from
                      // hasOpenDescriptionSuggestions above.
                      const isRowElevated = descriptionSuggestions.length > 0;
                      // Stage 4: a small, optional caption for a row still
                      // carrying its original OCR normalization outcome -
                      // see getOcrNormalizationHint. null for every
                      // manually-entered row (no normalizationStatus key
                      // at all) and for a 'clean' OCR row.
                      const ocrHint = getOcrNormalizationHint(row.normalizationStatus);

                      return isWideManualTable ? (
                        <View
                          key={row.key}
                          style={[styles.manualTableRow, isRowElevated && styles.manualRowElevated]}>
                          <View style={[{ flex: MANUAL_COLUMNS[0].flex }, styles.descriptionCellAnchor]}>
                            <AppInput
                              value={row.description}
                              onChangeText={(value) => updateManualRow(row.key, 'description', value)}
                              onFocus={() => handleDescriptionFocus(row.key)}
                              onBlur={() => handleDescriptionBlur(row.key)}
                              placeholder="תיאור מוצר"
                              editable={!rowsDisabled}
                              accessibilityLabel={`תיאור מוצר, שורה ${isolateLTR(index + 1)}`}
                              style={[styles.manualTableCellInput, rowsDisabled && styles.rowControlDisabled]}
                            />
                            {ocrHint ? <Text style={styles.ocrNormalizationHintText}>{ocrHint}</Text> : null}
                            <DescriptionSuggestionDropdown
                              suggestions={descriptionSuggestions}
                              onSelect={handleSelectDescriptionSuggestion}
                            />
                          </View>
                          <View style={{ flex: MANUAL_COLUMNS[1].flex }}>
                            <AppInput
                              value={row.quantity}
                              onChangeText={(value) => updateManualRow(row.key, 'quantity', value)}
                              placeholder="כמות"
                              keyboardType="decimal-pad"
                              editable={!rowsDisabled}
                              accessibilityLabel={`כמות, שורה ${isolateLTR(index + 1)}`}
                              textAlign="left"
                              writingDirection="ltr"
                              style={[styles.manualTableCellInput, rowsDisabled && styles.rowControlDisabled]}
                            />
                          </View>
                          <View style={{ flex: MANUAL_COLUMNS[2].flex }}>
                            <AppInput
                              value={row.unit_price}
                              onChangeText={(value) => updateManualRow(row.key, 'unit_price', value)}
                              placeholder="מחיר ליחידה"
                              keyboardType="decimal-pad"
                              editable={!rowsDisabled}
                              accessibilityLabel={`מחיר ליחידה, שורה ${isolateLTR(index + 1)}`}
                              textAlign="left"
                              writingDirection="ltr"
                              style={[styles.manualTableCellInput, rowsDisabled && styles.rowControlDisabled]}
                            />
                          </View>
                          <View style={[styles.manualGoldenLightCell, { flex: MANUAL_COLUMNS[3].flex }]}>
                            <Pressable
                              onPress={() => openMatchModal(row.key)}
                              disabled={rowsDisabled}
                              accessibilityRole="button"
                              accessibilityLabel={`בחירת מוצר Golden Light, שורה ${isolateLTR(index + 1)}`}
                              hitSlop={8}
                              style={[styles.manualMatchStatusPressable, rowsDisabled && styles.rowControlDisabled]}>
                              <Ionicons
                                name={getManualMatchStatusMeta(row.match_status).icon}
                                size={20}
                                color={getManualMatchStatusMeta(row.match_status).color}
                              />
                              <Text
                                style={[
                                  styles.manualMatchStatusCellText,
                                  { color: getManualMatchStatusMeta(row.match_status).color },
                                ]}
                                numberOfLines={1}>
                                {row.match_status === 'matched'
                                  ? row.matched_product_sku || getManualMatchStatusMeta(row.match_status).label
                                  : getManualMatchStatusMeta(row.match_status).label}
                              </Text>
                            </Pressable>
                            {row.match_status === 'matched' &&
                            computeLineAmount(toNumberOrNull(row.quantity), toNumberOrNull(row.unit_price)) ==
                              null ? (
                              <Ionicons
                                name="alert-circle"
                                size={16}
                                color={colors.error}
                                accessibilityLabel="חסר כמות/מחיר למוצר Golden Light"
                              />
                            ) : null}
                          </View>
                          <Pressable
                            onPress={() => removeManualRow(row.key)}
                            disabled={rowsDisabled}
                            style={[styles.manualTableDeleteCell, rowsDisabled && styles.rowControlDisabled]}
                            accessibilityRole="button"
                            accessibilityLabel={`מחיקת שורה ${isolateLTR(index + 1)}`}
                            hitSlop={8}>
                            <Ionicons name="trash-outline" size={16} color={colors.error} />
                          </Pressable>
                        </View>
                      ) : (
                        <View key={row.key} style={[styles.manualStackedRow, isRowElevated && styles.manualRowElevated]}>
                          <View style={styles.manualStackedRowHeader}>
                            <Text style={styles.manualStackedRowIndex}>{`שורה ${isolateLTR(index + 1)}`}</Text>
                            <Pressable
                              onPress={() => removeManualRow(row.key)}
                              disabled={rowsDisabled}
                              accessibilityRole="button"
                              accessibilityLabel={`מחיקת שורה ${isolateLTR(index + 1)}`}
                              hitSlop={8}
                              style={rowsDisabled && styles.rowControlDisabled}>
                              <Ionicons name="trash-outline" size={16} color={colors.error} />
                            </Pressable>
                          </View>
                          <View style={styles.descriptionCellAnchor}>
                            <AppInput
                              label="תיאור מוצר"
                              value={row.description}
                              onChangeText={(value) => updateManualRow(row.key, 'description', value)}
                              onFocus={() => handleDescriptionFocus(row.key)}
                              onBlur={() => handleDescriptionBlur(row.key)}
                              editable={!rowsDisabled}
                              style={[styles.manualFormField, rowsDisabled && styles.rowControlDisabled]}
                            />
                            {ocrHint ? <Text style={styles.ocrNormalizationHintText}>{ocrHint}</Text> : null}
                            <DescriptionSuggestionDropdown
                              suggestions={descriptionSuggestions}
                              onSelect={handleSelectDescriptionSuggestion}
                            />
                          </View>
                          <View style={styles.manualFormFieldsRow}>
                            <AppInput
                              label="כמות"
                              value={row.quantity}
                              onChangeText={(value) => updateManualRow(row.key, 'quantity', value)}
                              editable={!rowsDisabled}
                              keyboardType="decimal-pad"
                              textAlign="left"
                              writingDirection="ltr"
                              style={[styles.manualFormFieldHalf, rowsDisabled && styles.rowControlDisabled]}
                            />
                            <AppInput
                              label="מחיר ליחידה"
                              value={row.unit_price}
                              onChangeText={(value) => updateManualRow(row.key, 'unit_price', value)}
                              editable={!rowsDisabled}
                              keyboardType="decimal-pad"
                              textAlign="left"
                              writingDirection="ltr"
                              style={[styles.manualFormFieldHalf, rowsDisabled && styles.rowControlDisabled]}
                            />
                          </View>
                          <Pressable
                            onPress={() => openMatchModal(row.key)}
                            disabled={rowsDisabled}
                            style={[styles.manualGoldenLightStackedRow, rowsDisabled && styles.rowControlDisabled]}
                            accessibilityRole="button"
                            accessibilityLabel={`בחירת מוצר Golden Light, שורה ${isolateLTR(index + 1)}`}>
                            <Ionicons
                              name={getManualMatchStatusMeta(row.match_status).icon}
                              size={20}
                              color={getManualMatchStatusMeta(row.match_status).color}
                            />
                            <Text
                              style={[
                                styles.manualGoldenLightStackedLabel,
                                { color: getManualMatchStatusMeta(row.match_status).color },
                              ]}>
                              {row.match_status === 'matched'
                                ? `${row.matched_product_sku ? isolateLTR(row.matched_product_sku) : ''} — ${row.matched_product_name || ''}`.replace(
                                    /^ — /,
                                    '',
                                  )
                                : getManualMatchStatusMeta(row.match_status).label}
                            </Text>
                          </Pressable>
                          {row.match_status === 'matched' &&
                          computeLineAmount(toNumberOrNull(row.quantity), toNumberOrNull(row.unit_price)) ==
                            null ? (
                            <Text style={styles.manualRowWarningText}>
                              {`חסר כמות/מחיר למוצר ${isolateLTR('Golden Light')}`}
                            </Text>
                          ) : null}
                        </View>
                      );
                    })}
                  </View>

                  <Pressable
                    onPress={addManualRow}
                    disabled={rowsDisabled}
                    style={[styles.addRowButton, rowsDisabled && styles.rowControlDisabled]}
                    accessibilityRole="button"
                    accessibilityLabel="הוספת שורה">
                    <Ionicons name="add" size={16} color={colors.primary} />
                    <Text style={styles.addRowButtonText}>הוספת שורה</Text>
                  </Pressable>

                  {/* Live, admin-only preview - recomputed from the rows
                      above on every keystroke/toggle. Never sent anywhere;
                      the database is the sole authoritative source once
                      finalized/saved. */}
                  <View style={styles.eligibleSummaryBox}>
                    <Text style={styles.eligibleSummaryLine}>
                      {`סכום מוצרי ${isolateLTR('Golden Light')}: ${isolateLTR(`₪${draftEligibleSummary.total.toFixed(2)}`)}`}
                    </Text>
                    <Text style={styles.eligibleSummaryLine}>
                      {`נקודות ${postApprovalEditing ? 'שיינתנו' : 'שיתווספו'}: ${isolateLTR(draftPointsPreview)}`}
                    </Text>
                  </View>

                  {postApprovalEditing ? (
                    <>
                      {manualError ? <Text style={styles.errorText}>{manualError}</Text> : null}
                      <View style={styles.manualFormActionsRow}>
                        <Pressable
                          onPress={cancelPostApprovalEdit}
                          disabled={manualSaving}
                          style={styles.modalCancelButton}
                          accessibilityRole="button">
                          <Text style={styles.modalCancelText}>ביטול</Text>
                        </Pressable>
                        <PrimaryButton
                          title={manualSaving ? 'שומר...' : 'שמירת עדכון'}
                          onPress={savePostApprovalEdit}
                          loading={manualSaving}
                          disabled={manualSaving}
                          style={styles.manualSaveButton}
                        />
                      </View>
                    </>
                  ) : null}
                </>
              ) : (
                <>
                  <View style={styles.sectionHeaderRow}>
                    <Text style={styles.sectionTitle}>פרטי החשבונית</Text>
                    <View style={[styles.statusBadge, styles.manualBadge]}>
                      <Text style={[styles.statusBadgeText, styles.manualBadgeText]}>הוזן ידנית</Text>
                    </View>
                  </View>

                  {isWideManualTable ? (
                    <>
                      <View style={styles.manualTableHeaderRow}>
                        {MANUAL_COLUMNS.map((column) => (
                          <Text
                            key={column.key}
                            style={[
                              styles.manualTableHeaderText,
                              { flex: column.flex },
                              column.key === 'match_status' && styles.manualTableHeaderTextCentered,
                            ]}>
                            {column.label}
                          </Text>
                        ))}
                      </View>
                      {report.manualItems.map((item) => (
                        <View key={item.id} style={styles.manualTableRow}>
                          <Text style={[styles.manualTableCellText, { flex: MANUAL_COLUMNS[0].flex }]}>
                            {item.description}
                          </Text>
                          <Text style={[styles.manualTableCellText, { flex: MANUAL_COLUMNS[1].flex }]}>
                            {item.quantity ?? '—'}
                          </Text>
                          <Text style={[styles.manualTableCellText, { flex: MANUAL_COLUMNS[2].flex }]}>
                            {item.unit_price ?? '—'}
                          </Text>
                          <View style={[styles.manualGoldenLightCell, { flex: MANUAL_COLUMNS[3].flex }]}>
                            <Ionicons
                              name={getManualMatchStatusMeta(item.match_status).icon}
                              size={18}
                              color={getManualMatchStatusMeta(item.match_status).color}
                            />
                            <Text
                              style={[
                                styles.manualMatchStatusCellText,
                                { color: getManualMatchStatusMeta(item.match_status).color },
                              ]}
                              numberOfLines={1}>
                              {item.match_status === 'matched'
                                ? item.matched_product_sku || getManualMatchStatusMeta(item.match_status).label
                                : getManualMatchStatusMeta(item.match_status).label}
                            </Text>
                          </View>
                        </View>
                      ))}
                    </>
                  ) : (
                    <View style={styles.manualItemsList}>
                      {report.manualItems.map((item) => (
                        <View key={item.id} style={styles.manualItemRow}>
                          <Text style={styles.manualItemDescription}>{item.description}</Text>
                          <View style={styles.manualItemMetaRow}>
                            {item.quantity != null ? (
                              <Text style={styles.manualItemMeta}>{`כמות: ${isolateLTR(item.quantity)}`}</Text>
                            ) : null}
                            {item.unit_price != null ? (
                              <Text style={styles.manualItemMeta}>{`מחיר ליח׳: ${isolateLTR(item.unit_price)}`}</Text>
                            ) : null}
                          </View>
                          <View style={styles.manualGoldenLightStackedRow}>
                            <Ionicons
                              name={getManualMatchStatusMeta(item.match_status).icon}
                              size={18}
                              color={getManualMatchStatusMeta(item.match_status).color}
                            />
                            <Text
                              style={[
                                styles.manualGoldenLightStackedLabel,
                                { color: getManualMatchStatusMeta(item.match_status).color },
                              ]}>
                              {item.match_status === 'matched'
                                ? `${item.matched_product_sku ? isolateLTR(item.matched_product_sku) : ''} — ${item.matched_product_name || ''}`.replace(
                                    /^ — /,
                                    '',
                                  )
                                : getManualMatchStatusMeta(item.match_status).label}
                            </Text>
                          </View>
                        </View>
                      ))}
                    </View>
                  )}

                  {isApproved ? (
                    <Pressable onPress={startPostApprovalEdit} style={styles.manualEditLink} accessibilityRole="button">
                      <Text style={styles.manualEditLinkText}>עריכת טיפול</Text>
                    </Pressable>
                  ) : null}
                </>
              )}
            </View>
          ) : isApproved ? (
            // An approved report with no manual items yet (e.g. approved
            // before this workflow existed) - "עריכת טיפול" is still the
            // entry point to add them.
            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>פרטי החשבונית</Text>
              <Text style={styles.emptyText}>לא הוזנו פרטי חשבונית עבור חשבונית זו.</Text>
              <PrimaryButton title="עריכת טיפול" onPress={startPostApprovalEdit} style={styles.manualStartButton} />
            </View>
          ) : null}

          {hasPointsAward ? (
            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>פרטי הענקת הנקודות</Text>
              <View style={styles.pointsAwardedInfoBox}>
                <Text style={styles.pointsAwardedInfoValue}>
                  {`נוספו ${isolateLTR(report.pointsAward.points)} נקודות`}
                </Text>
                {report.pointsAward.eligible_pre_vat_amount != null ? (
                  <Text style={styles.pointsAwardedInfoMeta}>
                    {/* STAGE 8: Number(...).toFixed(2), matching every other
                        eligible-amount display on this screen - this is the
                        one value that comes straight from the DB's NUMERIC
                        column (via report.pointsAward) rather than a
                        client-computed .toFixed(2) preview, and could
                        otherwise show a different number of decimal places
                        than the rest of the screen. */}
                    {`סכום מוצרי ${isolateLTR('Golden Light')}: ${isolateLTR(`₪${Number(report.pointsAward.eligible_pre_vat_amount).toFixed(2)}`)}`}
                  </Text>
                ) : null}
              </View>
            </View>
          ) : null}

          {/* Fallback-only: a report that reached 'approved' before this
              unified workflow existed, and was never separately awarded.
              A freshly-finalized report always has hasPointsAward === true
              immediately, so this never appears for the normal flow. */}
          {isApproved && !hasPointsAward ? (
            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>צבירת נקודות</Text>
              <Text style={styles.emptyText}>
                חשבונית זו אושרה ללא הענקת נקודות. ניתן להעניק נקודות בהתאם לפרטי החשבונית שהוזנו.
              </Text>
              <View style={styles.eligibleSummaryBox}>
                <Text style={styles.eligibleSummaryLine}>
                  {`סכום מוצרי ${isolateLTR('Golden Light')}: ${isolateLTR(`₪${savedEligibleSummary.total.toFixed(2)}`)}`}
                </Text>
                <Text style={styles.eligibleSummaryLine}>{`נקודות שיינתנו: ${isolateLTR(savedPointsPreview)}`}</Text>
              </View>
              {!hasEligibleAmount ? <Text style={styles.emptyText}>לא קיים סכום מזכה עבור החשבונית</Text> : null}
              {pointsError && !awardModalOpen ? <Text style={styles.errorText}>{pointsError}</Text> : null}
              <PrimaryButton
                title="הענקת נקודות"
                onPress={openAwardModal}
                disabled={!hasEligibleAmount || savedPointsPreview <= 0}
                style={styles.pointsAwardButton}
              />
            </View>
          ) : null}

          <View style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>פעולות בדיקה</Text>

            {isReviewable ? (
              <>
                {finalizeBlockingReason ? (
                  <Text style={styles.finalizeHintText}>{finalizeBlockingReason}</Text>
                ) : null}
                <View style={styles.actionsRow}>
                  <PrimaryButton
                    title="אישור וסיום טיפול"
                    onPress={openFinalizeModal}
                    disabled={Boolean(finalizeBlockingReason) || finalizing}
                    style={styles.finalizeButton}
                  />
                  <Pressable
                    onPress={openRejectModal}
                    disabled={finalizing}
                    style={({ pressed }) => [
                      styles.rejectButton,
                      pressed && styles.rejectButtonPressed,
                      finalizing && styles.rejectButtonDisabled,
                    ]}
                    accessibilityRole="button">
                    <Text style={styles.rejectButtonText}>דחיית חשבונית</Text>
                  </Pressable>
                </View>
              </>
            ) : isFinalized ? (
              <View style={[styles.decisionBox, isApproved ? styles.decisionBoxApproved : styles.decisionBoxRejected]}>
                <Text style={[styles.decisionText, isApproved ? styles.decisionTextApproved : styles.decisionTextRejected]}>
                  {isApproved ? 'החשבונית אושרה' : 'החשבונית נדחתה'}
                </Text>
                {report.reviewed_at ? (
                  <Text style={styles.decisionMeta}>{`טופלה ב-${formatReportDate(report.reviewed_at)}`}</Text>
                ) : null}
                {isRejected && report.rejection_reason ? (
                  <>
                    <Text style={styles.rejectionReasonLabel}>סיבת הדחייה</Text>
                    <Text style={styles.rejectionReasonText}>{report.rejection_reason}</Text>
                  </>
                ) : null}
              </View>
            ) : (
              <Text style={styles.emptyText}>החשבונית בעיבוד אוטומטי ואינה זמינה לבדיקה ידנית כרגע.</Text>
            )}
          </View>
        </>
      )}

      <Modal visible={finalizeModalOpen} transparent animationType="fade" onRequestClose={closeFinalizeModal}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>אישור וסיום טיפול</Text>
            <Text style={styles.modalSubtitle}>
              {`סכום מזכה: ${isolateLTR(`₪${draftEligibleSummary.total.toFixed(2)}`)}`}
            </Text>
            <Text style={styles.modalSubtitle}>{`נקודות שיתווספו: ${isolateLTR(draftPointsPreview)}`}</Text>
            {finalizeError ? <Text style={styles.modalErrorText}>{finalizeError}</Text> : null}
            <View style={styles.modalActionsRow}>
              <Pressable
                onPress={closeFinalizeModal}
                disabled={finalizing}
                style={styles.modalCancelButton}
                accessibilityRole="button">
                <Text style={styles.modalCancelText}>ביטול</Text>
              </Pressable>
              <PrimaryButton
                title={finalizing ? 'מעדכן...' : 'אישור וסיום'}
                onPress={handleFinalize}
                loading={finalizing}
                disabled={finalizing}
                style={styles.modalConfirmButton}
              />
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={rejectModalOpen} transparent animationType="fade" onRequestClose={closeRejectModal}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>דחיית חשבונית</Text>
            <Text style={styles.modalLabel}>סיבת הדחייה</Text>
            <TextInput
              value={rejectReason}
              onChangeText={setRejectReason}
              placeholder="הזינו את הסיבה לדחיית החשבונית"
              placeholderTextColor={colors.textMuted}
              accessibilityLabel="סיבת הדחייה"
              multiline
              numberOfLines={4}
              maxLength={1000}
              editable={!rejecting}
              textAlign="right"
              writingDirection="rtl"
              style={styles.modalTextarea}
            />
            {rejectError ? <Text style={styles.modalErrorText}>{rejectError}</Text> : null}
            <View style={styles.modalActionsRow}>
              <Pressable
                onPress={closeRejectModal}
                disabled={rejecting}
                style={styles.modalCancelButton}
                accessibilityRole="button">
                <Text style={styles.modalCancelText}>ביטול</Text>
              </Pressable>
              <Pressable
                onPress={handleReject}
                disabled={rejecting || !rejectReason.trim()}
                style={[
                  styles.modalRejectConfirmButton,
                  (rejecting || !rejectReason.trim()) && styles.modalRejectConfirmButtonDisabled,
                ]}
                accessibilityRole="button">
                {rejecting ? (
                  <ActivityIndicator color={colors.white} size="small" />
                ) : (
                  <Text style={styles.modalRejectConfirmText}>דחיית החשבונית</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={awardModalOpen} transparent animationType="fade" onRequestClose={closeAwardModal}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>האם להעניק את הנקודות?</Text>
            <Text style={styles.modalSubtitle}>
              {`סכום מוצרי ${isolateLTR('Golden Light')}: ${isolateLTR(`₪${savedEligibleSummary.total.toFixed(2)}`)}`}
            </Text>
            <Text style={styles.modalSubtitle}>{`נקודות לזיכוי: ${isolateLTR(savedPointsPreview)}`}</Text>
            {pointsError ? <Text style={styles.modalErrorText}>{pointsError}</Text> : null}
            <View style={styles.modalActionsRow}>
              <Pressable onPress={closeAwardModal} disabled={awarding} style={styles.modalCancelButton} accessibilityRole="button">
                <Text style={styles.modalCancelText}>ביטול</Text>
              </Pressable>
              <PrimaryButton
                title={awarding ? 'מעניק...' : 'אישור והענקת נקודות'}
                onPress={handleAwardPoints}
                loading={awarding}
                disabled={awarding}
                style={styles.modalConfirmButton}
              />
            </View>
          </View>
        </View>
      </Modal>

      {/* Product-match modal: the ONE place a manual receipt line gets
          linked to a real Golden Light product (or explicitly marked as
          not one) - and the ONLY place any catalog lookup happens at all.
          The main row itself (description/quantity/unit_price/status cell)
          never shows a SKU or barcode field - every lookup, by SKU, barcode,
          or description/name, goes through the single search box below via
          getProductSuggestions() (productMatching.js). Reused for every row
          - identified by matchModal.rowKey - rather than one modal instance
          per row. Nothing here writes to the database directly: it only
          updates the in-progress manualRows draft (via
          selectRowProduct/markRowNotGoldenLight/resetRowMatch above), which
          is persisted the same way every other row edit already is - via
          handleFinalize/savePostApprovalEdit calling
          buildManualItemsPayload() and the existing save RPC. */}
      <Modal visible={matchModal.open} transparent animationType="fade" onRequestClose={closeMatchModal}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, styles.matchModalCard]}>
            <Text style={styles.modalTitle}>{`בחירת מוצר ${isolateLTR('Golden Light')}`}</Text>
            {activeMatchRow ? (
              <Text style={styles.modalSubtitle} numberOfLines={2}>
                {activeMatchRow.description || 'שורה ללא תיאור'}
              </Text>
            ) : null}

            {catalogError ? <Text style={styles.modalErrorText}>{catalogError}</Text> : null}

            <Text style={styles.modalLabel}>חיפוש מוצר (תיאור, מק״ט או ברקוד)</Text>
            <AppInput
              value={matchModal.searchQuery}
              onChangeText={setMatchModalSearchQuery}
              placeholder="הקלידו תיאור מוצר, מק״ט או ברקוד..."
              accessibilityLabel="חיפוש מוצר Golden Light"
              style={styles.manualFormField}
            />

            <ScrollView style={styles.matchModalScroll} nestedScrollEnabled>
              {matchSearchResults.map((product) => (
                <Pressable
                  key={product.id}
                  onPress={() => selectRowProduct(product, 'manual', null)}
                  style={styles.productPickRow}
                  accessibilityRole="button">
                  <View style={styles.productPickTextBox}>
                    <Text style={styles.productPickSku}>{product.sku}</Text>
                    <Text style={styles.productPickName} numberOfLines={1}>
                      {product.name}
                    </Text>
                    {product.productFamily ? (
                      <Text style={styles.productPickSubtitle}>{product.productFamily}</Text>
                    ) : null}
                  </View>
                  <Ionicons name="chevron-back" size={16} color={colors.textMuted} />
                </Pressable>
              ))}
              {matchModal.searchQuery.trim() && matchSearchResults.length === 0 ? (
                <Text style={styles.emptyText}>לא נמצאו מוצרים תואמים.</Text>
              ) : null}
            </ScrollView>

            <View style={styles.matchModalFooterRow}>
              <Pressable onPress={resetRowMatch} accessibilityRole="button" style={styles.modalCancelButton}>
                <Text style={styles.modalCancelText}>איפוס</Text>
              </Pressable>
              <Pressable onPress={markRowNotGoldenLight} accessibilityRole="button" style={styles.matchNotGoldenLightButton}>
                <Text style={styles.matchNotGoldenLightButtonText}>{`לא מוצר ${isolateLTR('Golden Light')}`}</Text>
              </Pressable>
              <Pressable onPress={closeMatchModal} accessibilityRole="button" style={styles.modalCancelButton}>
                <Text style={styles.modalCancelText}>סגירה</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Fullscreen click-to-enlarge viewer - the same dark-overlay + small
          circular top-right X convention already used for the profile
          avatar preview (see ProfileScreen.js's avatarPreviewVisible
          modal): a dim backdrop that closes on tap, and the image/close
          button as its SIBLINGS (not children) so the backdrop's own dim
          color can never cascade onto them. Deliberately nothing else -
          no title, date, or other control belongs in this view. */}
      <Modal visible={previewOpen} transparent animationType="fade" onRequestClose={() => setPreviewOpen(false)}>
        <View style={styles.previewRoot}>
          <Pressable
            style={styles.previewBackdrop}
            onPress={() => setPreviewOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="סגירה"
          />

          {imageState.status === 'ready' && imageState.url ? (
            <Image
              source={{ uri: imageState.url }}
              style={[styles.previewImage, { width: fullscreenPreviewWidth, height: fullscreenPreviewHeight }]}
              resizeMode="contain"
            />
          ) : null}

          <Pressable
            style={styles.previewCloseButton}
            onPress={() => setPreviewOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="סגירה"
            hitSlop={10}>
            <Ionicons name="close" size={22} color={colors.textOnDark} />
          </Pressable>
        </View>
      </Modal>
    </AdminShell>
  );
}

const styles = StyleSheet.create({
  backRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.xs,
    alignSelf: 'flex-end',
  },
  backText: {
    ...typography.caption,
    fontWeight: '700',
    color: colors.primary,
  },
  stateCard: {
    minHeight: 160,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  errorText: {
    ...typography.body,
    fontWeight: '700',
    color: colors.error,
    textAlign: 'center',
  },
  retryText: {
    ...typography.caption,
    fontWeight: '700',
    color: colors.primary,
    textAlign: 'center',
  },
  emptyText: {
    ...typography.caption,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
  },
  headerCard: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.xs,
    ...shadows.softCard,
  },
  headerTopRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  customerName: {
    ...typography.title,
    color: colors.text,
    textAlign: 'right',
    // STAGE 8: a long name must truncate (numberOfLines=1 in the render)
    // rather than push the status badge off the narrow-mobile viewport -
    // RN doesn't shrink an unconstrained Text by default, so without this
    // a long name could overflow headerTopRow horizontally.
    flexShrink: 1,
  },
  // The ONE small "who + when" line under the heading - deliberately the
  // only upload metadata shown (see the header card's comment above). Kept
  // visually secondary: smaller/muted, never competing with the customer
  // name title above it.
  uploadMetaLine: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'right',
  },
  pointsLine: {
    ...typography.caption,
    fontWeight: '700',
    color: colors.success,
    textAlign: 'right',
  },
  // The large receipt preview - deliberately NOT a fixed-height box: its
  // actual size comes from the receiptImage aspectRatio style below (the
  // image's real aspect ratio, fit within a generous bounding box), so a
  // portrait phone photo renders tall/narrow and a landscape photo renders
  // wide, neither ever stretched or cropped. minHeight only guards the
  // loading/error/PDF placeholder states (imagePlaceholder) and the brief
  // moment before the image's natural size has resolved.
  imageCard: {
    minHeight: 220,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
    overflow: 'hidden',
    ...shadows.softCard,
  },
  // Hover/press feedback only matters when the preview is actually
  // clickable (canOpenPreview) - a subtle tint, not a jarring color change,
  // keeping the receipt itself the visual focus.
  imageCardHovered: {
    borderColor: colors.primary,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  imageCardPressed: {
    opacity: 0.92,
  },
  // Explicit pixel width/height are applied inline once the real natural
  // size is known (see receiptDisplaySize) - this base style is only the
  // fallback before that resolves.
  receiptImage: {
    width: '100%',
    minHeight: 220,
  },
  // A small, understated "tap to enlarge" affordance in the corner of the
  // preview - never covers the receipt itself, never competes with it.
  enlargeHint: {
    position: 'absolute',
    bottom: spacing.sm,
    left: spacing.sm,
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(11,11,11,0.55)',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  enlargeHintText: {
    ...typography.caption,
    fontSize: 11,
    fontWeight: '600',
    color: colors.white,
  },
  imagePlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xxl,
  },
  imagePlaceholderText: {
    ...typography.caption,
    color: colors.textMuted,
  },
  // Fullscreen click-to-enlarge viewer - same conventions as the profile
  // avatar preview (see ProfileScreen.js): dark backdrop, backdrop-tap and
  // top-right X both close it, no other content.
  previewRoot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(6, 10, 10, 0.9)',
  },
  previewImage: {
    // width/height applied inline per-render (see fullscreenPreviewWidth/
    // Height above) - a plain fixed bounding box that resizeMode="contain"
    // then letterboxes the real image within, matching its true ratio.
  },
  previewCloseButton: {
    position: 'absolute',
    top: spacing.xxl,
    right: spacing.lg,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionCard: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.sm,
    ...shadows.softCard,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  statusBadge: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    flexShrink: 0,
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'center',
  },
  // Final review actions.
  actionsRow: {
    flexDirection: 'row-reverse',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  finalizeButton: {
    flexGrow: 1,
    flexBasis: 200,
  },
  finalizeHintText: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.textMuted,
    textAlign: 'right',
  },
  rejectButton: {
    flexGrow: 1,
    flexBasis: 200,
    minHeight: 52,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.error,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  rejectButtonPressed: {
    backgroundColor: colors.errorSoft,
  },
  rejectButtonDisabled: {
    opacity: 0.6,
  },
  rejectButtonText: {
    fontSize: typography.button.fontSize,
    fontWeight: typography.button.fontWeight,
    color: colors.error,
  },
  decisionBox: {
    borderRadius: radius.md,
    padding: spacing.md,
    alignItems: 'flex-end',
    gap: 2,
  },
  decisionBoxApproved: {
    backgroundColor: colors.successSoft,
  },
  decisionBoxRejected: {
    backgroundColor: colors.errorSoft,
  },
  decisionText: {
    ...typography.body,
    fontWeight: '700',
    textAlign: 'right',
  },
  decisionTextApproved: {
    color: colors.success,
  },
  decisionTextRejected: {
    color: colors.error,
  },
  decisionMeta: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'right',
  },
  rejectionReasonLabel: {
    ...typography.caption,
    fontWeight: '700',
    color: colors.error,
    textAlign: 'right',
    marginTop: spacing.sm,
  },
  rejectionReasonText: {
    ...typography.caption,
    color: colors.text,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  // Decision modals.
  modalOverlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(6, 10, 10, 0.55)',
    padding: spacing.xl,
  },
  modalCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    padding: spacing.xl,
    gap: spacing.sm,
    ...shadows.premiumCard,
  },
  modalTitle: {
    ...typography.title,
    color: colors.text,
    textAlign: 'right',
  },
  modalSubtitle: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'right',
  },
  modalLabel: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.text,
    textAlign: 'right',
    marginTop: spacing.xs,
  },
  modalTextarea: {
    minHeight: 96,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.sm,
    color: colors.text,
    fontSize: typography.body.fontSize,
    textAlignVertical: 'top',
  },
  modalErrorText: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.error,
    textAlign: 'right',
  },
  modalActionsRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  modalCancelButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
  },
  modalCancelText: {
    ...typography.body,
    fontWeight: '600',
    color: colors.textMuted,
  },
  modalConfirmButton: {
    flex: 1,
  },
  modalRejectConfirmButton: {
    flex: 1,
    minHeight: 52,
    borderRadius: radius.lg,
    backgroundColor: colors.error,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  modalRejectConfirmButtonDisabled: {
    opacity: 0.5,
  },
  modalRejectConfirmText: {
    fontSize: typography.button.fontSize,
    fontWeight: typography.button.fontWeight,
    color: colors.white,
  },
  // Manual items / unified review form.
  sectionHeaderRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  manualBadge: {
    backgroundColor: colors.primarySoft,
    alignSelf: 'flex-start',
  },
  manualBadgeText: {
    color: colors.primaryPressed,
  },
  manualStartButton: {
    marginTop: spacing.xs,
  },
  manualEditLink: {
    alignSelf: 'flex-end',
    marginTop: spacing.xs,
  },
  manualEditLinkText: {
    ...typography.caption,
    fontWeight: '700',
    color: colors.primary,
  },
  postApprovalNoticeText: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.primaryPressed,
    textAlign: 'right',
  },
  // Wide/desktop table layout - shared column proportions (MANUAL_COLUMNS)
  // between the header row, editable rows, and read-only rows so
  // everything lines up.
  manualTableHeaderRow: {
    flexDirection: 'row-reverse',
    gap: spacing.sm,
    paddingBottom: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  manualTableHeaderText: {
    ...typography.caption,
    fontWeight: '700',
    color: colors.textMuted,
    textAlign: 'right',
  },
  manualTableDeleteHeaderCell: {
    width: 32,
  },
  manualTableRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.surfaceMuted,
    paddingTop: spacing.sm,
  },
  manualTableCellInput: {
    marginBottom: 0,
  },
  // STAGE 8: a row-level control (input/button) disabled while a
  // save/finalize request is in flight (rowsDisabled) is otherwise
  // visually identical to an active one, even though it no longer
  // responds to touch - dims it so "this is temporarily locked" is
  // obvious without relying on trying to interact with it. Matches
  // PrimaryButton's own existing disabled treatment (opacity 0.7) closely
  // enough to read as the same convention, not a new one.
  rowControlDisabled: {
    opacity: 0.55,
  },
  // On its own, elevating just the manual-item row (below) only wins
  // against ITS OWN siblings inside the same "פרטי החשבונית" section card
  // (other rows, the eligible-total summary) - none of that matters if the
  // section card itself doesn't outrank ITS sibling section cards below it
  // ("פעולות בדיקה", the points-award cards, ...), since react-native-web
  // gives every View `position: relative` by default and none of these
  // cards otherwise establish their own stacking context: the FIRST
  // ancestor in the chain that has an explicit zIndex is the one whose
  // rank actually decides paint order against sibling cards. This is what
  // fixes the dropdown being visually covered by cards further down the
  // page - applied to the whole "פרטי החשבונית" sectionCard, and only
  // while a dropdown is actually open (never a permanent elevation).
  manualSectionElevated: {
    zIndex: 40,
  },
  // Elevates a manual-item row above its own siblings within the SAME
  // section card (other rows, the eligible-total summary below the list)
  // while its dropdown is open.
  manualRowElevated: {
    zIndex: 30,
  },
  // Wraps the description AppInput (in both the wide-table cell and the
  // narrow-stacked field) so DescriptionSuggestionDropdown, absolutely
  // positioned below it, anchors to this exact field rather than the row.
  descriptionCellAnchor: {
    position: 'relative',
    zIndex: 1,
  },
  // The floating autocomplete panel itself - visually belongs to the
  // description field it hangs off, not a separate modal/card: white
  // surface, subtle border, soft shadow, sits directly below the input
  // without pushing the rest of the table down (position: 'absolute').
  // Its own zIndex is on top of the elevation chain above
  // (manualSectionElevated -> manualRowElevated -> this), so it always
  // paints above the description input itself and anything else in the row.
  descriptionSuggestionDropdown: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    marginTop: 4,
    zIndex: 50,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    ...shadows.md,
  },
  // Caps the panel's height and scrolls internally once there are more
  // suggestions than fit, instead of growing indefinitely. A plain View
  // with overflow scroll here (not the RN ScrollView component) - simpler,
  // and avoids ScrollView's own internal scroll-container layering
  // interacting oddly with the zIndex chain above on web.
  descriptionSuggestionScroll: {
    maxHeight: 260,
    ...Platform.select({ web: { overflowY: 'auto' }, default: { overflow: 'scroll' } }),
  },
  descriptionSuggestionRow: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    alignItems: 'flex-end',
    backgroundColor: colors.white,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  descriptionSuggestionRowSeparator: {
    borderTopWidth: 1,
    borderTopColor: colors.surfaceMuted,
  },
  descriptionSuggestionRowActive: {
    backgroundColor: colors.primarySoft,
  },
  descriptionSuggestionName: {
    ...typography.caption,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  descriptionSuggestionSku: {
    ...typography.caption,
    fontSize: 11,
    color: colors.primary,
    textAlign: 'right',
  },
  manualTableCellText: {
    ...typography.caption,
    color: colors.text,
    textAlign: 'right',
  },
  manualTableDeleteCell: {
    width: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Narrow/mobile stacked layout.
  manualFormRows: {
    gap: spacing.md,
  },
  manualStackedRow: {
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.surfaceMuted,
    paddingTop: spacing.sm,
  },
  manualStackedRowHeader: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  manualStackedRowIndex: {
    ...typography.caption,
    fontWeight: '700',
    color: colors.textMuted,
  },
  manualFormField: {
    marginBottom: 0,
  },
  manualFormFieldsRow: {
    flexDirection: 'row-reverse',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  manualFormFieldHalf: {
    flexGrow: 1,
    flexBasis: 140,
    marginBottom: 0,
  },
  manualItemsList: {
    gap: spacing.sm,
  },
  manualItemRow: {
    borderTopWidth: 1,
    borderTopColor: colors.surfaceMuted,
    paddingTop: spacing.sm,
    alignItems: 'flex-end',
    gap: 2,
  },
  manualItemDescription: {
    ...typography.body,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  manualItemMetaRow: {
    flexDirection: 'row-reverse',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  manualItemMeta: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'right',
  },
  addRowButton: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    alignSelf: 'flex-end',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  addRowButtonText: {
    ...typography.caption,
    fontWeight: '700',
    color: colors.primary,
  },
  manualFormActionsRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  manualSaveButton: {
    flex: 1,
  },
  // Automatic eligible-total/points preview - shared by the live editing
  // draft (reviewable report or post-approval correction) and the fallback
  // award section (all admin-only, never editable, never sent as-is - the
  // database independently recalculates the authoritative value).
  eligibleSummaryBox: {
    width: '100%',
    backgroundColor: colors.primarySoft,
    borderRadius: radius.md,
    padding: spacing.md,
    alignItems: 'flex-end',
    gap: 2,
  },
  eligibleSummaryLine: {
    ...typography.caption,
    fontWeight: '700',
    color: colors.primaryPressed,
    textAlign: 'right',
  },
  // "מוצר Golden Light" checkbox cell (wide table).
  manualTableHeaderTextCentered: {
    textAlign: 'center',
  },
  manualGoldenLightCell: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  manualMatchStatusPressable: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    maxWidth: '100%',
  },
  manualMatchStatusCellText: {
    ...typography.caption,
    fontWeight: '700',
    maxWidth: 90,
  },
  // "מוצר Golden Light" checkbox row (narrow/stacked layout).
  manualGoldenLightStackedRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.xs,
  },
  manualGoldenLightStackedLabel: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.text,
    textAlign: 'right',
    flexShrink: 1,
  },
  manualRowWarningText: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.error,
    textAlign: 'right',
  },
  // Stage 4 OCR prefill hint - deliberately muted/non-alarming (never
  // colors.error, which manualRowWarningText above already owns for a
  // real blocking problem) and small, so a still-untouched OCR row reads
  // as "worth a glance", not "broken". See getOcrNormalizationHint.
  ocrNormalizationHintText: {
    ...typography.caption,
    fontSize: 11,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: 2,
  },
  // Product-match modal (bחירת מוצר Golden Light).
  matchModalCard: {
    maxWidth: 480,
    maxHeight: '85%',
  },
  matchModalScroll: {
    maxHeight: 320,
  },
  productPickRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    marginTop: spacing.xs,
  },
  productPickTextBox: {
    flex: 1,
    gap: 2,
  },
  productPickSku: {
    ...typography.caption,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  productPickName: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'right',
  },
  productPickSubtitle: {
    ...typography.caption,
    fontSize: 11,
    color: colors.primary,
    textAlign: 'right',
  },
  matchModalFooterRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  matchNotGoldenLightButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.error,
  },
  matchNotGoldenLightButtonText: {
    ...typography.caption,
    fontWeight: '700',
    color: colors.error,
  },
  pointsAwardButton: {
    marginTop: spacing.xs,
  },
  pointsAwardedInfoBox: {
    width: '100%',
    backgroundColor: colors.successSoft,
    borderRadius: radius.md,
    padding: spacing.md,
    alignItems: 'flex-end',
    gap: 2,
  },
  pointsAwardedInfoValue: {
    ...typography.body,
    fontWeight: '700',
    color: colors.success,
    textAlign: 'right',
  },
  pointsAwardedInfoMeta: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'right',
  },
});
