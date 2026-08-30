import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import AdminShell from '../components/admin/AdminShell';
import { getAdminDashboardSummary, getAdminReports, loadAdminReceiptThumbnails } from '../services/adminReportService';
import { colors, radius, shadows, spacing, typography } from '../theme';
import { getAdminReportStatusMeta } from '../utils/adminReportStatus';
import { isolateLTR } from '../utils/bidiText';

const THUMB_WIDTH = 52;
const THUMB_HEIGHT = 68;

// STAGE 13 UPDATE: client-side filters over the single full
// getAdminReports() list - no separate query per filter, unchanged from
// before. Mapped strictly to existing purchase_reports statuses, never an
// invented one. `processing` is a real, unchanged backend status (the OCR
// pipeline itself is untouched by this) but is deliberately NOT exposed as
// its own admin-facing filter/category any more - submitted, processing,
// and needs_review all collapse into the single 'needs_review' filter key
// (kept as that key so AdminHomeScreen's existing deep link keeps working
// unchanged), labeled "דורשות בדיקה". This key is what AdminHomeScreen's
// dashboard card links to via `/admin/reports?filter=needs_review` - see
// the `filter` param handling below.
const STATUS_FILTERS = [
  { key: 'all', label: 'הכל', statuses: null },
  { key: 'needs_review', label: 'דורשות בדיקה', statuses: ['submitted', 'processing', 'needs_review'] },
  { key: 'approved', label: 'אושרו', statuses: ['approved'] },
  { key: 'rejected', label: 'נדחו', statuses: ['rejected'] },
];
const STATUS_FILTER_KEYS = STATUS_FILTERS.map((filter) => filter.key);

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

// Normalizes useLocalSearchParams()'s `filter` value (a plain string for a
// single `?filter=x`, but expo-router types it as string | string[] since a
// repeated query key is technically possible) down to one of
// STATUS_FILTER_KEYS, or 'all' for anything missing/unrecognized - per the
// explicit "if no valid filter parameter is provided, default to הכל" rule.
// Never trusts an arbitrary/invented status from the URL.
function resolveFilterParam(rawFilter) {
  const value = Array.isArray(rawFilter) ? rawFilter[0] : rawFilter;
  return STATUS_FILTER_KEYS.includes(value) ? value : 'all';
}

