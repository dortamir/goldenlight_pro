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
  approveAdminReport,
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

const MANUAL_COLUMNS = [
  { key: 'description', label: 'תיאור מוצר', flex: 3 },
  { key: 'sku', label: 'מק״ט', flex: 1.3 },
  { key: 'quantity', label: 'כמות', flex: 0.9 },
  { key: 'unit_price', label: 'מחיר ליחידה', flex: 1.2 },
  { key: 'line_total', label: 'סה״כ', flex: 1.2 },
];

let manualRowSeq = 0;
function createEmptyManualRow() {
  manualRowSeq += 1;
  return { key: `row-${manualRowSeq}`, description: '', sku: '', quantity: '', unit_price: '', line_total: '' };
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

// Builds the payload sent to saveAdminManualItems() from the editable rows,
// validating client-side first for immediate feedback - public.
// save_manual_receipt_items() (migration 011) re-validates every rule
// itself regardless, so this is a UX convenience, not the security
// boundary. A row left completely untouched (every field blank) is dropped
// silently - the common case after pressing "+ הוספת שורה" and not using
// it; a row with SOME data but a missing description is rejected as an
// error.
function buildManualItemsPayload(rows) {
  const trimmedRows = rows.map((row) => ({
    description: row.description.trim(),
    sku: row.sku.trim(),
    quantity: row.quantity.trim(),
    unit_price: row.unit_price.trim(),
    line_total: row.line_total.trim(),
  }));

  const nonEmptyRows = trimmedRows.filter(
    (row) => row.description || row.sku || row.quantity || row.unit_price || row.line_total,
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
    if (row.sku.length > 100) {
      throw new Error('sku_too_long');
    }

    return {
      description: row.description,
      sku: row.sku || null,
      quantity: parseOptionalPositiveNumber(row.quantity, 'invalid_quantity'),
      unit_price: parseOptionalNonNegativeNumber(row.unit_price, 'invalid_unit_price'),
      line_total: parseOptionalNonNegativeNumber(row.line_total, 'invalid_line_total'),
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

// Maps the short error identifiers raised by public.review_purchase_report()
// (migration 010) and public.save_manual_receipt_items() (migration 011) to
// safe Hebrew UI text - the raw Postgres error is never shown to the admin.
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
    case 'too_many_items':
      return 'יותר מדי שורות.';
    default:
      return 'לא ניתן היה לעדכן את החשבונית. נסו שוב.';
  }
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
  // null | 'approve' | 'reject' - which confirmation modal (if any) is open.
  const [decisionModal, setDecisionModal] = useState(null);
  const [rejectReason, setRejectReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState('');
  // Manual line-item entry (fallback for missing/failed/unusable OCR).
  const [manualEditing, setManualEditing] = useState(false);
  const [manualRows, setManualRows] = useState([]);
  const [manualSaving, setManualSaving] = useState(false);
  const [manualError, setManualError] = useState('');

  const loadDetail = useCallback(() => {
    if (!id) {
      return;
    }

    setLoading(true);
    setError('');
    setNotFound(false);
    setImageState({ status: 'idle', url: null });
    setManualEditing(false);
    setManualError('');

    getAdminReportDetail(id)
      .then((data) => {
        if (!data) {
          setNotFound(true);
          return;
        }

        setReport(data);

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

  const closeModal = () => {
    if (submitting) {
      return;
    }
    setDecisionModal(null);
    setActionError('');
    setRejectReason('');
  };

  const handleApprove = async () => {
    if (!report || submitting) {
      return;
    }

    setSubmitting(true);
    setActionError('');

    try {
      await approveAdminReport(report.id);
      setDecisionModal(null);
      setRejectReason('');
      loadDetail();
    } catch (err) {
      setActionError(getActionErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleReject = async () => {
    if (!report || submitting) {
      return;
    }

    const trimmedReason = rejectReason.trim();
    if (!trimmedReason) {
      setActionError('יש להזין סיבת דחייה.');
      return;
    }

    setSubmitting(true);
    setActionError('');

    try {
      await rejectAdminReport(report.id, trimmedReason);
      setDecisionModal(null);
      setRejectReason('');
      loadDetail();
    } catch (err) {
      setActionError(getActionErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  // Preloads the form with the saved rows (edit) or a single empty row
  // (first-time entry) - "not zero, not multiple blank rows".
  const startManualEntry = () => {
    if (!report) {
      return;
    }

    const initialRows =
      report.manualItems && report.manualItems.length > 0
        ? report.manualItems.map((item) => ({
            key: item.id,
            description: item.description || '',
            sku: item.sku || '',
            quantity: item.quantity != null ? String(item.quantity) : '',
            unit_price: item.unit_price != null ? String(item.unit_price) : '',
            line_total: item.line_total != null ? String(item.line_total) : '',
          }))
        : [createEmptyManualRow()];

    setManualRows(initialRows);
    setManualError('');
    setManualEditing(true);
  };

  // Discards the in-progress draft and returns to the read-only view of the
  // last SAVED data - never persists anything.
  const cancelManualEntry = () => {
    if (manualSaving) {
      return;
    }
    setManualEditing(false);
    setManualError('');
  };

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
            ? { ...row, description: '', sku: '', quantity: '', unit_price: '', line_total: '' }
            : row,
        );
      }
      return rows.filter((row) => row.key !== key);
    });
  };

  const updateManualRow = (key, field, value) => {
    setManualRows((rows) => rows.map((row) => (row.key === key ? { ...row, [field]: value } : row)));
  };

  const saveManualEntry = async () => {
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
      setManualEditing(false);
      loadDetail();
    } catch (err) {
      // Dev-only: the real Supabase/Postgres error (e.g. "relation does not
      // exist" if migration 011 hasn't been applied yet, a permission
      // error, a constraint violation, ...) so this can actually be
      // diagnosed - never shown to the admin, who only ever sees the safe
      // Hebrew message below.
      if (__DEV__) {
        console.error('[Admin manual receipt save]', err);
      }
      // Values stay in the form - nothing is cleared on failure, so the
      // admin can fix the problem and retry without retyping everything.
      setManualError(getActionErrorMessage(err));
    } finally {
      setManualSaving(false);
    }
  };

  const isPdf = report ? isPdfFile(report.original_filename) : false;
  const statusMeta = report ? getStatusMeta(report.status) : null;
  const ocrStatusMeta = report?.ocrResult ? getOcrStatusMeta(report.ocrResult.status) : null;
  const matchByLineId = new Map((report?.lineMatches || []).map((match) => [match.ocr_line_id, match]));
  const isReviewable = report ? REVIEWABLE_STATUSES.includes(report.status) : false;
  const isFinalized = report ? report.status === 'approved' || report.status === 'rejected' : false;
  const hasManualItems = Boolean(report?.manualItems && report.manualItems.length > 0);
  const hasUsableOcr = Boolean(report?.ocrResult?.status === 'completed' && (report?.ocrLines?.length || 0) > 0);

  return (
    <AdminShell activeKey="queue">
      <Pressable onPress={() => router.back()} style={styles.backRow} accessibilityRole="button">
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

          <View style={styles.sectionCard}>
            {manualEditing ? (
              <>
                <Text style={styles.sectionTitle}>הזנת פרטי חשבונית</Text>

                {isWideManualTable ? (
                  <View style={styles.manualTableHeaderRow}>
                    {MANUAL_COLUMNS.map((column) => (
                      <Text key={column.key} style={[styles.manualTableHeaderText, { flex: column.flex }]}>
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
                            editable={!manualSaving}
                            style={styles.manualTableCellInput}
                          />
                        </View>
                        <View style={{ flex: MANUAL_COLUMNS[1].flex }}>
                          <AppInput
                            value={row.sku}
                            onChangeText={(value) => updateManualRow(row.key, 'sku', value)}
                            placeholder="מק״ט"
                            editable={!manualSaving}
                            textAlign="left"
                            writingDirection="ltr"
                            style={styles.manualTableCellInput}
                          />
                        </View>
                        <View style={{ flex: MANUAL_COLUMNS[2].flex }}>
                          <AppInput
                            value={row.quantity}
                            onChangeText={(value) => updateManualRow(row.key, 'quantity', value)}
                            placeholder="כמות"
                            keyboardType="decimal-pad"
                            editable={!manualSaving}
                            textAlign="left"
                            writingDirection="ltr"
                            style={styles.manualTableCellInput}
                          />
                        </View>
                        <View style={{ flex: MANUAL_COLUMNS[3].flex }}>
                          <AppInput
                            value={row.unit_price}
                            onChangeText={(value) => updateManualRow(row.key, 'unit_price', value)}
                            placeholder="מחיר ליחידה"
                            keyboardType="decimal-pad"
                            editable={!manualSaving}
                            textAlign="left"
                            writingDirection="ltr"
                            style={styles.manualTableCellInput}
                          />
                        </View>
                        <View style={{ flex: MANUAL_COLUMNS[4].flex }}>
                          <AppInput
                            value={row.line_total}
                            onChangeText={(value) => updateManualRow(row.key, 'line_total', value)}
                            placeholder="סה״כ"
                            keyboardType="decimal-pad"
                            editable={!manualSaving}
                            textAlign="left"
                            writingDirection="ltr"
                            style={styles.manualTableCellInput}
                          />
                        </View>
                        <Pressable
                          onPress={() => removeManualRow(row.key)}
                          disabled={manualSaving}
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
                            disabled={manualSaving}
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
                          editable={!manualSaving}
                          style={styles.manualFormField}
                        />
                        <View style={styles.manualFormFieldsRow}>
                          <AppInput
                            label="מק״ט"
                            value={row.sku}
                            onChangeText={(value) => updateManualRow(row.key, 'sku', value)}
                            editable={!manualSaving}
                            textAlign="left"
                            writingDirection="ltr"
                            style={styles.manualFormFieldHalf}
                          />
                          <AppInput
                            label="כמות"
                            value={row.quantity}
                            onChangeText={(value) => updateManualRow(row.key, 'quantity', value)}
                            editable={!manualSaving}
                            keyboardType="decimal-pad"
                            textAlign="left"
                            writingDirection="ltr"
                            style={styles.manualFormFieldHalf}
                          />
                        </View>
                        <View style={styles.manualFormFieldsRow}>
                          <AppInput
                            label="מחיר ליחידה"
                            value={row.unit_price}
                            onChangeText={(value) => updateManualRow(row.key, 'unit_price', value)}
                            editable={!manualSaving}
                            keyboardType="decimal-pad"
                            textAlign="left"
                            writingDirection="ltr"
                            style={styles.manualFormFieldHalf}
                          />
                          <AppInput
                            label="סה״כ"
                            value={row.line_total}
                            onChangeText={(value) => updateManualRow(row.key, 'line_total', value)}
                            editable={!manualSaving}
                            keyboardType="decimal-pad"
                            textAlign="left"
                            writingDirection="ltr"
                            style={styles.manualFormFieldHalf}
                          />
                        </View>
                      </View>
                    ),
                  )}
                </View>

                <Pressable
                  onPress={addManualRow}
                  disabled={manualSaving}
                  style={styles.addRowButton}
                  accessibilityRole="button">
                  <Ionicons name="add" size={16} color={colors.primary} />
                  <Text style={styles.addRowButtonText}>הוספת שורה</Text>
                </Pressable>

                {manualError ? <Text style={styles.errorText}>{manualError}</Text> : null}

                <View style={styles.manualFormActionsRow}>
                  <Pressable
                    onPress={cancelManualEntry}
                    disabled={manualSaving}
                    style={styles.modalCancelButton}
                    accessibilityRole="button">
                    <Text style={styles.modalCancelText}>ביטול</Text>
                  </Pressable>
                  <PrimaryButton
                    title={manualSaving ? 'שומר...' : 'שמירת פרטי החשבונית'}
                    onPress={saveManualEntry}
                    loading={manualSaving}
                    disabled={manualSaving}
                    style={styles.manualSaveButton}
                  />
                </View>
              </>
            ) : hasManualItems ? (
              <>
                <View style={styles.sectionHeaderRow}>
                  <Text style={styles.sectionTitle}>פרטי החשבונית — הוזן ידנית</Text>
                  <View style={[styles.statusBadge, styles.manualBadge]}>
                    <Text style={[styles.statusBadgeText, styles.manualBadgeText]}>הוזן ידנית</Text>
                  </View>
                </View>

                {isWideManualTable ? (
                  <>
                    <View style={styles.manualTableHeaderRow}>
                      {MANUAL_COLUMNS.map((column) => (
                        <Text key={column.key} style={[styles.manualTableHeaderText, { flex: column.flex }]}>
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
                          {item.sku || '—'}
                        </Text>
                        <Text style={[styles.manualTableCellText, { flex: MANUAL_COLUMNS[2].flex }]}>
                          {item.quantity ?? '—'}
                        </Text>
                        <Text style={[styles.manualTableCellText, { flex: MANUAL_COLUMNS[3].flex }]}>
                          {item.unit_price ?? '—'}
                        </Text>
                        <Text style={[styles.manualTableCellText, { flex: MANUAL_COLUMNS[4].flex }]}>
                          {item.line_total ?? '—'}
                        </Text>
                      </View>
                    ))}
                  </>
                ) : (
                  <View style={styles.manualItemsList}>
                    {report.manualItems.map((item) => (
                      <View key={item.id} style={styles.manualItemRow}>
                        <Text style={styles.manualItemDescription}>{item.description}</Text>
                        <View style={styles.manualItemMetaRow}>
                          {item.sku ? <Text style={styles.manualItemMeta}>{`מק״ט: ${item.sku}`}</Text> : null}
                          {item.quantity != null ? (
                            <Text style={styles.manualItemMeta}>{`כמות: ${item.quantity}`}</Text>
                          ) : null}
                          {item.unit_price != null ? (
                            <Text style={styles.manualItemMeta}>{`מחיר ליח׳: ${item.unit_price}`}</Text>
                          ) : null}
                          {item.line_total != null ? (
                            <Text style={styles.manualItemMeta}>{`סה״כ: ${item.line_total}`}</Text>
                          ) : null}
                        </View>
                      </View>
                    ))}
                  </View>
                )}

                <Pressable onPress={startManualEntry} style={styles.manualEditLink} accessibilityRole="button">
                  <Text style={styles.manualEditLinkText}>עריכת נתונים</Text>
                </Pressable>
              </>
            ) : (
              <>
                <Text style={styles.sectionTitle}>הזנה ידנית</Text>
                <Text style={styles.emptyText}>
                  {hasUsableOcr
                    ? 'ניתן להוסיף נתונים שהוזנו ידנית לחשבונית זו בנוסף לזיהוי האוטומטי.'
                    : 'לא זוהו נתונים אוטומטית מהחשבונית. ניתן להזין את פרטי החשבונית ידנית.'}
                </Text>
                <PrimaryButton title="הזנה ידנית" onPress={startManualEntry} style={styles.manualStartButton} />
              </>
            )}
          </View>

          <View style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>פעולות בדיקה</Text>

            {isReviewable ? (
              <View style={styles.actionsRow}>
                <PrimaryButton
                  title="אישור חשבונית"
                  onPress={() => {
                    setActionError('');
                    setDecisionModal('approve');
                  }}
                  disabled={submitting}
                  style={styles.approveButton}
                />
                <Pressable
                  onPress={() => {
                    setActionError('');
                    setRejectReason('');
                    setDecisionModal('reject');
                  }}
                  disabled={submitting}
                  style={({ pressed }) => [
                    styles.rejectButton,
                    pressed && styles.rejectButtonPressed,
                    submitting && styles.rejectButtonDisabled,
                  ]}
                  accessibilityRole="button">
                  <Text style={styles.rejectButtonText}>דחיית חשבונית</Text>
                </Pressable>
              </View>
            ) : isFinalized ? (
              <View
                style={[
                  styles.decisionBox,
                  report.status === 'approved' ? styles.decisionBoxApproved : styles.decisionBoxRejected,
                ]}>
                <Text
                  style={[
                    styles.decisionText,
                    report.status === 'approved' ? styles.decisionTextApproved : styles.decisionTextRejected,
                  ]}>
                  {report.status === 'approved' ? 'החשבונית אושרה' : 'החשבונית נדחתה'}
                </Text>
                {report.reviewed_at ? (
                  <Text style={styles.decisionMeta}>{`טופלה ב-${formatReportDate(report.reviewed_at)}`}</Text>
                ) : null}
                {report.status === 'rejected' && report.rejection_reason ? (
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

      <Modal visible={decisionModal === 'approve'} transparent animationType="fade" onRequestClose={closeModal}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>לאשר את החשבונית?</Text>
            <Text style={styles.modalSubtitle}>לאחר האישור החשבונית תסומן כמאושרת.</Text>
            {actionError ? <Text style={styles.modalErrorText}>{actionError}</Text> : null}
            <View style={styles.modalActionsRow}>
              <Pressable onPress={closeModal} disabled={submitting} style={styles.modalCancelButton} accessibilityRole="button">
                <Text style={styles.modalCancelText}>ביטול</Text>
              </Pressable>
              <PrimaryButton
                title={submitting ? 'מאשר...' : 'אישור'}
                onPress={handleApprove}
                loading={submitting}
                disabled={submitting}
                style={styles.modalConfirmButton}
              />
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={decisionModal === 'reject'} transparent animationType="fade" onRequestClose={closeModal}>
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
              editable={!submitting}
              textAlign="right"
              writingDirection="rtl"
              style={styles.modalTextarea}
            />
            {actionError ? <Text style={styles.modalErrorText}>{actionError}</Text> : null}
            <View style={styles.modalActionsRow}>
              <Pressable onPress={closeModal} disabled={submitting} style={styles.modalCancelButton} accessibilityRole="button">
                <Text style={styles.modalCancelText}>ביטול</Text>
              </Pressable>
              <Pressable
                onPress={handleReject}
                disabled={submitting || !rejectReason.trim()}
                style={[
                  styles.modalRejectConfirmButton,
                  (submitting || !rejectReason.trim()) && styles.modalRejectConfirmButtonDisabled,
                ]}
                accessibilityRole="button">
                {submitting ? (
                  <ActivityIndicator color={colors.white} size="small" />
                ) : (
                  <Text style={styles.modalRejectConfirmText}>דחיית החשבונית</Text>
                )}
              </Pressable>
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
  // Review actions.
  actionsRow: {
    flexDirection: 'row-reverse',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  approveButton: {
    flexGrow: 1,
    flexBasis: 200,
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
  // Manual entry.
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
});
