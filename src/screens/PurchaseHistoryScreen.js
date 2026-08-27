import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import AppBackButton from '../components/common/AppBackButton';
import AppScreen from '../components/common/AppScreen';
import PrimaryButton from '../components/common/PrimaryButton';
import { useAuth } from '../context/AuthContext';
import { getCachedReceiptUrl, getMyPurchaseReports, getReceiptSignedUrl } from '../services/purchaseReportService';
import { colors, radius, shadows, spacing, typography } from '../theme';
import { isolateLTR } from '../utils/bidiText';
import { getCustomerReceiptStatusMeta } from '../utils/purchaseReportStatus';

// Fixed-size receipt preview container - same portrait dimensions as
// HomeScreen's own recent-activity thumbnails (see that file), so a
// receipt's real proportions (portrait phone photo, landscape scan,
// screenshot, ...) never get stretched or cropped, at the cost of some
// empty letterboxing space.
const RECEIPT_IMAGE_WIDTH = 68;
const RECEIPT_IMAGE_HEIGHT = 92;

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

export default function PurchaseHistoryScreen() {
  const { user } = useAuth();
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeFilter, setActiveFilter] = useState('all');
  const [previewUrls, setPreviewUrls] = useState({});
  const [rootHeight, setRootHeight] = useState(0);
  const [heroHeight, setHeroHeight] = useState(0);

  // Same measured-minHeight approach as HomeScreen/ProfileScreen/
  // PurchaseScreen/RewardsScreen's dark hero + light sheet (see HomeScreen
  // for the full explanation) - guarantees the light sheet reaches the
  // bottom of the real screen regardless of the flex-grow chain between
  // here and the ScrollView.
  const onRootLayout = useCallback((event) => {
    setRootHeight(event.nativeEvent.layout.height);
  }, []);
  const onHeroLayout = useCallback((event) => {
    setHeroHeight(event.nativeEvent.layout.height);
  }, []);
  const sheetMinHeight =
    rootHeight > 0 && heroHeight > 0 ? rootHeight - heroHeight + radius.xl : undefined;

  // STAGE 15.2: cached signed URLs render immediately as 'ready' instead of
  // every entry resetting to 'loading' first - see HomeScreen.js's own
  // loadThumbnails for the full explanation (same fix, same reasoning).
  const loadThumbnails = useCallback((items, isActiveRef) => {
    items
      .filter((report) => !isPdfFile(report.original_filename) && report.receipt_path)
      .forEach((report) => {
        const cachedUrl = getCachedReceiptUrl(report.receipt_path);
        if (cachedUrl) {
          setPreviewUrls((prev) => ({ ...prev, [report.id]: { status: 'ready', url: cachedUrl } }));
          return;
        }

        setPreviewUrls((prev) => ({ ...prev, [report.id]: prev[report.id] ?? { status: 'loading', url: null } }));

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
    <View style={styles.root} onLayout={onRootLayout}>
      {/* Compact dark hero, same technique/tokens as the tab screens' own
          hero (see HomeScreen for the full explanation), just much
          shorter - this is a secondary/utility screen (back button +
          title only, no points card), not a main tab. */}
      <LinearGradient
        colors={[colors.bgDark, colors.charcoal]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={styles.heroGradient}
      />

      <AppScreen
        backgroundColor="transparent"
        contentContainerStyle={styles.screenContent}
        style={styles.screenInner}
        // No bottom edge - this screen sits above the tab bar as a pushed
        // route, but still renders within the same safe-area chain as the
        // tab screens; matches their own edges usage.
        edges={['top', 'left', 'right']}>
        <View style={styles.heroSection} onLayout={onHeroLayout}>
          <View style={styles.heroInner}>
            {/* mutedOnDark, not textMuted - the same gray character as the
                rest of the app's secondary-screen back buttons, just
                calibrated for a dark surface instead of a light one (see
                colors.js: textMuted drops below WCAG AA on dark surfaces). */}
            <AppBackButton
              deterministicRoute="/(tabs)"
              color={colors.mutedOnDark}
              style={styles.headerBackButton}
            />
            <View style={styles.headerTextBlock}>
              <Text style={styles.title}>היסטוריית רכישות</Text>
              <Text style={styles.subtitle}>כל החשבוניות והדיווחים שהעליתם</Text>
            </View>
          </View>
        </View>

        {/* Light content sheet - same full-bleed/rounded-top/measured-
            minHeight pattern as the tab screens' own sheet. */}
        <View style={[styles.sheet, sheetMinHeight ? { minHeight: sheetMinHeight } : null]}>
          <View style={styles.sheetInner}>
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
                  const statusMeta = getCustomerReceiptStatusMeta(report.status);
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
                            <Text style={styles.thumbnailPlaceholderText}>{isolateLTR('PDF')}</Text>
                          </View>
                        ) : preview?.status === 'ready' && preview.url ? (
                          <Image
                            source={{ uri: preview.url }}
                            style={styles.thumbnailImage}
                            contentFit="contain"
                            cachePolicy="memory-disk"
                            recyclingKey={report.id}
                            transition={100}
                          />
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
                          {report.original_filename ? isolateLTR(report.original_filename) : 'חשבונית'}
                        </Text>
                        <Text style={styles.reportDate}>{isolateLTR(formatReportDate(report.created_at))}</Text>
                      </View>

                      <View style={styles.statusColumn}>
                        <View style={[styles.statusBadge, { backgroundColor: statusMeta.backgroundColor }]}>
                          <Text style={[styles.statusBadgeText, { color: statusMeta.textColor }]}>{statusMeta.label}</Text>
                        </View>
                        {showPoints ? (
                          <Text style={styles.reportPoints}>
                            {`+${isolateLTR(formatNumber(report.points_awarded))} נק׳`}
                          </Text>
                        ) : null}
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>
        </View>
      </AppScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  heroGradient: {
    ...StyleSheet.absoluteFillObject,
  },
  // Same cancel-AppScreen's-own-wrapper technique as the tab screens (see
  // HomeScreen's screenInner comment for the full flex-chain explanation).
  screenInner: {
    flex: 1,
    width: '100%',
    maxWidth: '100%',
    alignSelf: 'stretch',
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  screenContent: {
    flexGrow: 1,
  },
  // Deliberately short - back button + title/subtitle only, no points card
  // or other bulky content, since this is a secondary/utility screen, not
  // a main tab.
  heroSection: {
    paddingTop: spacing.sm,
    // Extra bottom padding absorbs the sheet's negative marginTop overlap
    // below (see `sheet`), so the rounded corners never cut into the
    // header text.
    paddingBottom: spacing.xl + radius.xl,
  },
  heroInner: {
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    position: 'relative',
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
    color: colors.textOnDark,
    textAlign: 'right',
  },
  subtitle: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.mutedOnDark,
    textAlign: 'right',
    marginTop: spacing.xs,
    lineHeight: 18,
  },
  sheet: {
    flex: 1,
    backgroundColor: colors.background,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    marginTop: -radius.xl,
  },
  sheetInner: {
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xl,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
  },
  filterRow: {
    flexDirection: 'row-reverse',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  filterChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: radius.pill,
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
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'flex-end',
    gap: spacing.sm,
    ...shadows.softCard,
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
    borderRadius: radius.lg,
    padding: spacing.xl,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    gap: spacing.xs,
    ...shadows.softCard,
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
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    ...shadows.softCard,
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
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
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
  // Fixed-size container (not tied to the image's real aspect ratio) - the
  // CONTAINER dictates the box, and the image (resizeMode="contain" below)
  // scales down to fit inside it however it needs to, so a receipt's real
  // proportions never get stretched or cropped, at the cost of some empty
  // letterboxing space - same technique as HomeScreen's own receipt
  // thumbnails.
  thumbnailWrap: {
    width: RECEIPT_IMAGE_WIDTH,
    height: RECEIPT_IMAGE_HEIGHT,
    borderRadius: radius.sm,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceMuted,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
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
    borderRadius: radius.pill,
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
