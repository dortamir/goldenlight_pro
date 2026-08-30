import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import AdminShell from '../components/admin/AdminShell';
import {
  getAdminDashboardSummary,
  getAdminReceiptSignedUrl,
  getAdminReviewQueue,
} from '../services/adminReportService';
import { getCachedReceiptUrl } from '../services/purchaseReportService';
import { colors, radius, shadows, spacing, typography } from '../theme';
import { getAdminReportStatusMeta } from '../utils/adminReportStatus';
import { isolateLTR } from '../utils/bidiText';

const THUMB_WIDTH = 52;
const THUMB_HEIGHT = 68;

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

export default function AdminHomeScreen() {
  const router = useRouter();
  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState('');
  const [queue, setQueue] = useState([]);
  const [queueLoading, setQueueLoading] = useState(true);
  const [queueError, setQueueError] = useState('');
  const [thumbnails, setThumbnails] = useState({});
  // STAGE 17: same hasLoaded-ref stale-while-refresh pattern already proven
  // on the customer screens (HomeScreen.js etc., Stage 15.3) - only the
  // true first load blocks with the full loading state; a background
  // refresh-on-focus (e.g. returning from the detail screen after an
  // approve/reject) keeps the last-good summary/queue visible while it
  // re-confirms them, instead of blanking the dashboard every time.
  const hasLoadedSummaryRef = useRef(false);
  const hasLoadedQueueRef = useRef(false);

  const loadSummary = useCallback(() => {
    const isInitialLoad = !hasLoadedSummaryRef.current;
    if (isInitialLoad) {
      setSummaryLoading(true);
    }
    setSummaryError('');

    getAdminDashboardSummary()
      .then((data) => {
        setSummary(data);
        hasLoadedSummaryRef.current = true;
      })
      .catch((err) => {
        // Dev-only: the real Supabase/Postgres error - never shown to the
        // admin, who only ever sees the safe Hebrew message below.
        if (__DEV__) {
          console.error('[Admin dashboard] Failed to load summary', err);
        }
        // Background-refresh failure keeps the last-good summary visible
        // (stale-while-refresh) - only the true first load, with nothing to
        // fall back to, shows the error state.
        if (isInitialLoad) {
          setSummaryError('לא הצלחנו לטעון את נתוני הסיכום');
        }
      })
      .finally(() => setSummaryLoading(false));
  }, []);

  const loadQueue = useCallback(() => {
    const isInitialLoad = !hasLoadedQueueRef.current;
    if (isInitialLoad) {
      setQueueLoading(true);
    }
    setQueueError('');

    getAdminReviewQueue()
      .then((rows) => {
        setQueue(rows);
        hasLoadedQueueRef.current = true;

        rows
          .filter((row) => !isPdfFile(row.original_filename) && row.receipt_path)
          .forEach((row) => {
            // STAGE 17: a cached signed URL (shared with the customer
            // receipt cache - see adminReportService.js's
            // getAdminReceiptSignedUrl) renders immediately as 'ready'
            // instead of every row resetting to 'loading' first, so a
            // report already viewed this session never flashes its
            // thumbnail back to a placeholder on a background refresh.
            const cachedUrl = getCachedReceiptUrl(row.receipt_path);
            if (cachedUrl) {
              setThumbnails((prev) => ({ ...prev, [row.id]: { status: 'ready', url: cachedUrl } }));
              return;
            }

            setThumbnails((prev) => ({ ...prev, [row.id]: prev[row.id] ?? { status: 'loading', url: null } }));

            getAdminReceiptSignedUrl(row.receipt_path)
              .then((url) => {
                setThumbnails((prev) => ({ ...prev, [row.id]: { status: url ? 'ready' : 'error', url } }));
              })
              .catch(() => {
                setThumbnails((prev) => ({ ...prev, [row.id]: { status: 'error', url: null } }));
              });
          });
      })
      .catch((err) => {
        // Dev-only: the real Supabase/Postgres error - never shown to the
        // admin, who only ever sees the safe Hebrew message below.
        if (__DEV__) {
          console.error('[Admin dashboard] Failed to load review queue', err);
        }
        if (isInitialLoad) {
          setQueueError('לא הצלחנו לטעון את חשבוניות הבדיקה');
        }
      })
      .finally(() => setQueueLoading(false));
  }, []);

  // useFocusEffect (not a plain mount-only useEffect) - refetches every
  // time this screen regains focus, e.g. when the admin taps "חזרה לרשימה"
  // after approving/rejecting a report on the detail screen. Expo Router's
  // Stack keeps this screen mounted underneath the detail route rather than
  // remounting it on back-navigation, so a mount-only effect would keep
  // showing the stale pre-decision counts/queue until a manual page reload.
  useFocusEffect(
    useCallback(() => {
      loadSummary();
      loadQueue();
    }, [loadSummary, loadQueue]),
  );

  // Each card is clickable and deep-links straight into "כל החשבוניות" with
  // the matching filter already selected (see AdminReportsHistoryScreen's
  // STATUS_FILTERS, which use these exact same keys) - no duplicate
  // receipt-list screen, no separate query per card. Icon is a subtle
  // brand-turquoise accent on every card regardless of what the card
  // represents - status-specific colors (green/red) stay confined to the
  // individual status chips on receipt rows, never the summary cards
  // themselves.
  //
  // STAGE 13 UPDATE: the first card links to the 'needs_review' filter key
  // (unchanged key, so the deep link into AdminReportsHistoryScreen keeps
  // working), but its VALUE is now summary.pendingCount - submitted +
  // processing + needs_review combined - matching that screen's own
  // "דורשות בדיקה" filter/summary chip, which now groups all three the
  // same way (processing is no longer its own distinct admin-facing
  // category anywhere - see src/utils/adminReportStatus.js). The queue
  // list just below still shows submitted + needs_review together
  // (getAdminReviewQueue(), unchanged, REVIEW_QUEUE_STATUSES) - that
  // list's own row-selection was deliberately left as-is; only labels/
  // counts/filters changed in this update, see that constant's own
  // comment in adminReportService.js.
  const summaryCards = [
    { key: 'needs_review', label: 'דורשות בדיקה', value: summary?.pendingCount, icon: 'time-outline' },
    { key: 'approved', label: 'אושרו', value: summary?.approvedCount, icon: 'checkmark-circle-outline' },
    { key: 'rejected', label: 'נדחו', value: summary?.rejectedCount, icon: 'close-circle-outline' },
  ];

  const queueCountSuffix =
    !queueLoading && !queueError && queue.length > 0 ? ` ${isolateLTR(`(${queue.length})`)}` : '';

  return (
    <AdminShell activeKey="dashboard">
      <View style={styles.pageHeader}>
        <Text style={styles.pageTitle}>ראשי</Text>
        <Text style={styles.pageSubtitle}>סקירה כללית ובדיקת חשבוניות ממתינות</Text>
      </View>

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
            <Pressable
              key={card.key}
              onPress={() => router.push(`/admin/reports?filter=${card.key}`)}
              style={({ pressed, hovered }) => [
                styles.summaryCard,
                hovered && styles.summaryCardHovered,
                pressed && styles.summaryCardPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={`מעבר לכל החשבוניות, מסונן לפי ${card.label}`}>
              <View style={styles.summaryIconBadge}>
                <Ionicons name={card.icon} size={15} color={colors.primary} />
              </View>
              <Text style={styles.summaryValue}>{card.value ?? 0}</Text>
              <Text style={styles.summaryLabel}>{card.label}</Text>
            </Pressable>
          ))
        )}
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionTitle}>{`חשבוניות שממתינות לבדיקה${queueCountSuffix}`}</Text>
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
            <Text style={styles.emptyText}>אין חשבוניות שממתינות לבדיקה</Text>
          </View>
        ) : (
          <View style={styles.queueList}>
            {queue.map((report) => {
              const statusMeta = getAdminReportStatusMeta(report.status);
              const isPdf = isPdfFile(report.original_filename);
              const thumb = thumbnails[report.id];

              return (
                <Pressable
                  key={report.id}
                  style={({ pressed, hovered }) => [
                    styles.queueRow,
                    hovered && styles.queueRowHovered,
                    pressed && styles.queueRowPressed,
                  ]}
                  onPress={() => router.push(`/admin/reports/${report.id}`)}
                  accessibilityRole="button"
                  accessibilityLabel="פתיחת פרטי חשבונית">
                  <View style={styles.thumbWrap}>
                    {isPdf ? (
                      <View style={styles.thumbPlaceholder}>
                        <Text style={styles.thumbPlaceholderText}>{isolateLTR('PDF')}</Text>
                      </View>
                    ) : thumb?.status === 'ready' && thumb.url ? (
                      <Image
                        source={{ uri: thumb.url }}
                        style={styles.thumbImage}
                        contentFit="contain"
                        cachePolicy="memory-disk"
                        recyclingKey={report.id}
                        transition={100}
                      />
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
                      {report.original_filename ? isolateLTR(report.original_filename) : 'חשבונית'}
                    </Text>
                    <Text style={styles.queueDate}>{isolateLTR(formatReportDate(report.created_at))}</Text>
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
  pageHeader: {
    gap: 2,
  },
  pageTitle: {
    fontSize: 22,
    // '700' matches the same maximum heading weight used everywhere else in
    // the app (see typography.heading) - '800' is reserved exclusively for
    // the hero/display tokens' giant numerals (e.g. PointsBalanceCard's 52px
    // points figure) and was never meant for a regular page title. No
    // customer screen uses '800' outside those two tokens.
    fontWeight: '700',
    lineHeight: 28,
    color: colors.text,
    textAlign: 'right',
  },
  pageSubtitle: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'right',
  },
  summaryRow: {
    flexDirection: 'row-reverse',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  summaryCard: {
    flexGrow: 1,
    flexBasis: 172,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    alignItems: 'flex-end',
    gap: 2,
    cursor: 'pointer',
    ...shadows.softCard,
  },
  summaryCardHovered: {
    borderColor: colors.primary,
    ...shadows.premiumCard,
  },
  summaryCardPressed: {
    opacity: 0.9,
  },
  summaryIconBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
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
    fontSize: 28,
    // See pageTitle above - '700' is the app's real maximum heading weight;
    // '800' is reserved for the hero/display tokens only.
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  summaryLabel: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.textMuted,
    textAlign: 'right',
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
    fontSize: 17,
    fontWeight: '700',
    lineHeight: 22,
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
    minHeight: 76,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    cursor: 'pointer',
    ...shadows.softCard,
  },
  queueRowHovered: {
    borderColor: colors.primary,
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
