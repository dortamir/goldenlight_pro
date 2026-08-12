import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';

import AppBackButton from '../components/common/AppBackButton';
import AppScreen from '../components/common/AppScreen';
import PrimaryButton from '../components/common/PrimaryButton';
import { useAuth } from '../context/AuthContext';
import { getMyPurchaseReports, getReceiptSignedUrl } from '../services/purchaseReportService';
import { colors, shadows, spacing, typography } from '../theme';

const historyFilters = [
  { key: 'all', label: 'הכל' },
  { key: 'pending', label: 'ממתינות' },
  { key: 'approved', label: 'אושרו' },
  { key: 'rejected', label: 'נדחו' },
];

const PENDING_STATUSES = ['submitted', 'processing', 'needs_review'];

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

function formatNumber(value) {
  const numericValue = Number.isFinite(value) ? value : 0;
  return numericValue.toLocaleString('he-IL');
}

function isPdfFile(name) {
  return /\.pdf$/i.test(String(name || ''));
}

function getStatusMeta(status) {
  switch (status) {
    case 'processing':
      return { label: 'בעיבוד', backgroundColor: colors.primarySoft, textColor: colors.primary };
    case 'needs_review':
      return { label: 'נדרשת בדיקה', backgroundColor: colors.surfaceMuted, textColor: colors.textMuted };
    case 'approved':
      return { label: 'אושרה', backgroundColor: colors.successSoft, textColor: colors.success };
    case 'rejected':
      return { label: 'נדחתה', backgroundColor: colors.errorSoft, textColor: colors.error };
    case 'submitted':
    default:
      return { label: 'נשלחה לבדיקה', backgroundColor: colors.primarySoft, textColor: colors.primaryPressed };
  }
}

