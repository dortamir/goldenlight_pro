import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';

import AdminShell from '../components/admin/AdminShell';
import { getAdminReceiptSignedUrl, getAdminReports } from '../services/adminReportService';
import { colors, radius, shadows, spacing, typography } from '../theme';

const THUMB_WIDTH = 52;
const THUMB_HEIGHT = 68;

// Client-side filters over the single full getAdminReports() list - no
// separate query per filter. Mapped strictly to existing purchase_reports
// statuses, never an invented one. 'pending' intentionally groups submitted
// + needs_review, mirroring REVIEW_QUEUE_STATUSES in adminReportService.js,
// since there is still no automated pipeline distinguishing them from an
// admin's point of view. 'processing' is deliberately NOT one of these -
// it isn't part of the current admin-facing workflow (a 'processing' report
// still appears under "הכל", just isn't isolated by its own pill). These
// same keys are what AdminHomeScreen's dashboard cards link to via
// `/admin/reports?filter=<key>` - see the `filter` param handling below.
const STATUS_FILTERS = [
  { key: 'all', label: 'הכל', statuses: null },
  { key: 'pending', label: 'ממתינות לבדיקה', statuses: ['submitted', 'needs_review'] },
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

// Same admin-specific status vocabulary as AdminHomeScreen/
// AdminReportDetailScreen - not extracted into a shared helper, matching
// the existing per-screen convention already used throughout this app.
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
    setLoading(true);
    setError('');
    setThumbnails({});

    getAdminReports()
      .then((rows) => {
        setReports(rows);

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
      .catch(() => setError('לא הצלחנו לטעון את רשימת החשבוניות'))
      .finally(() => setLoading(false));
  }, []);

  // useFocusEffect (not a plain mount-only useEffect) - refetches whenever
  // this screen regains focus, e.g. returning from a decision made on the
  // detail screen, matching AdminHomeScreen's own refresh behavior. This
  // never resets activeFilter - only loadReports() runs here - so returning
  // from a receipt's detail screen via real back-navigation lands back on
  // this same still-mounted instance with whichever filter was active
  // before, refreshed with current data.
  useFocusEffect(
    useCallback(() => {
      loadReports();
    }, [loadReports]),
  );

  const visibleReports = useMemo(() => {
    const filter = STATUS_FILTERS.find((item) => item.key === activeFilter) || STATUS_FILTERS[0];
    if (!filter.statuses) {
      return reports;
    }
    return reports.filter((report) => filter.statuses.includes(report.status));
  }, [reports, activeFilter]);

  const isFiltered = activeFilter !== 'all';

  return (
    <AdminShell activeKey="history">
      <View style={styles.section}>
        <Text style={styles.pageTitle}>כל החשבוניות</Text>

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
            <Text style={styles.emptyText}>{isFiltered ? 'אין חשבוניות בסטטוס זה' : 'אין חשבוניות להצגה'}</Text>
          </View>
        ) : (
          <View style={styles.list}>
            {visibleReports.map((report) => {
              const statusMeta = getStatusMeta(report.status);
              const isPdf = isPdfFile(report.original_filename);
              const thumb = thumbnails[report.id];

              return (
                <Pressable
                  key={report.id}
                  style={({ pressed, hovered }) => [
                    styles.row,
                    hovered && styles.rowHovered,
                    pressed && styles.rowPressed,
                  ]}
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

                  <View style={styles.info}>
                    <Text style={styles.customer} numberOfLines={1}>
                      {report.customerName || 'משתמש ללא שם'}
                    </Text>
                    <Text style={styles.filename} numberOfLines={1}>
                      {report.original_filename || 'חשבונית'}
                    </Text>
                    <Text style={styles.date}>{formatReportDate(report.created_at)}</Text>
                    {report.status === 'approved' && report.points_awarded > 0 ? (
                      <Text style={styles.points}>{`נצברו ${report.points_awarded} נק׳`}</Text>
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
