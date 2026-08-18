import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';

import AdminShell from '../components/admin/AdminShell';
import { getAdminReceiptSignedUrl, getAdminReportDetail } from '../services/adminReportService';
import { colors, radius, shadows, spacing, typography } from '../theme';

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

export default function AdminReportDetailScreen() {
  const { id } = useLocalSearchParams();
  const router = useRouter();
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [imageState, setImageState] = useState({ status: 'idle', url: null });

  const loadDetail = useCallback(() => {
    if (!id) {
      return;
    }

    setLoading(true);
    setError('');
    setNotFound(false);
    setImageState({ status: 'idle', url: null });

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

  const isPdf = report ? isPdfFile(report.original_filename) : false;
  const statusMeta = report ? getStatusMeta(report.status) : null;
  const ocrStatusMeta = report?.ocrResult ? getOcrStatusMeta(report.ocrResult.status) : null;
  const matchByLineId = new Map((report?.lineMatches || []).map((match) => [match.ocr_line_id, match]));

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
        </>
      )}
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
});
