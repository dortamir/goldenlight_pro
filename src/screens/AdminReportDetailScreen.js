import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
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
  rejectAdminReport,
  REVIEWABLE_STATUSES,
  saveAdminManualItems,
} from '../services/adminReportService';
import { colors, radius, shadows, spacing, typography } from '../theme';

// Below this content width, the manual-entry table collapses to stacked
// fields per row instead of a horizontal table row - a real Hebrew label +
// input pair no longer fits five-across at phone/narrow-tablet widths.
const MANUAL_TABLE_MIN_WIDTH = 720;

// sku and line_total are intentionally NOT part of this form - see
// 016_simplify_eligible_amount_calc.sql. The admin manual-review workflow
// only ever collects description/quantity/unit_price/is_golden_light; the
// database columns for sku/line_total still exist (for any historical row
// entered before this change, and for possible future OCR use) but are
// neither displayed nor sent as authoritative input by this screen anymore.
const MANUAL_COLUMNS = [
  { key: 'description', label: 'תיאור מוצר', flex: 3.4 },
  { key: 'quantity', label: 'כמות', flex: 1.1 },
  { key: 'unit_price', label: 'מחיר ליחידה', flex: 1.5 },
  { key: 'is_golden_light', label: 'מוצר Golden Light', flex: 1.3 },
];

let manualRowSeq = 0;
function createEmptyManualRow() {
  manualRowSeq += 1;
  return {
    key: `row-${manualRowSeq}`,
    description: '',
    quantity: '',
    unit_price: '',
    is_golden_light: false,
  };
}

// Preloads the editable form with the saved rows, or a single empty row
// when none exist yet - "not zero, not multiple blank rows". Shared by the
// always-editable reviewable-report table and the post-approval
// "עריכת טיפול" correction flow. Any sku/line_total a saved row might still
// carry from before this change is intentionally not surfaced here - see
// the module comment above MANUAL_COLUMNS.
function buildRowsFromManualItems(items) {
  return items && items.length > 0
    ? items.map((item) => ({
        key: item.id,
        description: item.description || '',
        quantity: item.quantity != null ? String(item.quantity) : '',
        unit_price: item.unit_price != null ? String(item.unit_price) : '',
        is_golden_light: Boolean(item.is_golden_light),
      }))
    : [createEmptyManualRow()];
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
// left completely untouched (every field blank) is dropped silently - the
// common case after pressing "+ הוספת שורה" and not using it; a row with
// SOME data but a missing description is rejected as an error.
//
// sku/line_total are always sent as null - this form never collects them
// (see 016_simplify_eligible_amount_calc.sql). The database columns still
// accept them (for any future OCR-populated write path), this screen simply
// never populates them anymore.
function buildManualItemsPayload(rows) {
  const trimmedRows = rows.map((row) => ({
    description: row.description.trim(),
    quantity: row.quantity.trim(),
    unit_price: row.unit_price.trim(),
    is_golden_light: Boolean(row.is_golden_light),
  }));

  const nonEmptyRows = trimmedRows.filter((row) => row.description || row.quantity || row.unit_price);

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

    return {
      description: row.description,
      sku: null,
      quantity: parseOptionalPositiveNumber(row.quantity, 'invalid_quantity'),
      unit_price: parseOptionalNonNegativeNumber(row.unit_price, 'invalid_unit_price'),
      line_total: null,
      is_golden_light: row.is_golden_light,
    };
  });
}

