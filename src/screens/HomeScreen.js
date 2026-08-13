import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';

import AppScreen from '../components/common/AppScreen';
import PointsBalanceCard from '../components/common/PointsBalanceCard';
import { useAuth } from '../context/AuthContext';
import { getProfile } from '../services/profileService';
import { getMyPurchaseReports, getReceiptSignedUrl } from '../services/purchaseReportService';
import { colors, radius, shadows, spacing, typography } from '../theme';

function isPdfFile(name) {
  return /\.pdf$/i.test(String(name || ''));
}

// Compact 2-column receipt grid: tile width is computed from the grid's own
// measured layout width (see onGridLayout below) rather than a hardcoded
// percentage, so it can never overflow regardless of screen padding/gap at
// any viewport.
const GRID_GAP = spacing.sm;
const THUMB_HEIGHT = 108;

const quickActions = [
  {
    title: 'דיווח רכישה',
    subtitle: 'העלאת חשבונית חדשה',
    route: '/(tabs)/purchase',
    icon: 'receipt-outline',
  },
  {
    title: 'הטבות',
    subtitle: 'צפייה בהטבות שלך',
    route: '/(tabs)/rewards',
    icon: 'gift-outline',
  },
];

export default function HomeScreen() {
  const { user } = useAuth();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reports, setReports] = useState([]);
  const [reportsLoading, setReportsLoading] = useState(true);
  const [reportsError, setReportsError] = useState('');
  const [previewUrls, setPreviewUrls] = useState({});
  const [gridWidth, setGridWidth] = useState(0);
  const [rootHeight, setRootHeight] = useState(0);
  const [heroHeight, setHeroHeight] = useState(0);

  const onGridLayout = useCallback((event) => {
    setGridWidth(event.nativeEvent.layout.width);
  }, []);

  // Measures the screen's own real available height and the hero's own
  // real rendered height directly, instead of trusting flexGrow/flex:1 to
  // propagate correctly through every intermediate wrapper between here and
  // the ScrollView (AppScreen's inner View, SafeAreaView, and - since this
  // screen lives under a bottom tab bar - React Navigation's own tab-screen
  // wrapper too). That chain checked out in every reproduction tried during
  // development, but a measured minHeight (see `sheet` below) guarantees
  // the light sheet reaches the bottom of the real screen regardless of
  // whether every layer of that chain resolves the same way on every
  // device - it only depends on `root` itself reporting its true height,
  // which it always does.
  const onRootLayout = useCallback((event) => {
    setRootHeight(event.nativeEvent.layout.height);
  }, []);
  const onHeroLayout = useCallback((event) => {
    setHeroHeight(event.nativeEvent.layout.height);
  }, []);
  const sheetMinHeight =
    rootHeight > 0 && heroHeight > 0 ? rootHeight - heroHeight + radius.xl : undefined;

  useEffect(() => {
    let isMounted = true;

    async function loadProfile() {
      if (!user?.id) {
        setProfile(null);
        setLoading(false);
        setError('');
        return;
      }

      try {
        setLoading(true);
        setError('');
        const data = await getProfile(user.id);

        if (!isMounted) {
          return;
        }

        setProfile(data);
      } catch (err) {
        if (!isMounted) {
          return;
        }

        setProfile(null);
        setError('לא הצלחנו לטעון את נתוני החשבון');
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    loadProfile();

    return () => {
      isMounted = false;
    };
  }, [user?.id]);

  // Thumbnails are only requested for the 4 reports actually rendered in
  // "פעילות אחרונה" (see recentReports.slice below), never the full report
  // list - keeps this bounded to at most 4 signed-URL requests per focus,
  // the same private-Storage pattern already used by PurchaseHistoryScreen
  // (never getPublicUrl, never a public bucket).
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
          setReportsLoading(false);
          setReportsError('');
          return;
        }

        try {
          setReportsLoading(true);
          setReportsError('');
          const data = await getMyPurchaseReports(user.id);

          if (isActiveRef.current) {
            setReports(data);
            loadThumbnails(data.slice(0, 4), isActiveRef);
          }
        } catch (err) {
          if (isActiveRef.current) {
            setReports([]);
            setReportsError('לא הצלחנו לטעון את הפעילות האחרונה');
          }
        } finally {
          if (isActiveRef.current) {
            setReportsLoading(false);
          }
        }
      }

      loadReports();

      return () => {
        isActiveRef.current = false;
      };
    }, [user?.id, loadThumbnails]),
  );

  const firstName = (() => {
    const fullName = String(profile?.full_name || '').trim();

    if (!fullName) {
      return 'שלום';
    }

    const [name] = fullName.split(/\s+/);
    return name || 'שלום';
  })();

  const membershipLevel = String(profile?.membership_level || 'BRONZE').toUpperCase();
  const safeMembershipLevel = ['BRONZE', 'SILVER', 'GOLD'].includes(membershipLevel)
    ? membershipLevel
    : 'BRONZE';
  const pointsBalance = profile?.points_balance ?? 0;

  const formatNumber = (value) => {
    const numericValue = Number.isFinite(value) ? value : 0;
    return numericValue.toLocaleString('he-IL');
  };

  const formatReportDate = (value) => {
    const date = new Date(value);

    if (!value || Number.isNaN(date.getTime())) {
      return '';
    }

    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${day}.${month}.${year}`;
  };

  const getStatusMeta = (status) => {
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
  };

  const recentReports = reports.slice(0, 4);
  const tileWidth = gridWidth > 0 ? (gridWidth - GRID_GAP) / 2 : undefined;

  return (
    <View style={styles.root} onLayout={onRootLayout}>
      {/* Full-bleed dark hero, edge-to-edge including the safe-area/status-bar
          zone - same technique as AuthScreenShell (see that file), applied
          here with the app's flatter bgDark->charcoal pair rather than the
          richer teal-tinted gradientDarkStart/End, which PointsBalanceCard
          already uses for its own background - keeping the hero visibly
          flatter than the card lets the card read as an elevated, premium
          surface sitting on top of it instead of blending into an identical
          gradient. */}
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
        // No bottom edge - this screen is nested under the (tabs) bottom
        // tab bar, which already provides its own clearance below the
        // content. Without this, SafeAreaView also pads for the device's
        // raw bottom safe-area inset (e.g. the ~34px home-indicator area on
        // notched iPhones), stacking on top of the tab bar's own space and
        // leaving a gap above it where the dark hero gradient behind
        // everything shows through - invisible on web (0 bottom inset
        // there) but real on notched devices.
        edges={['top', 'left', 'right']}>
        <View style={styles.heroSection} onLayout={onHeroLayout}>
          <View style={styles.heroInner}>
            <Text style={styles.greeting}>{loading ? 'טוען...' : `שלום, ${firstName}`}</Text>
            <Text style={styles.title}>ברוכים הבאים ל +GOLDEN</Text>
            <Text style={styles.tagline}>מועדון המקצוענים של גולדן לייט</Text>

            <PointsBalanceCard
              pointsBalance={pointsBalance}
              membershipLevel={safeMembershipLevel}
              progressPercent={0}
              meta="הטבות יופיעו בהמשך"
              loading={loading}
              error={error}
              onRetry={() =>
                user?.id &&
                getProfile(user.id)
                  .then(setProfile)
                  .catch(() => setError('לא הצלחנו לטעון את נתוני החשבון'))
              }
            />
          </View>
        </View>

        {/* Light content sheet - full-bleed with rounded top corners
            (matching the hero's edge-to-edge width), so on wide/web
            viewports the light area covers the whole background rather than
            leaving dark gradient exposed on the sides. Actual content stays
            centered/max-width via sheetInner, same pattern AppScreen itself
            uses for the hero. */}
        <View style={[styles.sheet, sheetMinHeight ? { minHeight: sheetMinHeight } : null]}>
          <View style={styles.sheetInner}>
            <View style={styles.section}>
              <View style={styles.sectionHeaderRow}>
                <View style={styles.sectionHeadingGroup}>
                  <Text style={[styles.sectionLabel, styles.sectionTitle]}>פעולות מהירות</Text>
                  <View style={styles.sectionAccentDot} />
                </View>
              </View>
              <View style={styles.actionsRow}>
                {quickActions.map((action) => (
                  <Pressable
                    key={action.title}
                    style={({ pressed }) => [styles.actionCard, pressed && styles.actionCardPressed]}
                    onPress={() => router.push(action.route)}>
                    <View style={styles.actionIconWrap}>
                      <Ionicons name={action.icon} size={20} color={colors.primary} />
                    </View>
                    <Text style={styles.actionTitle}>{action.title}</Text>
                    <Text style={styles.actionSubtitle}>{action.subtitle}</Text>
                  </Pressable>
                ))}
              </View>
            </View>

            <View style={styles.section}>
              <View style={styles.sectionHeaderRow}>
                <View style={styles.sectionHeadingGroup}>
                  <Text style={[styles.sectionLabel, styles.sectionTitle]}>פעילות אחרונה</Text>
                  <View style={styles.sectionAccentDot} />
                </View>
                <Pressable
                  onPress={() => router.push('/(tabs)/activity')}
                  accessibilityRole="link"
                  style={styles.viewAllRow}
                  hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}>
                  <Ionicons name="chevron-back" size={18} color={colors.primary} style={styles.viewAllIcon} />
                  <Text style={[styles.sectionLabel, styles.viewAllText]}>לכל הפעילות</Text>
                </Pressable>
              </View>
              {reportsLoading ? (
                <View style={styles.activityCard}>
                  <View style={styles.activityLoadingWrap}>
                    <ActivityIndicator color={colors.primary} size="small" />
                  </View>
                </View>
              ) : reportsError ? (
                <View style={styles.activityCard}>
                  <View style={styles.activityInfo}>
                    <Text style={styles.activityErrorText}>{reportsError}</Text>
                    <Pressable
                      onPress={() =>
                        user?.id &&
                        getMyPurchaseReports(user.id)
                          .then((data) => {
                            setReports(data);
                            setReportsError('');
                            loadThumbnails(data.slice(0, 4), { current: true });
                          })
                          .catch(() => setReportsError('לא הצלחנו לטעון את הפעילות האחרונה'))
                      }>
                      <Text style={styles.retryText}>נסו שוב</Text>
                    </Pressable>
                  </View>
                </View>
              ) : recentReports.length === 0 ? (
                <View style={styles.activityCard}>
                  <View style={styles.activityInfo}>
                    <Text style={styles.activityTitle}>אין פעילות אחרונה להצגה</Text>
                    <Text style={styles.activitySubtitle}>הפעילות תופיע כאן לאחר אישורים חדשים</Text>
                  </View>
                </View>
              ) : (
                <View style={styles.activityGrid} onLayout={onGridLayout}>
                  {recentReports.map((report) => {
                  const statusMeta = getStatusMeta(report.status);
                  const showPoints = report.status === 'approved' && report.points_awarded > 0;
                  const isPdf = isPdfFile(report.original_filename);
                  const preview = previewUrls[report.id];

                  return (
                    <Pressable
                      key={report.id}
                      style={({ pressed }) => [
                        styles.activityTile,
                        tileWidth ? { width: tileWidth } : { width: '48%' },
                        pressed && styles.activityTilePressed,
                      ]}
                      onPress={() =>
                        router.push({ pathname: '/(tabs)/activity/[id]', params: { id: report.id, from: 'home' } })
                      }
                      accessibilityRole="button"
                      accessibilityLabel="פתיחת פרטי חשבונית">
                      <View style={styles.activityTileThumbnailWrap}>
                        {isPdf ? (
                          <View style={styles.activityTilePlaceholder}>
                            <Text style={styles.activityTilePlaceholderText}>PDF</Text>
                          </View>
                        ) : preview?.status === 'ready' && preview.url ? (
                          <Image source={{ uri: preview.url }} style={styles.activityTileThumbnailImage} resizeMode="contain" />
                        ) : preview?.status === 'loading' ? (
                          <View style={styles.activityTilePlaceholder}>
                            <ActivityIndicator color={colors.primary} size="small" />
                          </View>
                        ) : (
                          <View style={styles.activityTilePlaceholder}>
                            <Text style={styles.activityTilePlaceholderText}>חשבונית</Text>
                          </View>
                        )}
                      </View>

                      <Text style={styles.activityTileTitle}>חשבונית</Text>
                      <Text style={styles.activityTileDate}>{formatReportDate(report.created_at)}</Text>

                      <View style={[styles.statusBadge, { backgroundColor: statusMeta.backgroundColor }]}>
                        <Text style={[styles.statusBadgeText, { color: statusMeta.textColor }]}>{statusMeta.label}</Text>
                      </View>

                      {showPoints ? (
                        <Text style={styles.activityPoints}>{`+${formatNumber(report.points_awarded)} נק׳`}</Text>
                      ) : null}
                    </Pressable>
                  );
                  })}
                </View>
              )}
            </View>
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
  // Cancels AppScreen's own default maxWidth:480/padding wrapper so the
  // hero and sheet backgrounds below can bleed full-width edge-to-edge;
  // heroInner/sheetInner re-apply the same centered max-width constraint
  // to their actual content only, matching every other screen's rhythm on
  // wide/web viewports. flex:1 is required here (not just on `sheet`
  // below) - this View is AppScreen's own content wrapper, sitting between
  // the ScrollView's flexGrow:1 content container and our hero/sheet
  // children; without flex:1 on this exact node, `sheet`'s own flex:1 has
  // nothing to expand into, so it only grows to its natural content height
  // and the dark hero gradient (which fills the whole screen behind
  // everything) shows through as a bare strip below it, above the tab bar.
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
  heroSection: {
    paddingTop: spacing.sm,
    // Extra bottom padding absorbs the sheet's negative marginTop overlap
    // below, so the rounded corners never cut into the points card.
    paddingBottom: spacing.xxl + radius.xl,
  },
  heroInner: {
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
  },
  greeting: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.mutedOnDark,
    textAlign: 'right',
    marginBottom: 4,
  },
  title: {
    fontSize: 24,
    lineHeight: 30,
    fontWeight: '700',
    color: colors.textOnDark,
    textAlign: 'right',
  },
  tagline: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.mutedOnDark,
    textAlign: 'right',
    marginTop: 4,
    marginBottom: spacing.xl,
  },
  sheet: {
    flex: 1,
    backgroundColor: colors.background,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    marginTop: -radius.xl,
  },
  // Larger gap BETWEEN sections (quick actions vs. recent activity) than
  // within one (see `section` below, heading-to-content) - the hierarchy
  // the heading/content spacing is meant to express.
  sheetInner: {
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xl,
    paddingBottom: spacing.xxl,
    gap: spacing.lg,
  },
  // Smaller internal gap - the heading feels directly connected to its own
  // content, distinct from the larger between-section gap above.
  section: {
    gap: spacing.md,
  },
  sectionHeaderRow: {
    flexDirection: 'row-reverse',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sectionHeadingGroup: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.xs,
  },
  // Shared by sectionTitle and viewAllText below (same fontSize/fontWeight/
  // lineHeight - only color differs, since "לכל הפעילות" is interactive).
  sectionLabel: {
    fontSize: 18,
    fontWeight: '700',
    lineHeight: 24,
  },
  sectionTitle: {
    color: colors.text,
    textAlign: 'right',
  },
  // Small decorative accent only - the heading text itself stays dark, per
  // "do not make every heading turquoise".
  sectionAccentDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.primary,
  },
  retryText: {
    fontSize: typography.caption.fontSize,
    fontWeight: '700',
    color: colors.primary,
    textAlign: 'right',
  },
  // No minHeight:44 here - the 44px touch target comes from the
  // Pressable's hitSlop instead (see JSX), so it doesn't add invisible
  // layout height that would push the heading-to-content gap out wider
  // than intended.
  viewAllRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: spacing.xs,
  },
  viewAllIcon: {
    marginTop: 1,
  },
  viewAllText: {
    color: colors.primary,
    textAlign: 'right',
  },
  actionsRow: {
    flexDirection: 'row-reverse',
    gap: spacing.md,
    alignItems: 'stretch',
  },
  actionCard: {
    flex: 1,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xl,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.softCard,
    alignItems: 'flex-end',
    minHeight: 122,
    justifyContent: 'center',
  },
  // Subtle turquoise border on press instead of a heavier neon glow/opacity
  // dip - stays premium and restrained.
  actionCardPressed: {
    borderColor: colors.primary,
    opacity: 0.97,
  },
  actionIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 14,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  actionTitle: {
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  actionSubtitle: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: spacing.xs,
  },
  activityCard: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
    ...shadows.softCard,
  },
  activityInfo: {
    flex: 1,
    alignItems: 'flex-end',
  },
  activityTitle: {
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  activitySubtitle: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: spacing.xs,
  },
  activityGrid: {
    flexDirection: 'row-reverse',
    flexWrap: 'wrap',
    rowGap: GRID_GAP,
    columnGap: GRID_GAP,
  },
  // width is set per-tile at render time from the grid's own measured
  // layout width (see onGridLayout/tileWidth) - this is just the shared
  // visual styling.
  activityTile: {
    backgroundColor: colors.white,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xs,
    alignItems: 'flex-end',
    ...shadows.softCard,
  },
  activityTilePressed: {
    opacity: 0.85,
  },
  // Fixed height, not an aspect ratio tied to the tile width - the
  // CONTAINER dictates the box, and the image (resizeMode="contain" below)
  // scales down to fit inside it however it needs to, so a receipt's real
  // proportions (portrait photo, landscape scan, square crop, ...) never
  // get stretched or aggressively cropped, at the cost of some empty
  // letterboxing space, which is an acceptable and expected trade-off for a
  // homescreen preview.
  activityTileThumbnailWrap: {
    width: '100%',
    height: THUMB_HEIGHT,
    borderRadius: radius.sm,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceMuted,
    marginBottom: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  activityTileThumbnailImage: {
    width: '100%',
    height: '100%',
  },
  activityTilePlaceholder: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceMuted,
  },
  activityTilePlaceholderText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.textMuted,
    textAlign: 'center',
  },
  activityTileTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  activityTileDate: {
    fontSize: 10,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: 1,
  },
  activityLoadingWrap: {
    minHeight: 64,
    justifyContent: 'center',
    alignItems: 'center',
  },
  activityErrorText: {
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.error,
    textAlign: 'right',
  },
  statusBadge: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing.xs,
    paddingVertical: 3,
    alignSelf: 'flex-end',
    marginTop: 4,
  },
  statusBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    textAlign: 'center',
  },
  activityPoints: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.success,
    textAlign: 'right',
    marginTop: 2,
  },
});
