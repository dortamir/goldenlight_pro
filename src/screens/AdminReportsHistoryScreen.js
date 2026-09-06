import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import AdminShell from '../components/admin/AdminShell';
import { getAdminDashboardSummary, getAdminReports, loadAdminReceiptThumbnails } from '../services/adminReportService';
import { receiptImageCacheKey } from '../services/purchaseReportService';
import { colors, radius, spacing, typography } from '../theme';
import { getAdminReportStatusMeta } from '../utils/adminReportStatus';
import { isolateLTR } from '../utils/bidiText';

// STAGE 23: bumped from a 52x68 portrait box to a square 68px - matches
// AdminHomeScreen's own Stage 22 thumbnail size exactly, for visual
// consistency between the two admin list surfaces. Purely a style-level
// size change - every Stage 21/21.1/21.2 <Image> prop (cacheKey,
// cachePolicy, recyclingKey, onError fallback) below is untouched.
const THUMB_SIZE = 68;

// STAGE 21: this screen loads the full admin history in one query (a
// separate, larger concern than this stage's scope), but signed-URL
// resolution for every row's thumbnail doesn't need to compete equally -
// the first rows are what's actually visible without scrolling. Splitting
// into a small high-priority batch (dispatched first) and a background
// batch (dispatched right after) means the rows an admin sees first win
// the network race, without ever leaving later rows permanently blank.
const HIGH_PRIORITY_THUMBNAIL_COUNT = 8;

// STAGE 21.1: Stage 21 dispatched every remaining row (however many the
// full admin history contains) as a single unbounded second batch right
// after the priority one - fine while histories are small, but an admin
// account's full history has no upper bound, and this would eventually mean
// warming dozens or hundreds of images at once on a single screen load. A
// second small bounded batch keeps "the next several rows likely to be
// scrolled to soon" warm without that risk.
const BACKGROUND_THUMBNAIL_COUNT = 12;

// STAGE 21.2: Stage 21.1 left everything beyond the priority+background 20
// permanently unresolved until the admin opened that report's own Detail
// screen - not acceptable for a long history the admin actually scrolls
// through. This is the size of each further, ON-DEMAND chunk dispatched as
// the admin scrolls close to the bottom of the currently-rendered list -
// same bound as the background batch, reused for consistency, not a new
// concept.
const ON_DEMAND_THUMBNAIL_CHUNK_SIZE = 12;

// STAGE 21.2: AdminShell owns the actual scrolling container (a ScrollView,
// not a FlatList - see that component's own comment on why this screen
// forwards onScroll to it rather than migrating to FlatList). There is no
// per-row viewability signal available the way FlatList's
// onViewableItemsChanged would give - this screen's own report rows are
// plain Views inside one always-fully-rendered list, not a virtualized one.
// The closest safe equivalent is content-progress-based: once the visible
// scroll position is within this many px of the bottom of the CURRENTLY
// rendered content, treat that as "the admin is about to see more rows" and
// dispatch the next bounded chunk - see handleScroll below.
const SCROLL_LOAD_THRESHOLD_PX = 600;

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

