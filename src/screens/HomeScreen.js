import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import AppScreen from '../components/common/AppScreen';
import PointsBalanceCard from '../components/common/PointsBalanceCard';
import { getMembershipLevelInfo } from '../constants/membershipLevels';
import { useAuth } from '../context/AuthContext';
import { getProfile } from '../services/profileService';
import { getCachedReceiptUrl, getMyPurchaseReports, getReceiptSignedUrl } from '../services/purchaseReportService';
import { colors, radius, shadows, spacing, typography } from '../theme';
import { isolateLTR } from '../utils/bidiText';
import { getCustomerReceiptStatusMeta } from '../utils/purchaseReportStatus';

function isPdfFile(name) {
  return /\.pdf$/i.test(String(name || ''));
}

// Fixed-size receipt preview container for the two side-by-side horizontal
// recent-activity cards - width/height stay constant regardless of the
// source image's real proportions (portrait phone photo, landscape scan,
// screenshot, ...), see activityRowThumbnailWrap/activityRowThumbnailImage
// below.
const RECEIPT_IMAGE_WIDTH = 68;
const RECEIPT_IMAGE_HEIGHT = 92;

const quickActions = [
  {
    title: 'דיווח רכישה',
    subtitle: 'העלאת חשבונית חדשה',
    route: '/(tabs)/purchase',
    icon: 'receipt-outline',
  },
  {
    title: 'מתנות',
    subtitle: 'צפייה במתנות שלך',
    route: '/(tabs)/rewards',
    icon: 'gift-outline',
  },
];