export default function AdminReportsHistoryScreen() {
  const router = useRouter();
  const { filter: filterParam } = useLocalSearchParams();
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [thumbnails, setThumbnails] = useState({});
  const [activeFilter, setActiveFilter] = useState(() => resolveFilterParam(filterParam));
  // STAGE 13: free-text search over the same already-loaded getAdminReports()
  // list - no separate query, matching this screen's existing client-side
  // filter approach (Section 5's own explicit allowance for a queue this
  // size). Matches customerName/original_filename only - both already
  // safely returned by getAdminReports() today; no new field/grant.
  const [searchQuery, setSearchQuery] = useState('');
  // STAGE 13: compact per-status counts shown above the filter row - reuses
  // getAdminDashboardSummary() (adminReportService.js), the same safe,
  // admin-RLS-gated count queries AdminHomeScreen's own summary cards
  // already use. Loaded independently of the full report list/thumbnails
  // below (a summary failure must never block the list from rendering, and
  // vice versa).
  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState('');
  // STAGE 17: same hasLoaded-ref stale-while-refresh pattern as
  // AdminHomeScreen.js/the customer screens - only the true first load
  // blocks with the full loading state.
  const hasLoadedReportsRef = useRef(false);
  const hasLoadedSummaryRef = useRef(false);

  // Reacts to navigating here again with a different `?filter=` (e.g. a
  // second dashboard-card click while this screen is already mounted) -
  // the lazy useState initializer above only covers the very first mount.
  // Manual filter-pill clicks never touch the URL, so this never fights a
  // manual selection: it only re-syncs when filterParam itself changes.
  useEffect(() => {
    const resolved = resolveFilterParam(filterParam);
    setActiveFilter((current) => (resolved !== current ? resolved : current));
  }, [filterParam]);

  const loadReports = useCallback(() => {
    const isInitialLoad = !hasLoadedReportsRef.current;
    if (isInitialLoad) {
      setLoading(true);
    }
    setError('');

    getAdminReports()
      .then((rows) => {
        setReports(rows);
        hasLoadedReportsRef.current = true;

        const imageRows = rows.filter((row) => !isPdfFile(row.original_filename) && row.receipt_path);
        if (imageRows.length === 0) {
          return;
        }

        // STAGE 17.2: same Promise.all batch resolution as AdminHomeScreen -
        // see adminReportService.js's loadAdminReceiptThumbnails() and that
        // screen's own comment. Fire-and-forget on purpose: the report list
        // itself must render immediately (`.finally(() => setLoading(false))`
        // below), with thumbnails filling in progressively as the batch
        // resolves.
        setThumbnails((prev) => {
          const next = { ...prev };
          imageRows.forEach((row) => {
            next[row.id] = next[row.id] ?? { status: 'loading', url: null };
          });
          return next;
        });

        loadAdminReceiptThumbnails(imageRows).then((resolvedMap) => {
          setThumbnails((prev) => ({ ...prev, ...resolvedMap }));
        });
      })
      .catch(() => {
        if (isInitialLoad) {
          setError('לא הצלחנו לטעון את רשימת החשבוניות');
        }
      })
      .finally(() => setLoading(false));
  }, []);

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
        if (__DEV__) {
          console.error('[Admin reports] Failed to load summary counts', err);
        }
        if (isInitialLoad) {
          setSummaryError('לא הצלחנו לטעון את נתוני הסיכום');
        }
      })
      .finally(() => setSummaryLoading(false));
  }, []);

  // useFocusEffect (not a plain mount-only useEffect) - refetches whenever
  // this screen regains focus, e.g. returning from a decision made on the
  // detail screen, matching AdminHomeScreen's own refresh behavior. This
  // never resets activeFilter/searchQuery - only loadReports()/loadSummary()
  // run here - so returning from a receipt's detail screen via real
  // back-navigation lands back on this same still-mounted instance with
  // whichever filter/search was active before, refreshed with current data
  // (Stage 13's own "return from detail after approval/rejection -> queue
  // refreshes and report moves to correct status/count" requirement).
  useFocusEffect(
    useCallback(() => {
      loadReports();
      loadSummary();
    }, [loadReports, loadSummary]),
  );

  const visibleReports = useMemo(() => {
    const filter = STATUS_FILTERS.find((item) => item.key === activeFilter) || STATUS_FILTERS[0];
    const filtered = filter.statuses ? reports.filter((report) => filter.statuses.includes(report.status)) : reports;

    const trimmedQuery = searchQuery.trim().toLowerCase();
    if (!trimmedQuery) {
      return filtered;
    }

    return filtered.filter((report) => {
      const customerName = String(report.customerName || '').toLowerCase();
      const filename = String(report.original_filename || '').toLowerCase();
      return customerName.includes(trimmedQuery) || filename.includes(trimmedQuery);
    });
  }, [reports, activeFilter, searchQuery]);

  const isFiltered = activeFilter !== 'all';
  const isSearching = searchQuery.trim().length > 0;

  // Three distinct empty states (Stage 13, Section 9) - never the same
  // generic message regardless of why the list is empty.
  const emptyStateMessage = isSearching
    ? 'לא נמצאו חשבוניות התואמות לחיפוש'
    : isFiltered
      ? 'אין חשבוניות בסטטוס זה'
      : 'אין חשבוניות להצגה';

  // STAGE 13 UPDATE: the compact summary area - exactly three counts now
  // (no separate "בעיבוד" chip - `processing` is no longer its own
  // admin-facing category anywhere in this screen, see STATUS_FILTERS
  // above). Each chip is itself a shortcut into the matching filter, the
  // same click-to-filter pattern AdminHomeScreen's own summary cards
  // already use - no separate, disconnected "analytics" widget.
  //
  // STAGE 17.1 FIX: each item's active visual style is now looked up from
  // `activeFilter` (`STATUS_FILTERS`'s own single source of truth for
  // selection - the SAME state the filter pills below already read) rather
  // than a static `attention: true` flag that used to paint the
  // "דורשות בדיקה" chip amber unconditionally, regardless of which filter
  // was actually selected - that mismatch (e.g. "אושרו" active as a
  // turquoise pill while "דורשות בדיקה" stayed amber underneath) was
  // exactly the reported bug. There is still only one state variable
  // driving both controls; only the RENDER of the summary chips was ever
  // disconnected from it.
  const summaryItems = [
    {
      key: 'needs_review',
      label: 'דורשות בדיקה',
      value: summary?.pendingCount,
      activeChipStyle: styles.summaryChipActiveNeedsReview,
      activeValueStyle: styles.summaryValueActiveNeedsReview,
    },
    {
      key: 'approved',
      label: 'אושרו',
      value: summary?.approvedCount,
      activeChipStyle: styles.summaryChipActiveApproved,
      activeValueStyle: styles.summaryValueActiveApproved,
    },
    {
      key: 'rejected',
      label: 'נדחו',
      value: summary?.rejectedCount,
      activeChipStyle: styles.summaryChipActiveRejected,
      activeValueStyle: styles.summaryValueActiveRejected,
    },
  ];

  return (
    <AdminShell activeKey="history">
      <View style={styles.section}>
        <Text style={styles.pageTitle}>כל החשבוניות</Text>

        {summaryError ? (
          <View style={styles.summaryErrorRow}>
            <Text style={styles.errorText}>{summaryError}</Text>
            <Pressable onPress={loadSummary} accessibilityRole="button">
              <Text style={styles.retryText}>נסו שוב</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.summaryRow}>
            {summaryLoading
              ? [0, 1, 2].map((key) => (
                  <View key={key} style={styles.summaryChip}>
                    <ActivityIndicator color={colors.primary} size="small" />
                  </View>
                ))
              : summaryItems.map((item) => {
                  const isActive = activeFilter === item.key;
                  return (
                    <Pressable
                      key={item.key}
                      onPress={() => setActiveFilter(item.key)}
                      style={({ pressed, hovered }) => [
                        styles.summaryChip,
                        isActive && item.activeChipStyle,
                        hovered && styles.summaryChipHovered,
                        pressed && styles.summaryChipPressed,
                      ]}
                      accessibilityRole="button"
                      accessibilityState={{ selected: isActive }}
                      accessibilityLabel={`${item.value ?? 0} חשבוניות ${item.label}, מעבר לסינון לפי סטטוס זה`}>
                      <Text style={[styles.summaryValue, isActive && item.activeValueStyle]}>{item.value ?? 0}</Text>
                      <Text style={styles.summaryLabel}>{item.label}</Text>
                    </Pressable>
                  );
                })}
          </View>
        )}

        <View style={styles.searchRow}>
          <Ionicons name="search-outline" size={16} color={colors.textMuted} />
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="חיפוש לפי שם לקוח או שם קובץ"
            placeholderTextColor={colors.textMuted}
            style={styles.searchInput}
            accessibilityLabel="חיפוש חשבוניות לפי שם לקוח או שם קובץ"
            autoCorrect={false}
            autoCapitalize="none"
          />
          {searchQuery ? (
            <Pressable onPress={() => setSearchQuery('')} accessibilityRole="button" accessibilityLabel="ניקוי חיפוש" hitSlop={8}>
              <Ionicons name="close-circle" size={18} color={colors.textMuted} />
            </Pressable>
          ) : null}
        </View>

        <View style={styles.filterRow}>
          {STATUS_FILTERS.map((filter) => {
            const isActive = activeFilter === filter.key;
            return (
              <Pressable
                key={filter.key}
                onPress={() => setActiveFilter(filter.key)}
                style={({ pressed, hovered }) => [
                  styles.filterChip,
                  isActive && styles.filterChipActive,
                  !isActive && hovered && styles.filterChipHovered,
                  pressed && styles.filterChipPressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel={`סינון לפי ${filter.label}`}
                accessibilityState={{ selected: isActive }}>
                <Text style={[styles.filterChipText, isActive && styles.filterChipTextActive]}>{filter.label}</Text>
              </Pressable>
            );
          })}
        </View>

        {loading ? (
          <View style={styles.stateCard}>
            <ActivityIndicator color={colors.primary} size="small" />
          </View>
        ) : error ? (
          <View style={styles.stateCard}>
            <Text style={styles.errorText}>{error}</Text>
            <Pressable onPress={loadReports} accessibilityRole="button">
              <Text style={styles.retryText}>נסו שוב</Text>
            </Pressable>
          </View>
        ) : visibleReports.length === 0 ? (
          <View style={styles.stateCard}>
            <Text style={styles.emptyText}>{emptyStateMessage}</Text>
          </View>
        ) : (
          <View style={styles.list}>
            {visibleReports.map((report) => {
              const statusMeta = getAdminReportStatusMeta(report.status);
              const isPdf = isPdfFile(report.original_filename);
              const thumb = thumbnails[report.id];
              // STAGE 13, Section 8: a needs_review report stands out with a
              // subtle warm accent border - never the red/error tokens,
              // which stay reserved for a genuine rejection.
              const needsAttention = report.status === 'needs_review';

              return (
                <Pressable
                  key={report.id}
                  style={({ pressed, hovered }) => [
                    styles.row,
                    needsAttention && styles.rowAttention,
                    hovered && styles.rowHovered,
                    pressed && styles.rowPressed,
                  ]}
                  onPress={() => router.push(`/admin/reports/${report.id}`)}
                  accessibilityRole="button"
                  accessibilityLabel={`חשבונית של ${report.customerName || 'משתמש ללא שם'}, סטטוס ${statusMeta.label}`}>
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
                        onError={(event) => {
                          if (__DEV__) {
                            console.warn('[Admin History] thumbnail image onError', {
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

                  <View style={styles.info}>
                    <Text style={styles.customer} numberOfLines={1}>
                      {report.customerName || 'משתמש ללא שם'}
                    </Text>
                    <Text style={styles.filename} numberOfLines={1}>
                      {report.original_filename ? isolateLTR(report.original_filename) : 'חשבונית'}
                    </Text>
                    <Text style={styles.date}>{isolateLTR(formatReportDate(report.created_at))}</Text>
                    {report.status === 'approved' && report.points_awarded > 0 ? (
                      <Text style={styles.points}>{`נצברו ${isolateLTR(report.points_awarded)} נק׳`}</Text>
                    ) : null}
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
  section: {
    gap: spacing.md,
  },
  pageTitle: {
    fontSize: 22,
    // '700' matches the same maximum heading weight used everywhere else in
    // the app (see typography.heading) - '800' is reserved exclusively for
    // the hero/display tokens' giant numerals and was never meant for a
    // regular page title. No customer screen uses '800' outside those two
    // tokens.
    fontWeight: '700',
    lineHeight: 28,
    color: colors.text,
    textAlign: 'right',
  },
  // STAGE 13: the compact summary strip - small stat chips, deliberately
  // lighter-weight than AdminHomeScreen's own larger summaryCard (this
  // screen already has a filter row + search input competing for vertical
  // space right below it, so these stay compact rather than duplicating
  // that heavier card treatment).
  summaryRow: {
    flexDirection: 'row-reverse',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  summaryErrorRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.sm,
  },
  summaryChip: {
    flexGrow: 1,
    flexBasis: 84,
    minHeight: 56,
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: 2,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    cursor: 'pointer',
  },
  // STAGE 17.1: each summary card's ACTIVE (selected) look, applied only
  // when `activeFilter` actually equals that card's own key - see
  // summaryItems above. Reuses the exact same status colors as
  // src/utils/adminReportStatus.js/the row status badges below (amber for
  // "דורשות בדיקה", never the red/error tokens reserved for rejection;
  // green for "אושרו"; red for "נדחו"), so a card's selected color always
  // matches what that status already means everywhere else in this screen.
  summaryChipActiveNeedsReview: {
    backgroundColor: colors.warningSoft,
    borderColor: colors.warning,
  },
  summaryChipActiveApproved: {
    backgroundColor: colors.successSoft,
    borderColor: colors.success,
  },
  summaryChipActiveRejected: {
    backgroundColor: colors.errorSoft,
    borderColor: colors.error,
  },
  summaryChipHovered: {
    borderColor: colors.primary,
  },
  summaryChipPressed: {
    opacity: 0.85,
  },
  summaryValue: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  summaryValueActiveNeedsReview: {
    color: colors.warning,
  },
  summaryValueActiveApproved: {
    color: colors.success,
  },
  summaryValueActiveRejected: {
    color: colors.error,
  },
  summaryLabel: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.textMuted,
    textAlign: 'right',
  },
  searchRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    minHeight: 44,
  },
  searchInput: {
    flex: 1,
    ...typography.body,
    color: colors.text,
    textAlign: 'right',
    // Same web-only focus-ring removal already used by AppInput.js/
    // RegisterScreen.js - scoped via Platform.select so it's a genuine
    // no-op on native, not just an unrecognized style key.
    ...Platform.select({ web: { outlineStyle: 'none' } }),
  },
  filterRow: {
    flexDirection: 'row-reverse',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  filterChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 9,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.white,
    cursor: 'pointer',
  },
  filterChipHovered: {
    borderColor: colors.primary,
  },
  filterChipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  filterChipPressed: {
    opacity: 0.85,
  },
  filterChipText: {
    ...typography.caption,
    fontWeight: '700',
    color: colors.textMuted,
    textAlign: 'center',
  },
  filterChipTextActive: {
    color: colors.white,
  },
  stateCard: {
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
  list: {
    gap: spacing.sm,
  },
  row: {
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
  rowHovered: {
    borderColor: colors.primary,
  },
  rowPressed: {
    opacity: 0.85,
  },
  // STAGE 13, Section 8: a subtle warm accent stripe on the RTL leading
  // (right) edge for a needs_review report - stands out just enough to
  // catch the eye while scanning the list, without the weight of a full
  // colored card or the red/error tokens reserved for rejection.
  rowAttention: {
    borderRightWidth: 3,
    borderRightColor: colors.warning,
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
  info: {
    flex: 1,
    minWidth: 0,
    alignItems: 'flex-end',
  },
  customer: {
    ...typography.body,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  filename: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: 2,
  },
  date: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: 2,
  },
  points: {
    ...typography.caption,
    fontWeight: '700',
    color: colors.success,
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
