import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';

import AdminShell from '../components/admin/AdminShell';
import { getAdminReceiptSignedUrl, getAdminReports } from '../services/adminReportService';
import { colors, radius, shadows, spacing, typography } from '../theme';

const THUMB_WIDTH = 56;
const THUMB_HEIGHT = 76;

// Client-side filters over the single full getAdminReports() list - no
// separate query per filter. Mapped strictly to existing purchase_reports
// statuses, never an invented one. 'pending' intentionally groups submitted
// + needs_review, mirroring REVIEW_QUEUE_STATUSES in adminReportService.js,
// since there is still no automated pipeline distinguishing them from an
// admin's point of view.
const STATUS_FILTERS = [
  { key: 'all', label: 'הכל', statuses: null },
  { key: 'pending', label: 'ממתינות', statuses: ['submitted', 'needs_review'] },
  { key: 'processing', label: 'בטיפול', statuses: ['processing'] },
  { key: 'approved', label: 'אושרו', statuses: ['approved'] },
  { key: 'rejected', label: 'נדחו', statuses: ['rejected'] },
];

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

export default function AdminReportsHistoryScreen() {
  const router = useRouter();
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [thumbnails, setThumbnails] = useState({});
  const [activeFilter, setActiveFilter] = useState('all');

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
  // detail screen, matching AdminHomeScreen's own refresh behavior.
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
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionTitle}>כל החשבוניות</Text>
          <View style={styles.sectionAccentDot} />
        </View>

        <View style={styles.filterRow}>
          {STATUS_FILTERS.map((filter) => (
            <Pressable
              key={filter.key}
              onPress={() => setActiveFilter(filter.key)}
              style={[styles.filterChip, activeFilter === filter.key && styles.filterChipActive]}
              accessibilityRole="button">
              <Text style={[styles.filterChipText, activeFilter === filter.key && styles.filterChipTextActive]}>
                {filter.label}
              </Text>
            </Pressable>
          ))}
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
                  style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
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
  filterRow: {
    flexDirection: 'row-reverse',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  filterChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.white,
  },
  filterChipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
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
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    ...shadows.softCard,
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
