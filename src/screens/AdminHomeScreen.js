import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import AdminShell from '../components/admin/AdminShell';
import {
  getAdminDashboardSummary,
  getAdminReviewQueue,
  loadAdminReceiptThumbnails,
} from '../services/adminReportService';
import { receiptImageCacheKey } from '../services/purchaseReportService';
import { colors, radius, shadows, spacing, typography } from '../theme';
import { getAdminReportStatusMeta } from '../utils/adminReportStatus';
import { isolateLTR } from '../utils/bidiText';

// STAGE 22: bumped from 52x68 (portrait) to a square 68x68 - a more
// consistent, icon-like thumbnail footprint for a compact operational row
// (Part I's suggested 64-72px range). Purely a size/shape change to
// existing styles - the underlying <Image> usage (cacheKey, cachePolicy,
// recyclingKey, onError fallback) is byte-for-byte the same Stage 21.1
// mechanism, just rendered at a different size.
const THUMB_SIZE = 68;

function isPdfFile(name) {
  return /\.pdf$/i.test(String(name || ''));
}

// STAGE 22: now includes the time, not just the date - purely a formatting
// change over the same already-fetched purchase_reports.created_at value
// (no new field, no new query). An operational "which invoices should I
// handle next" queue benefits from the actual submission time, especially
// since the queue itself is already ordered oldest-first.
function formatReportDateTime(value) {
  const date = new Date(value);

  if (!value || Number.isNaN(date.getTime())) {
    return '';
  }

  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${day}.${month}.${year} · ${hours}:${minutes}`;
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
  //
  // STAGE 22 note: this entire data-loading section (through the
  // useFocusEffect below) is UNCHANGED from Stage 21/21.1 - this stage is
  // visual only. Receipt-image caching (receiptImageCacheKey,
  // loadAdminReceiptThumbnails's warm-then-ready gating and its onRowReady
  // per-row commits) is untouched.
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

        const imageRows = rows.filter((row) => !isPdfFile(row.original_filename) && row.receipt_path);
        if (imageRows.length === 0) {
          return;
        }

        // STAGE 17.2: mark every row that doesn't already have a resolved
        // thumbnail as 'loading' in ONE atomic update (never per-row), then
        // resolve the whole batch (cache hits + fresh Storage calls) via
        // loadAdminReceiptThumbnails()'s own Promise.all and commit the
        // result in a SECOND atomic update. Deliberately NOT awaited here -
        // this must stay fire-and-forget so `.finally(() => setQueueLoading(false))`
        // below still fires as soon as the report rows themselves are
        // ready, independent of how long thumbnails take (the queue list
        // must render immediately; thumbnails fill in progressively).
        setThumbnails((prev) => {
          const next = { ...prev };
          imageRows.forEach((row) => {
            next[row.id] = next[row.id] ?? { status: 'loading', url: null };
          });
          return next;
        });

        // STAGE 21.1: onRowReady commits each row's own thumbnail the moment
        // ITS OWN signed URL is resolved and its expo-image cache entry is
        // actually warmed - not only once the slowest row in the whole
        // queue finishes (which the final .then(resolvedMap) below still
        // also does, as a harmless no-op re-merge of data already applied
        // per-row).
        loadAdminReceiptThumbnails(imageRows, (id, entry) => {
          setThumbnails((prev) => ({ ...prev, [id]: entry }));
        }).then((resolvedMap) => {
          setThumbnails((prev) => ({ ...prev, ...resolvedMap }));
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

  const approvedCount = summary?.approvedCount ?? 0;
  const rejectedCount = summary?.rejectedCount ?? 0;
  const pendingCount = summary?.pendingCount ?? 0;

  const queueCountSuffix =
    !queueLoading && !queueError && queue.length > 0 ? ` ${isolateLTR(`(${queue.length})`)}` : '';

  return (
    <AdminShell activeKey="dashboard">
      <View style={styles.pageHeader}>
        <Text style={styles.pageEyebrow}>לוח בקרה</Text>
        <Text style={styles.pageTitle}>ראשי</Text>
        <Text style={styles.pageSubtitle}>סקירה כללית וטיפול בחשבוניות הדורשות בדיקה</Text>
      </View>

      {/* STAGE 22: the primary operational KPI - "דורשות בדיקה" is the one
          number that actually drives what the admin does next, so it gets
          its own full-width, visually dominant card instead of sitting as
          an equal third alongside אושרו/נדחו (the previous three-equal-cards
          layout). Same underlying data (summary.pendingCount) and the same
          `/admin/reports?filter=needs_review` deep link as before - no new
          backend logic, no new route. */}
      {summaryLoading ? (
        <View style={styles.primaryKpiLoading}>
          <ActivityIndicator color={colors.primary} size="small" />
        </View>
      ) : summaryError ? (
        <View style={styles.primaryKpiError}>
          <Text style={styles.errorText}>{summaryError}</Text>
          <Pressable onPress={loadSummary} accessibilityRole="button">
            <Text style={styles.retryText}>נסו שוב</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable
          onPress={() => router.push('/admin/reports?filter=needs_review')}
          style={({ pressed, hovered }) => [
            styles.primaryKpiPressable,
            hovered && styles.primaryKpiHovered,
            pressed && styles.primaryKpiPressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel={`${pendingCount} חשבוניות דורשות בדיקה, מעבר לרשימה המסוננת`}>
          <LinearGradient
            colors={[colors.gradientDarkStart, colors.gradientDarkEnd]}
            start={{ x: 0.1, y: 0 }}
            end={{ x: 0.9, y: 1 }}
            style={styles.primaryKpiCard}>
            <View style={styles.primaryKpiTopRow}>
              <View style={styles.primaryKpiIconBadge}>
                <Ionicons name="time-outline" size={16} color={colors.primary} />
              </View>
              <Text style={styles.primaryKpiLabel}>דורשות בדיקה</Text>
            </View>

            <Text style={styles.primaryKpiValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
              {pendingCount}
            </Text>

            <View style={styles.primaryKpiActionRow}>
              <Text style={styles.primaryKpiActionText}>לצפייה בחשבוניות</Text>
              <Ionicons name="chevron-back" size={14} color={colors.primary} />
            </View>
          </LinearGradient>
        </Pressable>
      )}

      {/* Secondary KPIs - deliberately smaller/lighter than the primary card
          above, status color used only as an accent (icon + number tint +
          soft tinted background), never a fully-saturated block. Same
          summary fields, same deep-link pattern as before. */}
      {!summaryLoading && !summaryError ? (
        <View style={styles.secondaryKpiRow}>
          <Pressable
            onPress={() => router.push('/admin/reports?filter=approved')}
            style={({ pressed, hovered }) => [
              styles.secondaryKpiCard,
              hovered && styles.secondaryKpiCardHovered,
              pressed && styles.secondaryKpiCardPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel={`${approvedCount} חשבוניות אושרו, מעבר לרשימה המסוננת`}>
            <View style={[styles.secondaryKpiIconBadge, styles.secondaryKpiIconBadgeSuccess]}>
              <Ionicons name="checkmark-circle-outline" size={14} color={colors.success} />
            </View>
            <Text style={[styles.secondaryKpiValue, styles.secondaryKpiValueSuccess]}>{approvedCount}</Text>
            <Text style={styles.secondaryKpiLabel}>אושרו</Text>
          </Pressable>

          <Pressable
            onPress={() => router.push('/admin/reports?filter=rejected')}
            style={({ pressed, hovered }) => [
              styles.secondaryKpiCard,
              hovered && styles.secondaryKpiCardHovered,
              pressed && styles.secondaryKpiCardPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel={`${rejectedCount} חשבוניות נדחו, מעבר לרשימה המסוננת`}>
            <View style={[styles.secondaryKpiIconBadge, styles.secondaryKpiIconBadgeError]}>
              <Ionicons name="close-circle-outline" size={14} color={colors.error} />
            </View>
            <Text style={[styles.secondaryKpiValue, styles.secondaryKpiValueError]}>{rejectedCount}</Text>
            <Text style={styles.secondaryKpiLabel}>נדחו</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.section}>
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionTitle}>{`דורשות בדיקה${queueCountSuffix}`}</Text>
          {!queueLoading && !queueError && queue.length > 0 ? (
            <Pressable
              onPress={() => router.push('/admin/reports?filter=needs_review')}
              style={styles.sectionActionButton}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="מעבר לרשימת כל החשבוניות הדורשות בדיקה">
              <Text style={styles.sectionActionText}>הצג הכל</Text>
              <Ionicons name="chevron-back" size={12} color={colors.primary} />
            </Pressable>
          ) : null}
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
          <View style={styles.emptyStateCard}>
            <View style={styles.emptyStateIconBadge}>
              <Ionicons name="checkmark-circle-outline" size={20} color={colors.success} />
            </View>
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
                        source={{ uri: thumb.url, cacheKey: receiptImageCacheKey(report.receipt_path) }}
                        style={styles.thumbImage}
                        contentFit="contain"
                        cachePolicy="memory-disk"
                        recyclingKey={report.id}
                        transition={100}
                        onError={(event) => {
                          // STAGE 17.1: a signed URL that resolved successfully
                          // but then fails to actually LOAD (expired between
                          // resolution and render, a genuine network failure on
                          // the physical device, ...) previously left this
                          // thumbnail permanently blank with the JS state stuck
                          // at 'ready' - there was no error feedback loop at
                          // all. Falling back to 'error' here re-shows the
                          // placeholder icon instead of an invisible broken
                          // image, and the log gives a real signal to trace
                          // against on a physical device.
                          if (__DEV__) {
                            console.warn('[Admin Home] thumbnail image onError', {
                              reportId: report.id,
                              error: event?.error,
                            });
                          }
                          setThumbnails((prev) => ({ ...prev, [report.id]: { status: 'error', url: null } }));
                        }}
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
                    <Text style={styles.queueDate} numberOfLines={1}>
                      {isolateLTR(formatReportDateTime(report.created_at))}
                    </Text>
                  </View>

                  <View style={styles.queueTrailing}>
                    <View style={[styles.statusBadge, { backgroundColor: statusMeta.backgroundColor }]}>
                      <Text style={[styles.statusBadgeText, { color: statusMeta.textColor }]} numberOfLines={1}>
                        {statusMeta.label}
                      </Text>
                    </View>
                    <Ionicons name="chevron-back" size={16} color={colors.textMuted} />
                  </View>
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
  // STAGE 22: tiny uppercase operational label above the page title -
  // typography.micro, the same token already reserved elsewhere in the app
  // for short uppercase tags (e.g. PointsBalanceCard's tier badge), never
  // used for anything readable at length.
  pageEyebrow: {
    ...typography.micro,
    color: colors.textMuted,
    textAlign: 'right',
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
    marginTop: 2,
  },
  pageSubtitle: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: 2,
  },
  // --- Primary KPI ("דורשות בדיקה") ---
  primaryKpiPressable: {
    width: '100%',
  },
  primaryKpiHovered: {
    opacity: 0.96,
  },
  primaryKpiPressed: {
    opacity: 0.9,
  },
  // STAGE 22: deliberately NOT shadows.glow (the customer PointsBalanceCard's
  // ambient turquoise glow) - this is an internal tool, not a loyalty hero
  // card, so elevation comes from a plain, restrained dark shadow instead of
  // a colored glow. charcoalBorder still gives the same barely-there
  // turquoise-tinted edge already used for every other dark card in the app.
  primaryKpiCard: {
    width: '100%',
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.charcoalBorder,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
    ...shadows.md,
  },
  primaryKpiLoading: {
    width: '100%',
    minHeight: 132,
    borderRadius: radius.lg,
    backgroundColor: colors.charcoal,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryKpiError: {
    width: '100%',
    minHeight: 132,
    borderRadius: radius.lg,
    backgroundColor: colors.charcoal,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  primaryKpiTopRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.sm,
  },
  primaryKpiIconBadge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.glassFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryKpiLabel: {
    ...typography.caption,
    fontWeight: '700',
    color: colors.mutedOnDark,
    textAlign: 'right',
  },
  // STAGE 22: restrained by design - no textShadow glow (unlike the
  // customer points hero number), and sized below typography.hero/display
  // so this reads as a strong operational figure, not a promotional one.
  primaryKpiValue: {
    fontSize: 40,
    lineHeight: 46,
    fontWeight: '700',
    letterSpacing: -0.5,
    color: colors.primary,
    textAlign: 'right',
    marginTop: spacing.sm,
  },
  primaryKpiActionRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 4,
    marginTop: spacing.md,
    alignSelf: 'flex-end',
  },
  primaryKpiActionText: {
    ...typography.caption,
    fontWeight: '700',
    color: colors.primary,
    textAlign: 'right',
  },
  // --- Secondary KPIs (אושרו / נדחו) ---
  secondaryKpiRow: {
    flexDirection: 'row-reverse',
    gap: spacing.md,
  },
  secondaryKpiCard: {
    flexGrow: 1,
    flexBasis: 0,
    maxWidth: 280,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    alignItems: 'flex-end',
    gap: 2,
    cursor: 'pointer',
    ...shadows.sm,
  },
  secondaryKpiCardHovered: {
    borderColor: colors.primary,
  },
  secondaryKpiCardPressed: {
    opacity: 0.9,
  },
  secondaryKpiIconBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  secondaryKpiIconBadgeSuccess: {
    backgroundColor: colors.successSoft,
  },
  secondaryKpiIconBadgeError: {
    backgroundColor: colors.errorSoft,
  },
  secondaryKpiValue: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  secondaryKpiValueSuccess: {
    color: colors.success,
  },
  secondaryKpiValueError: {
    color: colors.error,
  },
  secondaryKpiLabel: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.textMuted,
    textAlign: 'right',
  },
  // --- Queue section ---
  section: {
    gap: spacing.md,
  },
  sectionHeaderRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '700',
    lineHeight: 22,
    color: colors.text,
    textAlign: 'right',
  },
  sectionActionButton: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 2,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.xs,
    cursor: 'pointer',
  },
  sectionActionText: {
    ...typography.caption,
    fontWeight: '700',
    color: colors.primary,
    textAlign: 'right',
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
  emptyStateCard: {
    minHeight: 120,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  emptyStateIconBadge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.successSoft,
    alignItems: 'center',
    justifyContent: 'center',
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
  // STAGE 22: minHeight raised from 76 -> 88 (Part I's suggested ~82-96px
  // range) to comfortably fit the larger 68px square thumbnail without
  // cramping - padding itself stays the same compact spacing.sm/md as
  // before, so this reads as "a bit taller to fit a bigger thumbnail", not
  // "a bigger, more padded card".
  queueRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 88,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    cursor: 'pointer',
    ...shadows.sm,
  },
  queueRowHovered: {
    borderColor: colors.primary,
  },
  queueRowPressed: {
    opacity: 0.85,
  },
  thumbWrap: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
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
    gap: 2,
  },
  queueCustomer: {
    ...typography.body,
    fontSize: 15,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  queueFilename: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'right',
  },
  queueDate: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'right',
  },
  // Trailing column (status pill above the chevron) - stacked vertically
  // rather than side-by-side, so it takes only as much horizontal width as
  // the badge itself needs, leaving queueInfo (flex: 1) the rest - keeps
  // the row safe on narrow phones regardless of how long a status label is.
  queueTrailing: {
    alignItems: 'center',
    gap: spacing.xs,
    flexShrink: 0,
  },
  // STAGE 22: the per-row status badge is deliberately smaller/quieter than
  // before (Part J - never louder than the customer name) - every row in
  // this specific queue already shares the same "דורשת בדיקה" status (see
  // REVIEW_QUEUE_STATUSES in adminReportService.js), so this exists for
  // visual consistency with the History/Detail screens' own row badges
  // rather than to convey new information here.
  statusBadge: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    flexShrink: 0,
  },
  statusBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    textAlign: 'center',
  },
});