export default function HomeScreen() {
  // STAGE 15.2 COLD-START FIX: `authLoading` (AuthContext's own `loading`)
  // is pulled in explicitly and used to gate every data fetch below - not
  // just `user?.id`. Routing already prevents this screen from mounting
  // while auth is loading (app/index.js, app/(tabs)/_layout.js), but that
  // gate is on a DIFFERENT component tree than this one; relying on it
  // alone left this screen with no explicit signal of its own to react to
  // "auth just became ready" as an event, only to `user?.id`'s scalar
  // value - which, per the cold-start reports, was not always enough by
  // itself. Depending on `authLoading` directly here means this screen's
  // own effects re-run the moment auth settles even in an edge case where
  // it were ever reached while still marked loading, instead of silently
  // firing a request against not-yet-fully-settled auth state.
  const { user, loading: authLoading } = useAuth();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reports, setReports] = useState([]);
  const [reportsLoading, setReportsLoading] = useState(true);
  const [reportsError, setReportsError] = useState('');
  const [previewUrls, setPreviewUrls] = useState({});
  const [rootHeight, setRootHeight] = useState(0);
  const [heroHeight, setHeroHeight] = useState(0);

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

  // STAGE 9: useFocusEffect, not a plain mount-only useEffect - a customer
  // whose receipt gets approved elsewhere (while this tab stays mounted in
  // the background, the normal case for a bottom-tab navigator) must see
  // their real points_balance on returning to this tab, not a stale value
  // from whenever it first mounted. Matches the exact pattern
  // ProfileScreen.js's own profile load already uses, and the pattern
  // recentReports already uses right below for the same reason. The
  // backend profile/ledger remains the sole source of truth - this never
  // adds/estimates points locally, only re-fetches the authoritative value.
  useFocusEffect(
    useCallback(() => {
      let isMounted = true;

      async function loadProfile() {
        if (__DEV__) {
          console.log('[Home] Focus - loadProfile start', { authLoading, hasUserId: Boolean(user?.id) });
        }

        // Auth itself may still be settling (e.g. immediately after a cold
        // start's session restoration reaches this screen through some
        // future navigation path this screen doesn't control) - never issue
        // a request against not-yet-ready auth state, and leave `loading`
        // as-is (still true from its initial state) rather than flipping it
        // false with nothing real to show, which would let the points card
        // render a bare "0" as if it were the authoritative balance.
        if (authLoading) {
          if (__DEV__) {
            console.log('[Home] loadProfile deferred - auth still loading');
          }
          return;
        }

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

          if (__DEV__) {
            console.log('[Home] loadProfile succeeded');
          }

          setProfile(data);
        } catch (err) {
          if (!isMounted) {
            return;
          }

          if (__DEV__) {
            console.warn('[Home] loadProfile failed', { code: err?.code, message: err?.message });
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
    }, [user?.id, authLoading]),
  );

  // Thumbnails are only requested for the 2 reports actually rendered in
  // "פעילות אחרונה" (see recentReports.slice below), never the full report
  // list - keeps this bounded to at most 2 signed-URL requests per focus,
  // the same private-Storage pattern already used by PurchaseHistoryScreen
  // (never getPublicUrl, never a public bucket).
  // STAGE 15.2: no longer resets every entry to 'loading' up front - a
  // cached signed URL (getCachedReceiptUrl, synchronous) is shown
  // immediately as 'ready', so a report whose thumbnail was already loaded
  // earlier this session never flashes back to a placeholder just because
  // the user switched tabs and came back. Only genuinely uncached reports
  // go through the 'loading' -> fetch -> 'ready'/'error' sequence.
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
        if (__DEV__) {
          console.log('[Home] Focus - loadReports start', { authLoading, hasUserId: Boolean(user?.id) });
        }

        // Same auth-readiness gate as loadProfile above - never fetch
        // against not-yet-settled auth state, and leave reportsLoading as
        // its current (initially true) value instead of clearing it with
        // nothing real to show.
        if (authLoading) {
          if (__DEV__) {
            console.log('[Home] loadReports deferred - auth still loading');
          }
          return;
        }

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
            if (__DEV__) {
              console.log('[Home] loadReports succeeded', { count: data.length });
            }
            setReports(data);
            loadThumbnails(data.slice(0, 2), isActiveRef);
          }
        } catch (err) {
          if (isActiveRef.current) {
            if (__DEV__) {
              console.warn('[Home] loadReports failed', { code: err?.code, message: err?.message });
            }
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
    }, [user?.id, authLoading, loadThumbnails]),
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
  const safeMembershipLevel = ['BRONZE', 'SILVER', 'GOLD', 'TITANIUM'].includes(membershipLevel)
    ? membershipLevel
    : 'BRONZE';
  const pointsBalance = profile?.points_balance ?? 0;

  // Real progress toward the next G Level, derived from the same
  // database-authoritative approved_purchases_count used to compute
  // membership_level itself (see supabase/migrations/017_g_level_progression.sql
  // and src/constants/membershipLevels.js) - never a client-invented value,
  // and never shown as progress toward a nonexistent level after Titanium.
  const approvedPurchasesCount = profile?.approved_purchases_count ?? 0;
  const levelInfo = getMembershipLevelInfo(approvedPurchasesCount);
  const levelProgressLabel = levelInfo.nextLevel
    ? `${isolateLTR(`${levelInfo.progressInBracket} / ${levelInfo.bracketSize}`)} ל-${isolateLTR(levelInfo.nextLevel)}`
    : 'הגעתם לרמה הגבוהה ביותר';

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

  const recentReports = reports.slice(0, 2);

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
            <Text style={styles.title}>{`ברוכים הבאים ל ${isolateLTR('GOLDEN+')}`}</Text>
            <Text style={styles.tagline}>מועדון המקצוענים של גולדן לייט</Text>

            <PointsBalanceCard
              pointsBalance={pointsBalance}
              membershipLevel={safeMembershipLevel}
              progressPercent={levelInfo.progressPercent ?? 100}
              progressLabel={levelProgressLabel}
              meta="מתנות יופיעו בהמשך"
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
                            loadThumbnails(data.slice(0, 2), { current: true });
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
                <View style={styles.activityList}>
                  {recentReports.map((report) => {
                    const statusMeta = getCustomerReceiptStatusMeta(report.status);
                    const showPoints = report.status === 'approved' && report.points_awarded > 0;
                    const isPdf = isPdfFile(report.original_filename);
                    const preview = previewUrls[report.id];

                    return (
                      <Pressable
                        key={report.id}
                        style={({ pressed }) => [styles.activityRow, pressed && styles.activityRowPressed]}
                        onPress={() =>
                          router.push({ pathname: '/(tabs)/activity/[id]', params: { id: report.id, from: 'home' } })
                        }
                        accessibilityRole="button"
                        accessibilityLabel="פתיחת פרטי חשבונית">
                        {/* Image on the RIGHT, info on the LEFT: this is the
                            first JSX child inside a row-reverse container,
                            which places it at the visual end (right) of the
                            row explicitly, rather than relying on default
                            browser/OS direction behavior. */}
                        <View style={styles.activityRowThumbnailWrap}>
                          {isPdf ? (
                            <View style={styles.activityRowPlaceholder}>
                              <Text style={styles.activityRowPlaceholderText}>{isolateLTR('PDF')}</Text>
                            </View>
                          ) : preview?.status === 'ready' && preview.url ? (
                            <Image
                              source={{ uri: preview.url }}
                              style={styles.activityRowThumbnailImage}
                              contentFit="contain"
                              cachePolicy="memory-disk"
                              recyclingKey={report.id}
                              transition={100}
                            />
                          ) : preview?.status === 'loading' ? (
                            <View style={styles.activityRowPlaceholder}>
                              <ActivityIndicator color={colors.primary} size="small" />
                            </View>
                          ) : (
                            <View style={styles.activityRowPlaceholder}>
                              <Text style={styles.activityRowPlaceholderText}>חשבונית</Text>
                            </View>
                          )}
                        </View>

                        <View style={styles.activityRowInfo}>
                          <Text style={styles.activityRowTitle} numberOfLines={1}>חשבונית</Text>
                          <Text style={styles.activityRowDate} numberOfLines={1}>
                            {isolateLTR(formatReportDate(report.created_at))}
                          </Text>

                          <View style={[styles.statusBadge, { backgroundColor: statusMeta.backgroundColor }]}>
                            <Text style={[styles.statusBadgeText, { color: statusMeta.textColor }]} numberOfLines={1}>
                              {statusMeta.label}
                            </Text>
                          </View>

                          {showPoints ? (
                            <Text style={styles.activityPoints} numberOfLines={1}>
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
  // Two cards side by side, sharing the EXACT same row/gap system as
  // actionsRow above (not a separately invented width calculation), so the
  // two rows of cards align into one consistent 2-column grid. row-reverse
  // so the first-rendered (most recent) report lands on the right, matching
  // RTL reading order.
  activityList: {
    flexDirection: 'row-reverse',
    gap: spacing.md,
    alignItems: 'stretch',
  },
  // flex:1 (matching actionCard's own flex:1 below) gives both cards the
  // same width as the Quick Action cards automatically, without measuring
  // anything. image-right/info-left internally via row-reverse - first JSX
  // child (thumbnail) lands at the visual right, second (info block) at the
  // visual left - explicit RTL order, not incidental browser/OS direction.
  // justifyContent:'center' (paired with activityRowInfo NOT being flex:1
  // below) is what makes the image+info group read as one centered unit
  // rather than the image sitting on the border with info stretched flush
  // to the opposite edge.
  activityRow: {
    flex: 1,
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    // Kept thin - at the narrowest supported width (360px, ~142px card)
    // every extra pixel here comes straight out of the info column's text
    // budget. The "not edge-flush" feel comes from justifyContent:'center'
    // + activityRowInfo no longer being flex:1 (so the image+info group is
    // only as wide as it needs to be and centers with room on both sides),
    // not from padding size.
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.sm,
    gap: spacing.lg,
    minHeight: 122,
    ...shadows.softCard,
  },
  activityRowPressed: {
    opacity: 0.85,
  },
  // Fixed-size container (not tied to the image's real aspect ratio) - the
  // CONTAINER dictates the box, and the image (resizeMode="contain" below)
  // scales down to fit inside it however it needs to, so a receipt's real
  // proportions (portrait phone photo, landscape scan, screenshot, ...)
  // never get stretched or cropped, at the cost of some empty letterboxing
  // space - an acceptable trade-off for a homescreen preview.
  activityRowThumbnailWrap: {
    width: RECEIPT_IMAGE_WIDTH,
    height: RECEIPT_IMAGE_HEIGHT,
    borderRadius: radius.sm,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  activityRowThumbnailImage: {
    width: '100%',
    height: '100%',
  },
  activityRowPlaceholder: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceMuted,
  },
  activityRowPlaceholderText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textMuted,
    textAlign: 'center',
  },
  // No flex:1 here (unlike the previous full-width version) - sizing to its
  // own natural content width, instead of stretching to fill the card, is
  // what lets activityRow's justifyContent:'center' actually center the
  // image+info group as one unit. flexShrink:1 is a safety net: if a card
  // ever ends up narrower than the natural content needs, this lets the
  // column shrink rather than overflow the card (numberOfLines on each
  // Text below then truncates gracefully instead of clipping the layout).
  activityRowInfo: {
    flexShrink: 1,
    alignItems: 'flex-end',
  },
  activityRowTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  activityRowDate: {
    fontSize: 10,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: 2,
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
