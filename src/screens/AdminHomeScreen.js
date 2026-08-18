import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';

import AdminShell from '../components/admin/AdminShell';
import { getAdminDashboardSummary, getAdminReceiptSignedUrl, getAdminReviewQueue } from '../services/adminReportService';
import { colors, radius, shadows, spacing, typography } from '../theme';

const THUMB_WIDTH = 56;
const THUMB_HEIGHT = 76;

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
  return `${day}.${month}.${year}`;
}

// Admin-specific status wording - deliberately distinguishes submitted
// ("נשלחה לבדיקה" - successfully submitted, waiting for the system/admin)
// from needs_review ("דורשת בדיקה" - specifically flagged for manual
// review), since these are real, different internal states even though
// both currently belong in the same admin attention queue (see
// adminReportService.js). Colors reuse the same status-pill tokens as the
// customer app's own getStatusMeta; only the needs_review/processing label
// text differs, to read unambiguously in an admin context.
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

export default function AdminHomeScreen() {
  const router = useRouter();
  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState('');
  const [queue, setQueue] = useState([]);
  const [queueLoading, setQueueLoading] = useState(true);
  const [queueError, setQueueError] = useState('');
  const [thumbnails, setThumbnails] = useState({});

  const loadSummary = useCallback(() => {
    setSummaryLoading(true);
    setSummaryError('');

    getAdminDashboardSummary()
      .then(setSummary)
      .catch(() => setSummaryError('לא הצלחנו לטעון את נתוני הסיכום'))
      .finally(() => setSummaryLoading(false));
  }, []);

  const loadQueue = useCallback(() => {
    setQueueLoading(true);
    setQueueError('');
    setThumbnails({});

    getAdminReviewQueue()
      .then((rows) => {
        setQueue(rows);

        rows
          .filter((row) => !isPdfFile(row.original_filename) && row.receipt_path)
          .forEach((row) => {
            setThumbnails((prev) => ({ ...prev, [row.id]: { status: 'loading', url: null } }));

            getAdminReceiptSignedUrl(row.receipt_path)
              .then((url) => {
                setThumbnails((prev) => ({ ...prev, [row.id]: { status: url ? 'ready' : 'error', url } }));
              })
              .catch(() => {
                setThumbnails((prev) => ({ ...prev, [row.id]: { status: 'error', url: null } }));
              });
          });
      })
      .catch(() => setQueueError('לא הצלחנו לטעון את חשבוניות הבדיקה'))
      .finally(() => setQueueLoading(false));
  }, []);

  useEffect(() => {
    loadSummary();
    loadQueue();
  }, [loadSummary, loadQueue]);

  const summaryCards = [
    { key: 'needs_review', label: 'חשבוניות לבדיקה', value: summary?.needsReviewCount },
    { key: 'processing', label: 'בטיפול', value: summary?.processingCount },
    { key: 'approved', label: 'אושרו', value: summary?.approvedCount },
  ];

  return (
    <AdminShell activeKey="dashboard">
      <View style={styles.summaryRow}>
        {summaryLoading ? (
          <View style={styles.summaryLoadingCard}>
            <ActivityIndicator color={colors.primary} size="small" />
          </View>
        ) : summaryError ? (
          <View style={styles.summaryErrorCard}>
            <Text style={styles.errorText}>{summaryError}</Text>
            <Pressable onPress={loadSummary} accessibilityRole="button">
              <Text style={styles.retryText}>נסו שוב</Text>
            </Pressable>
          </View>
        ) : (
          summaryCards.map((card) => (
            <View key={card.key} style={styles.summaryCard}>
              <Text style={styles.summaryValue}>{card.value ?? 0}</Text>
              <Text style={styles.summaryLabel}>{card.label}</Text>
            </View>
          ))
        )}
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionTitle}>חשבוניות שממתינות לטיפול</Text>
          <View style={styles.sectionAccentDot} />
        </View>

        {queueLoading ? (
          <View style={styles.queueStateCard}>
            <ActivityIndicator color={colors.primary} size="small" />
          </View>
        ) : queueError ? (
          <View style={styles.queueStateCard}>
            <Text style={styles.errorText}>{queueError}</Text>
            <Pressable onPress={loadQueue} accessibilityRole="button">
              <Text style={styles.retryText}>נסו שוב</Text>
            </Pressable>
          </View>
        ) : queue.length === 0 ? (
          <View style={styles.queueStateCard}>
            <Text style={styles.emptyText}>אין חשבוניות שממתינות לטיפול</Text>
          </View>
        ) : (
          <View style={styles.queueList}>
            {queue.map((report) => {
              const statusMeta = getStatusMeta(report.status);
              const isPdf = isPdfFile(report.original_filename);
              const thumb = thumbnails[report.id];

              return (
                <Pressable
                  key={report.id}
                  style={({ pressed }) => [styles.queueRow, pressed && styles.queueRowPressed]}
                  onPress={() => router.push(`/admin/reports/${report.id}`)}
                  accessibilityRole="button"
                  accessibilityLabel="פתיחת פרטי חשבונית">
                  <View style={styles.thumbWrap}>
                    {isPdf ? (
                      <View style={styles.thumbPlaceholder}>
                        <Text style={styles.thumbPlaceholderText}>PDF</Text>
                      </View>
                    ) : thumb?.status === 'ready' && thumb.url ? (
                      <Image source={{ uri: thumb.url }} style={styles.thumbImage} resizeMode="contain" />
                    ) : thumb?.status === 'loading' ? (
                      <View style={styles.thumbPlaceholder}>
                        <ActivityIndicator color={colors.primary} size="small" />
                      </View>
                    ) : (
                      <View style={styles.thumbPlaceholder}>
                        <Ionicons name="receipt-outline" size={18} color={colors.textMuted} />
                      </View>
                    )}
                  </View>

                  <View style={styles.queueInfo}>
                    <Text style={styles.queueCustomer} numberOfLines={1}>
                      {report.customerName || 'משתמש ללא שם'}
                    </Text>
                    <Text style={styles.queueFilename} numberOfLines={1}>
                      {report.original_filename || 'חשבונית'}
                    </Text>
                    <Text style={styles.queueDate}>{formatReportDate(report.created_at)}</Text>
                  </View>

                  <View style={[styles.statusBadge, { backgroundColor: statusMeta.backgroundColor }]}>
                    <Text style={[styles.statusBadgeText, { color: statusMeta.textColor }]}>{statusMeta.label}</Text>
                  </View>

                  <Ionicons name="chevron-back" size={18} color={colors.textMuted} />
                </Pressable>
              );
            })}
          </View>
        )}
      </View>
    </AdminShell>
  );
}