function isPdfFile(name) {
  return /\.pdf$/i.test(String(name || ''));
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

function getOcrStatusMeta(status) {
  switch (status) {
    case 'completed':
      return { label: 'הושלם', backgroundColor: colors.successSoft, textColor: colors.success };
    case 'processing':
      return { label: 'בעיבוד', backgroundColor: colors.primarySoft, textColor: colors.primary };
    case 'failed':
      return { label: 'נכשל', backgroundColor: colors.errorSoft, textColor: colors.error };
    case 'pending':
    default:
      return { label: 'ממתין', backgroundColor: colors.surfaceMuted, textColor: colors.textMuted };
  }
}

function getMatchStatusMeta(status) {
  switch (status) {
    case 'matched':
      return { label: 'זוהה מוצר', backgroundColor: colors.successSoft, textColor: colors.success };
    case 'needs_review':
      return { label: 'דורש בדיקה', backgroundColor: colors.surfaceMuted, textColor: colors.textMuted };
    case 'unmatched':
    default:
      return { label: 'לא זוהה מוצר', backgroundColor: colors.surfaceMuted, textColor: colors.textMuted };
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
      return 'ערך לא תקין עבור סימון מוצר Golden Light.';
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

// Client-side-only gate for enabling "אישור וסיום טיפול" - re-validates the
// exact same rules the database will (buildManualItemsPayload, then the
// Golden-Light-eligibility/points rules public.finalize_purchase_report()
// enforces via save_manual_receipt_items()/award_purchase_points()), purely
// so the button can stay disabled with a specific, actionable explanation
// instead of letting the admin submit and only then see a generic failure.
// The database remains the real authority regardless - this can never be
// used to bypass anything server-side.
function getFinalizeBlockingReason(rows) {
  let payload;
  try {
    payload = buildManualItemsPayload(rows);
  } catch (err) {
    return getActionErrorMessage(err);
  }

  const summary = summarizeEligibleRows(payload, (item, index) => ({
    key: index,
    isGoldenLight: item.is_golden_light,
    quantity: item.quantity,
    unitPrice: item.unit_price,
  }));

  if (summary.missingPriceKeys.length > 0) {
    return 'יש להזין כמות ומחיר ליחידה תקינים עבור כל מוצרי ה-Golden Light המסומנים.';
  }
  if (summary.total <= 0) {
    return 'יש לסמן לפחות מוצר Golden Light אחד עם סכום זכאי תקין לפני האישור.';
  }
  if (Math.floor(summary.total * 0.2) <= 0) {
    return 'הסכום הזכאי אינו מספיק להענקת נקודות.';
  }
  return null;
}

export default function AdminReportDetailScreen() {
  const { id } = useLocalSearchParams();
  const router = useRouter();
  const { width: windowWidth } = useWindowDimensions();
  const isWideManualTable = windowWidth >= MANUAL_TABLE_MIN_WIDTH;
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [imageState, setImageState] = useState({ status: 'idle', url: null });

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

  const loadDetail = useCallback(() => {
    if (!id) {
      return;
    }

    setLoading(true);
    setError('');
    setNotFound(false);
    setImageState({ status: 'idle', url: null });
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

    getAdminReportDetail(id)
      .then((data) => {
        if (!data) {
          setNotFound(true);
          return;
        }

        setReport(data);

        // A reviewable report's line-item table is always editable - no
        // separate "start editing" step - preloaded from whatever manual
        // items already exist (or one empty row for a brand-new report).
        if (REVIEWABLE_STATUSES.includes(data.status)) {
          setManualRows(buildRowsFromManualItems(data.manualItems));
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

  const addManualRow = () => {
    setManualRows((rows) => [...rows, createEmptyManualRow()]);
  };

  // If this is the only remaining row, clear it in place instead of
  // removing it - the form must never end up with zero rows while editing.
  const removeManualRow = (key) => {
    setManualRows((rows) => {
      if (rows.length <= 1) {
        return rows.map((row) =>
          row.key === key ? { ...row, description: '', quantity: '', unit_price: '' } : row,
        );
      }
      return rows.filter((row) => row.key !== key);
    });
  };

  const updateManualRow = (key, field, value) => {
    setManualRows((rows) => rows.map((row) => (row.key === key ? { ...row, [field]: value } : row)));
  };

  const toggleManualRowGoldenLight = (key) => {
    setManualRows((rows) =>
      rows.map((row) => (row.key === key ? { ...row, is_golden_light: !row.is_golden_light } : row)),
    );
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
      setFinalizeError(getActionErrorMessage(err));
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
  const statusMeta = report ? getStatusMeta(report.status) : null;
  const ocrStatusMeta = report?.ocrResult ? getOcrStatusMeta(report.ocrResult.status) : null;
  const matchByLineId = new Map((report?.lineMatches || []).map((match) => [match.ocr_line_id, match]));
  const isReviewable = report ? REVIEWABLE_STATUSES.includes(report.status) : false;
  const isApproved = report?.status === 'approved';
  const isRejected = report?.status === 'rejected';
  const isFinalized = isApproved || isRejected;
  const hasManualItems = Boolean(report?.manualItems && report.manualItems.length > 0);
  const hasPointsAward = Boolean(report?.pointsAward);
  const isEditingRows = isReviewable || postApprovalEditing;

  // Live draft preview - recomputed on every render from the in-progress
  // manualRows editing state (never persisted), so it updates immediately
  // as the admin marks/unmarks "מוצר Golden Light" or edits
  // quantity/unit_price. Admin-only, never sent anywhere. Used both for the
  // reviewable-report finalize flow and the post-approval correction
  // preview.
  const draftEligibleSummary = summarizeEligibleRows(manualRows, (row) => ({
    key: row.key,
    isGoldenLight: row.is_golden_light,
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
    isGoldenLight: item.is_golden_light,
    quantity: item.quantity,
    unitPrice: item.unit_price,
  }));
  const savedPointsPreview = Math.floor(savedEligibleSummary.total * 0.2);
  const hasEligibleAmount = savedEligibleSummary.total > 0;

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
              <Text style={styles.customerName}>{report.customerName || 'משתמש ללא שם'}</Text>
              <View style={[styles.statusBadge, { backgroundColor: statusMeta.backgroundColor }]}>
                <Text style={[styles.statusBadgeText, { color: statusMeta.textColor }]}>{statusMeta.label}</Text>
              </View>
            </View>
            <Text style={styles.metaLine}>{`הועלתה ב-${formatReportDate(report.created_at)}`}</Text>
            <Text style={styles.metaLine}>{report.original_filename || 'חשבונית'}</Text>
            {report.points_awarded > 0 ? (
              <Text style={styles.pointsLine}>{`נצברו ${report.points_awarded} נק׳`}</Text>
            ) : null}
          </View>

          <View style={styles.imageCard}>
            {isPdf ? (
              <View style={styles.imagePlaceholder}>
                <Ionicons name="document-text-outline" size={28} color={colors.textMuted} />
                <Text style={styles.imagePlaceholderText}>קובץ PDF</Text>
              </View>
            ) : imageState.status === 'ready' && imageState.url ? (
              <Image source={{ uri: imageState.url }} style={styles.receiptImage} resizeMode="contain" />
            ) : imageState.status === 'loading' ? (
              <View style={styles.imagePlaceholder}>
                <ActivityIndicator color={colors.primary} size="small" />
              </View>
            ) : (
              <View style={styles.imagePlaceholder}>
                <Text style={styles.imagePlaceholderText}>לא ניתן לטעון את התמונה</Text>
              </View>
            )}
          </View>

          <View style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>סטטוס זיהוי OCR</Text>
            {report.ocrResult ? (
              <>
                <View style={[styles.statusBadge, styles.sectionBadge, { backgroundColor: ocrStatusMeta.backgroundColor }]}>
                  <Text style={[styles.statusBadgeText, { color: ocrStatusMeta.textColor }]}>{ocrStatusMeta.label}</Text>
                </View>

                {report.ocrLines.length === 0 ? (
                  <Text style={styles.emptyText}>לא זוהו שורות בחשבונית</Text>
                ) : (
                  <View style={styles.linesList}>
                    {report.ocrLines.map((line) => {
                      const match = matchByLineId.get(line.id);
                      const matchMeta = match ? getMatchStatusMeta(match.match_status) : null;

                      return (
                        <View key={line.id} style={styles.lineRow}>
                          <Text style={styles.lineText} numberOfLines={2}>
                            {line.raw_text}
                          </Text>
                          {matchMeta ? (
                            <View style={[styles.statusBadge, { backgroundColor: matchMeta.backgroundColor }]}>
                              <Text style={[styles.statusBadgeText, { color: matchMeta.textColor }]}>
                                {matchMeta.label}
                              </Text>
                            </View>
                          ) : null}
                        </View>
                      );
                    })}
                  </View>
                )}
              </>
            ) : (
              <Text style={styles.emptyText}>עדיין לא בוצע זיהוי OCR לחשבונית זו</Text>
            )}
          </View>

          {/* Unified "פרטי החשבונית" section - always editable while the
              report is reviewable (isEditingRows via isReviewable), or
              editable in the clearly separate, points-safe "עריכת טיפול"
              mode for an approved report. Otherwise (rejected, processing,
              or an approved report not currently being corrected) it's a
              plain read-only display of the last saved rows. */}
          {isEditingRows || hasManualItems ? (
            <View style={styles.sectionCard}>
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
                            column.key === 'is_golden_light' && styles.manualTableHeaderTextCentered,
                          ]}>
                          {column.label}
                        </Text>
                      ))}
                      <View style={styles.manualTableDeleteHeaderCell} />
                    </View>
                  ) : null}

                  <View style={styles.manualFormRows}>
                    {manualRows.map((row, index) =>
                      isWideManualTable ? (
                        <View key={row.key} style={styles.manualTableRow}>
                          <View style={{ flex: MANUAL_COLUMNS[0].flex }}>
                            <AppInput
                              value={row.description}
                              onChangeText={(value) => updateManualRow(row.key, 'description', value)}
                              placeholder="תיאור מוצר"
                              editable={!manualSaving && !finalizing}
                              style={styles.manualTableCellInput}
                            />
                          </View>
                          <View style={{ flex: MANUAL_COLUMNS[1].flex }}>
                            <AppInput
                              value={row.quantity}
                              onChangeText={(value) => updateManualRow(row.key, 'quantity', value)}
                              placeholder="כמות"
                              keyboardType="decimal-pad"
                              editable={!manualSaving && !finalizing}
                              textAlign="left"
                              writingDirection="ltr"
                              style={styles.manualTableCellInput}
                            />
                          </View>
                          <View style={{ flex: MANUAL_COLUMNS[2].flex }}>
                            <AppInput
                              value={row.unit_price}
                              onChangeText={(value) => updateManualRow(row.key, 'unit_price', value)}
                              placeholder="מחיר ליחידה"
                              keyboardType="decimal-pad"
                              editable={!manualSaving && !finalizing}
                              textAlign="left"
                              writingDirection="ltr"
                              style={styles.manualTableCellInput}
                            />
                          </View>
                          <View style={[styles.manualGoldenLightCell, { flex: MANUAL_COLUMNS[3].flex }]}>
                            <Pressable
                              onPress={() => toggleManualRowGoldenLight(row.key)}
                              disabled={manualSaving || finalizing}
                              accessibilityRole="checkbox"
                              accessibilityState={{ checked: row.is_golden_light }}
                              accessibilityLabel="מוצר Golden Light"
                              hitSlop={8}>
                              <Ionicons
                                name={row.is_golden_light ? 'checkbox' : 'square-outline'}
                                size={20}
                                color={row.is_golden_light ? colors.primary : colors.textMuted}
                              />
                            </Pressable>
                            {row.is_golden_light &&
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
                            disabled={manualSaving || finalizing}
                            style={styles.manualTableDeleteCell}
                            accessibilityRole="button"
                            accessibilityLabel="מחיקת שורה"
                            hitSlop={8}>
                            <Ionicons name="trash-outline" size={16} color={colors.error} />
                          </Pressable>
                        </View>
                      ) : (
                        <View key={row.key} style={styles.manualStackedRow}>
                          <View style={styles.manualStackedRowHeader}>
                            <Text style={styles.manualStackedRowIndex}>{`שורה ${index + 1}`}</Text>
                            <Pressable
                              onPress={() => removeManualRow(row.key)}
                              disabled={manualSaving || finalizing}
                              accessibilityRole="button"
                              accessibilityLabel="מחיקת שורה"
                              hitSlop={8}>
                              <Ionicons name="trash-outline" size={16} color={colors.error} />
                            </Pressable>
                          </View>
                          <AppInput
                            label="תיאור מוצר"
                            value={row.description}
                            onChangeText={(value) => updateManualRow(row.key, 'description', value)}
                            editable={!manualSaving && !finalizing}
                            style={styles.manualFormField}
                          />
                          <View style={styles.manualFormFieldsRow}>
                            <AppInput
                              label="כמות"
                              value={row.quantity}
                              onChangeText={(value) => updateManualRow(row.key, 'quantity', value)}
                              editable={!manualSaving && !finalizing}
                              keyboardType="decimal-pad"
                              textAlign="left"
                              writingDirection="ltr"
                              style={styles.manualFormFieldHalf}
                            />
                            <AppInput
                              label="מחיר ליחידה"
                              value={row.unit_price}
                              onChangeText={(value) => updateManualRow(row.key, 'unit_price', value)}
                              editable={!manualSaving && !finalizing}
                              keyboardType="decimal-pad"
                              textAlign="left"
                              writingDirection="ltr"
                              style={styles.manualFormFieldHalf}
                            />
                          </View>
                          <Pressable
                            onPress={() => toggleManualRowGoldenLight(row.key)}
                            disabled={manualSaving || finalizing}
                            style={styles.manualGoldenLightStackedRow}
                            accessibilityRole="checkbox"
                            accessibilityState={{ checked: row.is_golden_light }}>
                            <Ionicons
                              name={row.is_golden_light ? 'checkbox' : 'square-outline'}
                              size={20}
                              color={row.is_golden_light ? colors.primary : colors.textMuted}
                            />
                            <Text style={styles.manualGoldenLightStackedLabel}>מוצר Golden Light</Text>
                          </Pressable>
                          {row.is_golden_light &&
                          computeLineAmount(toNumberOrNull(row.quantity), toNumberOrNull(row.unit_price)) ==
                            null ? (
                            <Text style={styles.manualRowWarningText}>חסר כמות/מחיר למוצר Golden Light</Text>
                          ) : null}
                        </View>
                      ),
                    )}
                  </View>

                  <Pressable
                    onPress={addManualRow}
                    disabled={manualSaving || finalizing}
                    style={styles.addRowButton}
                    accessibilityRole="button">
                    <Ionicons name="add" size={16} color={colors.primary} />
                    <Text style={styles.addRowButtonText}>הוספת שורה</Text>
                  </Pressable>

                  {/* Live, admin-only preview - recomputed from the rows
                      above on every keystroke/toggle. Never sent anywhere;
                      the database is the sole authoritative source once
                      finalized/saved. */}
                  <View style={styles.eligibleSummaryBox}>
                    <Text style={styles.eligibleSummaryLine}>
                      {`סכום מוצרי Golden Light לפני מע״מ: ₪${draftEligibleSummary.total.toFixed(2)}`}
                    </Text>
                    <Text style={styles.eligibleSummaryLine}>
                      {`נקודות ${postApprovalEditing ? 'שיינתנו' : 'שיתווספו'}: ${draftPointsPreview}`}
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
                              column.key === 'is_golden_light' && styles.manualTableHeaderTextCentered,
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
                              name={item.is_golden_light ? 'checkbox' : 'square-outline'}
                              size={18}
                              color={item.is_golden_light ? colors.primary : colors.textMuted}
                            />
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
                              <Text style={styles.manualItemMeta}>{`כמות: ${item.quantity}`}</Text>
                            ) : null}
                            {item.unit_price != null ? (
                              <Text style={styles.manualItemMeta}>{`מחיר ליח׳: ${item.unit_price}`}</Text>
                            ) : null}
                          </View>
                          <View style={styles.manualGoldenLightStackedRow}>
                            <Ionicons
                              name={item.is_golden_light ? 'checkbox' : 'square-outline'}
                              size={18}
                              color={item.is_golden_light ? colors.primary : colors.textMuted}
                            />
                            <Text style={styles.manualGoldenLightStackedLabel}>מוצר Golden Light</Text>
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
                <Text style={styles.pointsAwardedInfoValue}>{`נוספו ${report.pointsAward.points} נקודות`}</Text>
                {report.pointsAward.eligible_pre_vat_amount != null ? (
                  <Text style={styles.pointsAwardedInfoMeta}>
                    {`סכום מוצרי Golden Light לפני מע״מ: ₪${report.pointsAward.eligible_pre_vat_amount}`}
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
                  {`סכום מוצרי Golden Light לפני מע״מ: ₪${savedEligibleSummary.total.toFixed(2)}`}
                </Text>
                <Text style={styles.eligibleSummaryLine}>{`נקודות שיינתנו: ${savedPointsPreview}`}</Text>
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
              {`סכום מזכה לפני מע״מ: ₪${draftEligibleSummary.total.toFixed(2)}`}
            </Text>
            <Text style={styles.modalSubtitle}>{`נקודות שיתווספו: ${draftPointsPreview}`}</Text>
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
              {`סכום מוצרי Golden Light לפני מע״מ: ₪${savedEligibleSummary.total.toFixed(2)}`}
            </Text>
            <Text style={styles.modalSubtitle}>{`נקודות לזיכוי: ${savedPointsPreview}`}</Text>
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
  },
  metaLine: {
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
  imageCard: {
    minHeight: 260,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    ...shadows.softCard,
  },
  receiptImage: {
    width: '100%',
    height: '100%',
    minHeight: 260,
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
  sectionBadge: {
    alignSelf: 'flex-end',
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
  linesList: {
    gap: spacing.xs,
  },
  lineRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.surfaceMuted,
    paddingTop: spacing.xs,
  },
  lineText: {
    flex: 1,
    ...typography.caption,
    color: colors.text,
    textAlign: 'right',
    writingDirection: 'rtl',
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
  },
  manualRowWarningText: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.error,
    textAlign: 'right',
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