// STAGE 23: now includes the time, not just the date - the same operational
// date treatment introduced on Admin Home in Stage 22, over the same
// already-fetched purchase_reports.created_at value (no new field, no new
// query).
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
        // STAGE 21.2: thumbnail dispatch no longer happens here - it used
        // to run against `rows` (the raw, unfiltered fetch result), which
        // is wrong the moment a filter/search is already active (e.g. this
        // screen opened via AdminHome's own `?filter=needs_review` deep
        // link): the rows an admin actually SEES first are visibleReports'
        // first rows, not necessarily rows[0..N]. See the visibleReports-
        // driven effect and handleScroll below, which both dispatch against
        // the actual currently-visible, filtered/searched list instead.
        setReports(rows);
        hasLoadedReportsRef.current = true;
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

  // STAGE 21.2: every report id whose thumbnail has ever been dispatched
  // (eagerly or on-demand) this session - a Set, not component state, since
  // it exists purely to prevent re-dispatching the same row and never
  // drives a render itself. Deliberately never cleared on filter/search/
  // focus - a report's own thumbnail doesn't need re-resolving just because
  // the admin changed what's visible or came back from Detail (Part G): the
  // underlying receipt_path/signed-url/expo-image caches this ultimately
  // reads through (getCachedReceiptUrl, warmReceiptImage's own in-flight
  // map) are the real source of truth for "is this actually loaded" - this
  // Set only exists to avoid asking loadAdminReceiptThumbnails about the
  // same row over and over as the admin scrolls back and forth.
  const loadedThumbnailIdsRef = useRef(new Set());
  // Simple mutex so on-demand scroll-triggered chunks never overlap each
  // other - the initial priority+background pair below is deliberately NOT
  // gated by this (Stage 21.1's own behavior: background starts right after
  // priority, not waiting for it).
  const chunkInFlightRef = useRef(false);

  const getPendingImageRows = useCallback((rows) => {
    return rows.filter(
      (row) => !isPdfFile(row.original_filename) && row.receipt_path && !loadedThumbnailIdsRef.current.has(row.id),
    );
  }, []);

  const dispatchThumbnailChunk = useCallback((rowsToLoad, { gated = false } = {}) => {
    if (rowsToLoad.length === 0) {
      return;
    }

    rowsToLoad.forEach((row) => loadedThumbnailIdsRef.current.add(row.id));

    setThumbnails((prev) => {
      const next = { ...prev };
      rowsToLoad.forEach((row) => {
        next[row.id] = next[row.id] ?? { status: 'loading', url: null };
      });
      return next;
    });

    if (gated) {
      chunkInFlightRef.current = true;
    }

    loadAdminReceiptThumbnails(rowsToLoad, (id, entry) => {
      setThumbnails((prev) => ({ ...prev, [id]: entry }));
    }).finally(() => {
      if (gated) {
        chunkInFlightRef.current = false;
      }
    });
  }, []);

  // STAGE 21.2: replaces Stage 21.1's dispatch-inside-loadReports - runs
  // against visibleReports (the actual filtered/searched list), so a filter
  // or search change that reveals rows never seen before also warms THEIR
  // first priority+background rows, exactly like a fresh data load does.
  // Rows already in loadedThumbnailIdsRef are skipped by getPendingImageRows,
  // so this is a no-op on a background refresh or a filter toggle back to a
  // previously-seen view - nothing already loaded is ever re-dispatched or
  // reset (Part G).
  useEffect(() => {
    const pending = getPendingImageRows(visibleReports);
    if (pending.length === 0) {
      return;
    }

    const priorityRows = pending.slice(0, HIGH_PRIORITY_THUMBNAIL_COUNT);
    const backgroundRows = pending.slice(HIGH_PRIORITY_THUMBNAIL_COUNT, HIGH_PRIORITY_THUMBNAIL_COUNT + BACKGROUND_THUMBNAIL_COUNT);

    // STAGE 21.1 behavior preserved: priority dispatched first, background
    // right after, both committing per-row via onRowReady inside
    // dispatchThumbnailChunk/loadAdminReceiptThumbnails - never waiting for
    // the slowest row in either batch.
    dispatchThumbnailChunk(priorityRows);
    dispatchThumbnailChunk(backgroundRows);
  }, [visibleReports, getPendingImageRows, dispatchThumbnailChunk]);

  // STAGE 21.2: AdminShell's ScrollView is the actual scrolling container
  // (see that component's own onScroll passthrough) - this screen's report
  // rows are plain Views inside it, not a virtualized list, so there is no
  // per-row viewability event available the way FlatList's
  // onViewableItemsChanged would give. Instead, once scroll position is
  // within SCROLL_LOAD_THRESHOLD_PX of the bottom of the currently rendered
  // content, treat that as "more rows are about to be seen" and dispatch
  // the next bounded chunk of whatever in visibleReports still has no
  // thumbnail - gated by chunkInFlightRef so a burst of throttled scroll
  // events while lingering near the bottom dispatches chunks one at a time,
  // never overlapping.
  const handleScroll = useCallback(
    (event) => {
      if (chunkInFlightRef.current) {
        return;
      }

      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const distanceFromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
      if (distanceFromBottom > SCROLL_LOAD_THRESHOLD_PX) {
        return;
      }

      const pending = getPendingImageRows(visibleReports);
      if (pending.length === 0) {
        return;
      }

      dispatchThumbnailChunk(pending.slice(0, ON_DEMAND_THUMBNAIL_CHUNK_SIZE), { gated: true });
    },
    [visibleReports, getPendingImageRows, dispatchThumbnailChunk],
  );

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
  // STAGE 23.1: "הכל" joins this array as a real, fourth, equal segment -
  // its count is reports.length, the exact same already-loaded full list
  // visibleReports itself derives from (see that useMemo above) - no
  // backend query, no separate count source, always exactly consistent
  // with what "no filter" actually shows.
  const summaryItems = [
    {
      key: 'all',
      label: 'הכל',
      value: reports.length,
      activeChipStyle: styles.summaryChipActiveAll,
      activeValueStyle: styles.summaryValueActiveAll,
      dotStyle: styles.summaryStripDotAll,
    },
    {
      key: 'needs_review',
      label: 'דורשות בדיקה',
      value: summary?.pendingCount,
      activeChipStyle: styles.summaryChipActiveNeedsReview,
      activeValueStyle: styles.summaryValueActiveNeedsReview,
      dotStyle: styles.summaryStripDotNeedsReview,
    },
    {
      key: 'approved',
      label: 'אושרו',
      value: summary?.approvedCount,
      activeChipStyle: styles.summaryChipActiveApproved,
      activeValueStyle: styles.summaryValueActiveApproved,
      dotStyle: styles.summaryStripDotApproved,
    },
    {
      key: 'rejected',
      label: 'נדחו',
      value: summary?.rejectedCount,
      activeChipStyle: styles.summaryChipActiveRejected,
      activeValueStyle: styles.summaryValueActiveRejected,
      dotStyle: styles.summaryStripDotRejected,
    },
  ];

  return (
    <AdminShell activeKey="history" onScroll={handleScroll} scrollEventThrottle={200}>
      <View style={styles.pageHeader}>
        <Text style={styles.pageEyebrow}>ניהול חשבוניות</Text>
        <Text style={styles.pageTitle}>כל החשבוניות</Text>
        <Text style={styles.pageSubtitle}>חיפוש, סינון ובדיקת חשבוניות שהוגשו למערכת</Text>
      </View>

      {/* STAGE 23.1: one unified 4-segment strip (הכל/דורשות בדיקה/אושרו/נדחו)
          is now the ONLY filtering UI on this screen - the separate filter-
          chip row was removed entirely (see Part below). Same real
          summary.pendingCount/approvedCount/rejectedCount data plus
          reports.length for "הכל", same click-to-filter behavior as before
          (setActiveFilter, no refetch) - just one control instead of two
          that did the same thing. */}
      {summaryError ? (
        <View style={styles.summaryErrorRow}>
          <Text style={styles.errorText}>{summaryError}</Text>
          <Pressable onPress={loadSummary} accessibilityRole="button">
            <Text style={styles.retryText}>נסו שוב</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.summaryStrip}>
          {/* STAGE 23.1: "הכל"'s count comes from reports.length (loadReports/
              `loading`), not from the summary endpoint - so the skeleton
              stays up until BOTH the summary counts AND the report list's
              true first load have resolved, never showing "0" for "הכל"
              while reports are still loading. `loading` is only ever true
              during a genuine first load (see loadReports' own
              isInitialLoad gate) - a background refresh-on-focus never
              re-triggers this skeleton. */}
          {summaryLoading || loading
            ? [0, 1, 2, 3].map((key) => (
                <View key={key} style={[styles.summaryStripItem, key > 0 && styles.summaryStripDivider]}>
                  <ActivityIndicator color={colors.primary} size="small" />
                </View>
              ))
            : summaryItems.map((item, index) => {
                const isActive = activeFilter === item.key;
                return (
                  <Pressable
                    key={item.key}
                    onPress={() => setActiveFilter(item.key)}
                    style={({ pressed, hovered }) => [
                      styles.summaryStripItem,
                      index > 0 && styles.summaryStripDivider,
                      hovered && styles.summaryStripItemHovered,
                      pressed && styles.summaryStripItemPressed,
                    ]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isActive }}
                    accessibilityLabel={`${item.value ?? 0} חשבוניות ${item.label}, מעבר לסינון לפי סטטוס זה`}>
                    <View style={[styles.summaryStripPill, isActive && item.activeChipStyle]}>
                      <View style={[styles.summaryStripDot, item.dotStyle]} />
                      <Text style={[styles.summaryStripValue, isActive && item.activeValueStyle]}>
                        {item.value ?? 0}
                      </Text>
                    </View>
                    <Text style={styles.summaryStripLabel} numberOfLines={1}>
                      {item.label}
                    </Text>
                  </Pressable>
                );
              })}
        </View>
      )}

      {/* STAGE 23: search, filters, the result-context row, and the list/
          state below all sit inside one shared section with a tight
          internal gap - they read as one connected "list controls + list"
          unit, distinct from the looser spacing between pageHeader/
          summaryStrip/this section (AdminShell's own inter-section gap,
          matching Stage 22's Admin Home convention). */}
      <View style={styles.listSection}>
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

        {/* STAGE 23, Part F: a small real-data context row - visibleReports.length
            is the exact same array the list below renders, nothing separately
            computed/estimated. Omitted while loading/erroring/empty, since
            there's nothing meaningful to count yet in those states. */}
        {!loading && !error && visibleReports.length > 0 ? (
          <Text style={styles.resultContext}>{`מציג ${isolateLTR(visibleReports.length)} חשבוניות`}</Text>
        ) : null}

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
            {!isFiltered && !isSearching ? (
              <View style={styles.emptyStateIconBadge}>
                <Ionicons name="document-text-outline" size={20} color={colors.textMuted} />
              </View>
            ) : (
              <View style={styles.emptyStateIconBadge}>
                <Ionicons name="search-outline" size={20} color={colors.textMuted} />
              </View>
            )}
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
                        source={{ uri: thumb.url, cacheKey: receiptImageCacheKey(report.receipt_path) }}
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
                    <Text style={styles.date} numberOfLines={1}>
                      {isolateLTR(formatReportDateTime(report.created_at))}
                    </Text>
                    {report.status === 'approved' && report.points_awarded > 0 ? (
                      <Text style={styles.points} numberOfLines={1}>{`נצברו ${isolateLTR(report.points_awarded)} נק׳`}</Text>
                    ) : null}
                  </View>

                  <View style={styles.trailing}>
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
  // STAGE 23: mirrors AdminHomeScreen's own Stage 22 pageHeader exactly
  // (eyebrow + title + subtitle sizes/weights) for visual consistency
  // between the two admin surfaces (Part R).
  pageHeader: {
    gap: 2,
  },
  pageEyebrow: {
    ...typography.micro,
    color: colors.textMuted,
    textAlign: 'right',
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
    marginTop: 2,
  },
  pageSubtitle: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: 2,
  },
  // STAGE 23: search/filters/result-context/list all live inside this one
  // tightly-spaced section, distinct from the larger gap AdminShell's own
  // bodyContent applies between pageHeader/summaryStrip/this section - see
  // the render's own comment above this View.
  listSection: {
    gap: spacing.sm,
  },
  summaryErrorRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.sm,
  },
  // STAGE 23, Part C: one bordered strip instead of three separate cards -
  // three equal segments (flex: 1 each) divided by a thin inner border,
  // each segment still independently tappable into the matching filter.
  // Deliberately no shadow - this is a compact status readout, not a card.
  summaryStrip: {
    flexDirection: 'row-reverse',
    backgroundColor: colors.white,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  // STAGE 23.1: tightened for 4 equal segments instead of 3 (paddingHorizontal
  // spacing.xs -> 2, gap 3 -> 2) - the strip now has to fit "הכל" as well,
  // and this is the one control on the page with the least per-item width
  // to spare on a 360px phone.
  summaryStripItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingVertical: spacing.sm,
    paddingHorizontal: 2,
    cursor: 'pointer',
  },
  // Divider between segments - applied to every item except the first
  // rendered (index 0), which in this row-reverse row sits at the right
  // edge and needs no border on its own leading side.
  summaryStripDivider: {
    borderRightWidth: 1,
    borderRightColor: colors.border,
  },
  summaryStripItemHovered: {
    backgroundColor: colors.surfaceMuted,
  },
  summaryStripItemPressed: {
    opacity: 0.85,
  },
  // The small pill wrapping the accent dot + count - this (not the whole
  // segment) is what tints when its filter is active, keeping the "active"
  // signal compact and centered rather than recoloring the entire strip
  // segment/divider. Horizontal padding trimmed (sm -> xs) for the same
  // 4-segment width reason as summaryStripItem above.
  summaryStripPill: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  summaryStripDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: colors.textMuted,
  },
  // STAGE 23.1: "הכל" gets the brand teal accent - it's the "no filter,
  // show everything" segment, distinct from the three real status accents
  // below.
  summaryStripDotAll: {
    backgroundColor: colors.primary,
  },
  summaryStripDotNeedsReview: {
    backgroundColor: colors.warning,
  },
  summaryStripDotApproved: {
    backgroundColor: colors.success,
  },
  summaryStripDotRejected: {
    backgroundColor: colors.error,
  },
  // STAGE 17.1 (carried forward): each item's ACTIVE (selected) look is
  // looked up from `activeFilter` itself - the same state now driving the
  // ONLY filter control on this screen (Stage 23.1 removed the separate
  // chip row that used to read the same state) - never a static flag
  // disconnected from selection. Reuses the exact same status colors as
  // src/utils/adminReportStatus.js/the row status badges below (amber for
  // "דורשות בדיקה", never the red/error tokens reserved for rejection;
  // green for "אושרו"; red for "נדחו"); "הכל" uses the brand teal soft tint.
  summaryChipActiveAll: {
    backgroundColor: colors.primarySoft,
  },
  summaryChipActiveNeedsReview: {
    backgroundColor: colors.warningSoft,
  },
  summaryChipActiveApproved: {
    backgroundColor: colors.successSoft,
  },
  summaryChipActiveRejected: {
    backgroundColor: colors.errorSoft,
  },
  summaryStripValue: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  summaryValueActiveAll: {
    color: colors.primaryPressed,
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
  summaryStripLabel: {
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '600',
    color: colors.textMuted,
    textAlign: 'center',
  },
  // STAGE 23, Part D: functionally unchanged from before (same TextInput,
  // same clear-X, same placeholder) - only minor visual polish (border/
  // radius already matched the "admin search control" spec, so this is
  // carried forward as-is).
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
  // STAGE 23, Part F: a plain small text row, not a card - real
  // visibleReports.length, nothing invented.
  resultContext: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'right',
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
  emptyStateIconBadge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surfaceMuted,
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
  // STAGE 23, Part M: a tighter gap (xs, not sm) between rows for a denser,
  // more table-like feel - option B from that part (subtle individual rows
  // with minimal gap), since the screen's existing structure already
  // renders each report as its own independently-styled Pressable (needed
  // for per-row hover/press/attention-border state) rather than one shared
  // container - restructuring to divider-separated single-container rows
  // (option A) would have meant rebuilding that per-row state handling for
  // a purely visual outcome, so option B integrates far more cleanly here.
  list: {
    gap: spacing.xs,
  },
  // STAGE 23, Part M: dropped shadows.softCard entirely - elevation now
  // comes only from the existing border, matching "subtle borders, avoid
  // heavy individual card shadows". minHeight raised 76 -> 84 (Part H's
  // ~82-94px target) to fit the larger 68px thumbnail; radius.md (not .lg)
  // reads as a denser list row rather than a standalone card.
  row: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 84,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    cursor: 'pointer',
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
  info: {
    flex: 1,
    minWidth: 0,
    alignItems: 'flex-end',
    gap: 2,
  },
  // Part I: the strongest text in the row - one line, ellipsis, never
  // pushed off-screen by the fixed-width thumbnail/trailing column since
  // this is the only flex: 1 element in the row.
  customer: {
    fontSize: 15,
    lineHeight: 19,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  filename: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'right',
  },
  date: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'right',
  },
  points: {
    ...typography.caption,
    fontWeight: '700',
    color: colors.success,
    textAlign: 'right',
  },
  // Trailing column (status pill above the chevron), stacked vertically -
  // takes only as much horizontal width as the badge itself needs, leaving
  // `info` (flex: 1) the rest. Mirrors AdminHomeScreen's own Stage 22
  // queueTrailing pattern exactly (Part R).
  trailing: {
    alignItems: 'center',
    gap: spacing.xs,
    flexShrink: 0,
  },
  // Part L: compact, quiet badge - never louder than the customer name
  // above. Same admin-facing labels/colors as getAdminReportStatusMeta
  // everywhere else (Detail, Admin Home) - no internal/backend wording.
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