export default function PurchaseHistoryScreen() {
  const { user } = useAuth();
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeFilter, setActiveFilter] = useState('all');
  const [previewUrls, setPreviewUrls] = useState({});

  const loadThumbnails = useCallback((items, isActiveRef) => {
    items
      .filter((report) => !isPdfFile(report.original_filename) && report.receipt_path)
      .forEach((report) => {
        setPreviewUrls((prev) => ({ ...prev, [report.id]: { status: 'loading', url: null } }));

        getReceiptSignedUrl(report.receipt_path)
          .then((url) => {
            if (!isActiveRef.current) {
              return;
            }
            setPreviewUrls((prev) => ({ ...prev, [report.id]: { status: url ? 'ready' : 'error', url } }));
          })
          .catch(() => {
            if (!isActiveRef.current) {
              return;
            }
            setPreviewUrls((prev) => ({ ...prev, [report.id]: { status: 'error', url: null } }));
          });
      });
  }, []);

  useFocusEffect(
    useCallback(() => {
      const isActiveRef = { current: true };
      setPreviewUrls({});

      async function loadReports() {
        if (!user?.id) {
          setReports([]);
          setLoading(false);
          setError('');
          return;
        }

        try {
          setLoading(true);
          setError('');
          const data = await getMyPurchaseReports(user.id);

          if (isActiveRef.current) {
            setReports(data);
            loadThumbnails(data, isActiveRef);
          }
        } catch (err) {
          if (isActiveRef.current) {
            setReports([]);
            setError('לא הצלחנו לטעון את היסטוריית הרכישות');
          }
        } finally {
          if (isActiveRef.current) {
            setLoading(false);
          }
        }
      }

      loadReports();

      return () => {
        isActiveRef.current = false;
      };
    }, [user?.id, loadThumbnails]),
  );

  const retryLoad = () => {
    if (!user?.id) {
      return;
    }

    const isActiveRef = { current: true };
    setLoading(true);
    setError('');
    getMyPurchaseReports(user.id)
      .then((data) => {
        setReports(data);
        loadThumbnails(data, isActiveRef);
      })
      .catch(() => setError('לא הצלחנו לטעון את היסטוריית הרכישות'))
      .finally(() => setLoading(false));
  };

  const openReportDetails = (report) => {
    router.push({ pathname: '/(tabs)/activity/[id]', params: { id: report.id, from: 'history' } });
  };

  const filteredReports = useMemo(() => {
    if (activeFilter === 'pending') {
      return reports.filter((report) => PENDING_STATUSES.includes(report.status));
    }

    if (activeFilter === 'approved') {
      return reports.filter((report) => report.status === 'approved');
    }

    if (activeFilter === 'rejected') {
      return reports.filter((report) => report.status === 'rejected');
    }

    return reports;
  }, [activeFilter, reports]);

  const hasAnyReports = reports.length > 0;
  const hasFilteredReports = filteredReports.length > 0;

  return (
    <AppScreen backgroundColor={colors.background} contentContainerStyle={styles.screenContent}>
      <View style={styles.container}>
        <View style={styles.header}>
          <AppBackButton deterministicRoute="/(tabs)" style={styles.headerBackButton} />
          <View style={styles.headerTextBlock}>
            <Text style={styles.title}>היסטוריית רכישות</Text>
            <Text style={styles.subtitle}>כל החשבוניות והדיווחים שהעליתם</Text>
          </View>
        </View>

        {!loading && !error && hasAnyReports ? (
          <View style={styles.filterRow}>
            {historyFilters.map((filter) => {
              const active = filter.key === activeFilter;
              return (
                <Pressable
                  key={filter.key}
                  style={[styles.filterChip, active && styles.filterChipActive]}
                  onPress={() => setActiveFilter(filter.key)}>
                  <Text style={[styles.filterText, active && styles.filterTextActive]}>{filter.label}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {loading ? (
          <View style={styles.loadingState}>
            <ActivityIndicator color={colors.primary} size="small" />
          </View>
        ) : error ? (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>{error}</Text>
            <Pressable onPress={retryLoad} accessibilityRole="button">
              <Text style={styles.retryText}>נסו שוב</Text>
            </Pressable>
          </View>
        ) : !hasAnyReports ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>עדיין לא העליתם חשבוניות</Text>
            <Text style={styles.emptySubtitle}>העלו חשבונית ראשונה כדי להתחיל לצבור נקודות</Text>
            <PrimaryButton
              title="דיווח רכישה"
              onPress={() => router.push('/(tabs)/purchase')}
              style={styles.emptyButton}
            />
          </View>
        ) : !hasFilteredReports ? (
          <View style={styles.filterEmptyCard}>
            <Text style={styles.filterEmptyText}>אין דיווחים בקטגוריה הזו</Text>
          </View>
        ) : (
          <View style={styles.reportList}>
            {filteredReports.map((report) => {
              const statusMeta = getStatusMeta(report.status);
              const showPoints = report.status === 'approved' && report.points_awarded > 0;
              const isPdf = isPdfFile(report.original_filename);
              const preview = previewUrls[report.id];

              return (
                <Pressable
                  key={report.id}
                  style={({ pressed }) => [styles.reportCard, pressed && styles.reportCardPressed]}
                  onPress={() => openReportDetails(report)}
                  accessibilityRole="button"
                  accessibilityLabel="פתיחת פרטי חשבונית">
                  <View style={styles.thumbnailWrap}>
                    {isPdf ? (
                      <View style={styles.thumbnailPlaceholder}>
                        <Text style={styles.thumbnailPlaceholderText}>PDF</Text>
                      </View>
                    ) : preview?.status === 'ready' && preview.url ? (
                      <Image source={{ uri: preview.url }} style={styles.thumbnailImage} resizeMode="cover" />
                    ) : preview?.status === 'loading' ? (
                      <View style={styles.thumbnailPlaceholder}>
                        <ActivityIndicator color={colors.primary} size="small" />
                      </View>
                    ) : (
                      <View style={styles.thumbnailPlaceholder}>
                        <Text style={styles.thumbnailPlaceholderText}>חשבונית</Text>
                      </View>
                    )}
                  </View>

                  <View style={styles.reportInfo}>
                    <Text style={styles.reportTitle}>חשבונית</Text>
                    <Text style={styles.reportFilename} numberOfLines={1} ellipsizeMode="tail">
                      {report.original_filename || 'חשבונית'}
                    </Text>
                    <Text style={styles.reportDate}>{formatReportDate(report.created_at)}</Text>
                  </View>

                  <View style={styles.statusColumn}>
                    <View style={[styles.statusBadge, { backgroundColor: statusMeta.backgroundColor }]}>
                      <Text style={[styles.statusBadgeText, { color: statusMeta.textColor }]}>{statusMeta.label}</Text>
                    </View>
                    {showPoints ? (
                      <Text style={styles.reportPoints}>{`+${formatNumber(report.points_awarded)} נק׳`}</Text>
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
          </View>
        )}
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  screenContent: {
    justifyContent: 'flex-start',
    alignItems: 'stretch',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xl,
    paddingBottom: spacing.huge,
  },
  container: {
    width: '100%',
    gap: spacing.md,
  },
  header: {
    position: 'relative',
    alignItems: 'flex-end',
    paddingTop: 2,
    paddingBottom: 2,
  },
  headerBackButton: {
    position: 'absolute',
    top: 0,
    right: 0,
    zIndex: 1,
  },
  headerTextBlock: {
    width: '100%',
    alignItems: 'flex-end',
    paddingEnd: 56,
  },
  title: {
    fontSize: typography.title.fontSize,
    fontWeight: typography.title.fontWeight,
    color: colors.text,
    textAlign: 'right',
  },
  subtitle: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: spacing.xs,
    lineHeight: 18,
  },
  filterRow: {
    flexDirection: 'row-reverse',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: 2,
  },
  filterChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.border,
    minHeight: 34,
    justifyContent: 'center',
  },
  filterChipActive: {
    backgroundColor: colors.primarySoft,
    borderColor: colors.primary,
  },
  filterText: {
    fontSize: typography.caption.fontSize,
    fontWeight: '600',
    color: colors.textMuted,
    textAlign: 'right',
  },
  filterTextActive: {
    color: colors.primary,
  },
  loadingState: {
    minHeight: 140,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: spacing.md,
  },
  errorCard: {
    backgroundColor: colors.white,
    borderRadius: 16,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'flex-end',
    gap: spacing.sm,
  },
  errorText: {
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.error,
    textAlign: 'right',
  },
  retryText: {
    fontSize: typography.caption.fontSize,
    fontWeight: '700',
    color: colors.primary,
    textAlign: 'right',
  },
  emptyCard: {
    backgroundColor: colors.white,
    borderRadius: 20,
    padding: spacing.xl,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    gap: spacing.xs,
  },
  emptyTitle: {
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: spacing.md,
  },
  emptyButton: {
    width: '100%',
  },
  filterEmptyCard: {
    backgroundColor: colors.white,
    borderRadius: 16,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  filterEmptyText: {
    fontSize: typography.caption.fontSize,
    fontWeight: '600',
    color: colors.textMuted,
    textAlign: 'center',
  },
  reportList: {
    gap: spacing.md,
  },
  reportCard: {
    backgroundColor: colors.white,
    borderRadius: 18,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    ...shadows.softCard,
  },
  reportCardPressed: {
    opacity: 0.85,
  },
  thumbnailWrap: {
    width: 56,
    height: 56,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceMuted,
    flexShrink: 0,
  },
  thumbnailImage: {
    width: '100%',
    height: '100%',
  },
  thumbnailPlaceholder: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceMuted,
  },
  thumbnailPlaceholderText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.textMuted,
    textAlign: 'center',
  },
  reportInfo: {
    flex: 1,
    minWidth: 0,
    alignItems: 'flex-end',
  },
  reportTitle: {
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  reportFilename: {
    width: '100%',
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: 2,
  },
  reportDate: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: 2,
  },
  statusColumn: {
    flexShrink: 0,
    alignItems: 'flex-end',
    gap: 4,
  },
  reportPoints: {
    fontSize: typography.caption.fontSize,
    fontWeight: '700',
    color: colors.success,
    textAlign: 'right',
    marginTop: 2,
  },
  statusBadge: {
    flexShrink: 0,
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    alignSelf: 'flex-start',
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'center',
  },
});