const styles = StyleSheet.create({
  summaryRow: {
    flexDirection: 'row-reverse',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  summaryCard: {
    flexGrow: 1,
    flexBasis: 180,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    alignItems: 'flex-end',
    ...shadows.softCard,
  },
  summaryLoadingCard: {
    flexGrow: 1,
    minHeight: 96,
    alignItems: 'center',
    justifyContent: 'center',
  },
  summaryErrorCard: {
    flexGrow: 1,
    minHeight: 96,
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  summaryValue: {
    fontSize: 32,
    fontWeight: '800',
    color: colors.text,
    textAlign: 'right',
  },
  summaryLabel: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: spacing.xs,
  },
  section: {
    gap: spacing.md,
  },
  sectionHeaderRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.xs,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    lineHeight: 24,
    color: colors.text,
    textAlign: 'right',
  },
  sectionAccentDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.primary,
  },
  queueStateCard: {
    minHeight: 120,
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
    ...typography.body,
    fontWeight: '600',
    color: colors.textMuted,
    textAlign: 'center',
  },
  queueList: {
    gap: spacing.sm,
  },
  queueRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    ...shadows.softCard,
  },
  queueRowPressed: {
    opacity: 0.85,
  },
  thumbWrap: {
    width: THUMB_WIDTH,
    height: THUMB_HEIGHT,
    borderRadius: radius.sm,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  thumbImage: {
    width: '100%',
    height: '100%',
  },
  thumbPlaceholder: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbPlaceholderText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.textMuted,
  },
  queueInfo: {
    flex: 1,
    minWidth: 0,
    alignItems: 'flex-end',
  },
  queueCustomer: {
    ...typography.body,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  queueFilename: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: 2,
  },
  queueDate: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: 2,
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
});
