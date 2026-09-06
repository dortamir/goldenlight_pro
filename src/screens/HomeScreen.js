import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import AppScreen from '../components/common/AppScreen';
import PointsBalanceCard from '../components/common/PointsBalanceCard';
import { getMembershipLevelInfo } from '../constants/membershipLevels';
import { useAuth } from '../context/AuthContext';
import { getProfile } from '../services/profileService';
import { colors, radius, shadows, spacing, typography } from '../theme';
import { isolateLTR } from '../utils/bidiText';

// STAGE 25: "דיווח רכישה" keeps its exact existing route/copy/icon - only
// the second card (previously a plain "מתנות" link) changed, to emphasize
// point redemption instead - see the render below for its slightly stronger
// accent treatment (isRewardsAction). Both still route to already-existing
// screens; no new backend/route was added for either.
const quickActions = [
  {
    key: 'report',
    title: 'דיווח רכישה',
    subtitle: 'העלאת חשבונית חדשה',
    route: '/(tabs)/purchase',
    icon: 'receipt-outline',
  },
  {
    key: 'rewards',
    title: 'למימוש הנקודות',
    subtitle: 'למתנות ולמימוש הנקודות שלך',
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
  const { user, loading: authLoading, profileVersion, birthdayBonus, dismissBirthdayBonus } = useAuth();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // STAGE 15.3: tracks whether a profile fetch has ever SUCCEEDED this
  // session, independent of React state/re-renders (a ref, not state, so it
  // can't itself trigger a re-render or become a useCallback dependency -
  // putting `profile` state directly in loadProfile's own dependency array
  // would recreate that callback on every successful fetch, which would
  // re-trigger useFocusEffect's own re-run-while-focused behavior and fetch
  // in a loop). Used to distinguish the true first load (full-screen
  // spinner) from a background refresh-on-focus (last-good data stays
  // visible the whole time, per Stage 15.3's stale-while-refresh
  // requirement).
  const hasLoadedProfileRef = useRef(false);
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
  // ProfileScreen.js's own profile load already uses. The backend
  // profile/ledger remains the sole source of truth - this never
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
          hasLoadedProfileRef.current = false;
          setProfile(null);
          setLoading(false);
          setError('');
          return;
        }

        // STAGE 15.3: only the TRUE first load blocks with the full-screen
        // spinner. A background refresh-on-focus (points/membership may
        // have changed elsewhere) keeps showing the last-good profile the
        // whole time instead of flashing back to a loading state on every
        // tab revisit - this is what actually made switching tabs feel
        // slow, not the network request itself (already fast per prior
        // stages' fixes).
        const isInitialLoad = !hasLoadedProfileRef.current;

        try {
          if (isInitialLoad) {
            setLoading(true);
          }
          setError('');
          const data = await getProfile(user.id);

          if (!isMounted) {
            return;
          }

          if (__DEV__) {
            console.log('[Home] loadProfile succeeded', { isInitialLoad });
          }

          setProfile(data);
          hasLoadedProfileRef.current = true;
        } catch (err) {
          if (!isMounted) {
            return;
          }

          if (__DEV__) {
            console.warn('[Home] loadProfile failed', { isInitialLoad, code: err?.code, message: err?.message });
          }

          // A background-refresh failure keeps the last-good profile
          // visible (stale-while-refresh) rather than replacing it with an
          // error card - the data on screen is still real, just not
          // reconfirmed this time. Only the true first load, which has
          // nothing valid to fall back to, shows the error state.
          if (isInitialLoad) {
            setProfile(null);
            setError('לא הצלחנו לטעון את נתוני החשבון');
          }
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
    // STAGE 26: profileVersion is bumped by AuthContext exactly when the
    // birthday-bonus RPC actually awards points (see that file's own
    // comment) - included here purely as a "please re-run this fetch now"
    // signal so Home, if already focused at that exact moment, shows the
    // real post-bonus points_balance immediately rather than the last-
    // fetched value. Still the same getProfile() call/cache as before, not
    // a second data source.
    }, [user?.id, authLoading, profileVersion]),
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
            {/* STAGE 27: the personal greeting is now the visual entry point
                of the hero - substantially larger/bolder/brighter than
                before (see `greeting` below), sitting clearly above the
                existing "ברוכים הבאים ל GOLDEN+" headline, which stays the
                larger of the two (36px vs this line's 28px) so the
                approved hierarchy (greeting -> headline -> tagline ->
                points card) is preserved, not inverted. numberOfLines={1}
                is a defensive addition only (an unusually long name
                truncates instead of wrapping to a second line and growing
                the hero) - no change to the name/personalization logic
                itself. */}
            <Text style={styles.greeting} numberOfLines={1}>
              {loading ? 'טוען...' : `שלום, ${firstName}`}
            </Text>
            {/* STAGE 25 / 25.1: the full headline MUST stay on one line at
                normal iPhone widths - numberOfLines={1} + adjustsFontSizeToFit
                lets RN shrink the rendered font size (down to
                minimumFontScale, 55% of `title`'s own 36px base = ~20px
                floor) just enough to fit the available width instead of
                wrapping or clipping. The base size was deliberately raised
                (Stage 25.1) starting from a large, confident size and only
                shrinking on narrower devices when actually needed, rather
                than sizing down for the narrowest case up front. "GOLDEN+"
                stays plain (no separate color/weight split) - there is no
                existing app-wide convention for highlighting that substring
                differently from the rest of a sentence, and inventing one
                here would be a new typography pattern, not a reuse of an
                existing one. */}
            <Text style={styles.title} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.55}>
              {`ברוכים הבאים ל ${isolateLTR('GOLDEN+')}`}
            </Text>
            <Text style={styles.tagline}>מועדון המקצוענים של גולדן לייט</Text>

            {/* STAGE 25, Part B: PointsBalanceCard itself is otherwise
                unchanged - same data, same loading/error/retry behavior.
                STAGE 25.2: the `meta` prop ("מתנות יופיעו בהמשך") was
                removed entirely, not replaced - the component's own
                conditional render (`{meta ? <Text>...</Text> : null}`)
                means omitting it renders nothing at all, reserving no
                vertical space, rather than leaving an empty placeholder
                line.
                STAGE 25.6: `style` (the component's own existing, documented
                "optional outer style override, e.g. margin" prop - nothing
                new added to PointsBalanceCard.js) widens just this card's
                outer edges via pointsCardWidthOverride below, to align with
                the light section's own wider content box - see that
                style's own comment for the exact math. heroInner's padding
                itself (and therefore the greeting/headline/tagline's own
                position) is untouched. */}
            <PointsBalanceCard
              pointsBalance={pointsBalance}
              membershipLevel={safeMembershipLevel}
              progressPercent={levelInfo.progressPercent ?? 100}
              progressLabel={levelProgressLabel}
              loading={loading}
              error={error}
              onRetry={() =>
                user?.id &&
                getProfile(user.id)
                  .then(setProfile)
                  .catch(() => setError('לא הצלחנו לטעון את נתוני החשבון'))
              }
              style={styles.pointsCardWidthOverride}
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
            {/* STAGE 26: one-time celebratory message for the rare session
                that actually receives the annual birthday bonus -
                AuthContext's own birthdayBonus state, null on every other
                visit. Dismissible; dismissing clears the context state so
                it never reappears (not re-derived from anything stored -
                the real once-per-year guarantee is entirely in the
                database, see supabase/migrations/028_birthday_bonus.sql).
                Placed here (not in the protected hero section above) as a
                small additive, conditional card using the exact same
                visual language as the rest of this light sheet - not a
                redesign of Stage 25.7's own approved layout. */}
            {birthdayBonus ? (
              <View style={styles.birthdayBanner}>
                <View style={styles.birthdayBannerIconWrap}>
                  <Ionicons name="gift" size={22} color={colors.primary} />
                </View>
                <View style={styles.birthdayBannerTextWrap}>
                  <Text style={styles.birthdayBannerTitle}>יום הולדת שמח! 🎉</Text>
                  <Text style={styles.birthdayBannerBody}>
                    {`${birthdayBonus.bonusPoints.toLocaleString('he-IL')} נקודות מתנה נוספו לחשבון שלך`}
                  </Text>
                </View>
                <Pressable
                  onPress={dismissBirthdayBonus}
                  accessibilityRole="button"
                  accessibilityLabel="סגירה"
                  hitSlop={8}
                  style={styles.birthdayBannerClose}>
                  <Ionicons name="close" size={18} color={colors.textMuted} />
                </Pressable>
              </View>
            ) : null}

            <View style={styles.section}>
              <View style={styles.sectionHeaderRow}>
                <View style={styles.sectionHeadingGroup}>
                  <Text style={[styles.sectionLabel, styles.sectionTitle]}>פעולות מהירות</Text>
                  <View style={styles.sectionAccentDot} />
                </View>
              </View>
              <View style={styles.actionsRow}>
                {quickActions.map((action) => {
                  return (
                    <Pressable
                      key={action.key}
                      style={({ pressed }) => [styles.actionCard, pressed && styles.actionCardPressed]}
                      onPress={() => router.push(action.route)}>
                      {/* STAGE 25.7: the "למימוש הנקודות" card's own accent
                          icon-badge treatment (solid teal bg + white icon)
                          was removed - both quick-action cards now share the
                          exact same actionIconWrap style (soft-tint bg +
                          teal icon), same icon size, same badge dimensions/
                          radius, matching "דיווח רכישה" exactly. */}
                      <View style={styles.actionIconWrap}>
                        <Ionicons name={action.icon} size={20} color={colors.primary} />
                      </View>
                      <Text style={styles.actionTitle}>{action.title}</Text>
                      <Text style={styles.actionSubtitle}>{action.subtitle}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            {/* STAGE 25, Part F-J: replaces the old "פעילות אחרונה" section
                (heading, "לכל הפעילות" link, two receipt-thumbnail cards)
                entirely with one wide image-based card leading to the same
                existing history route ("/(tabs)/activity", exactly what
                "לכל הפעילות" used to push) - no new route, no duplicated
                screen. The whole card is the one accessible action (a
                single accessibilityLabel covering both the heading and the
                CTA's meaning) - the CTA pill below is purely decorative
                text/icon, not a second nested Pressable, so no duplicate
                accessibility target is announced. */}
            <Pressable
              onPress={() => router.push('/(tabs)/activity')}
              style={({ pressed }) => [styles.historyHero, pressed && styles.historyHeroPressed]}
              accessibilityRole="button"
              accessibilityLabel="היסטוריית הרכישות, מעבר לצפייה בחשבוניות ובדיווחים">
              {/* STAGE 25, Part G: local decorative asset - see
                  src/assets/images/purchase-history-hero.png. No remote URL,
                  no runtime fetch; contentFit="cover" fills this card's
                  fixed aspect-ratio box without distortion. */}
              <Image
                source={require('../assets/images/purchase-history-hero.png')}
                style={styles.historyHeroImage}
                contentFit="cover"
              />
              <LinearGradient
                colors={['transparent', 'rgba(6, 10, 10, 0.92)']}
                start={{ x: 0, y: 0 }}
                end={{ x: 0, y: 1 }}
                style={styles.historyHeroOverlay}
                pointerEvents="none"
              />
              <View style={styles.historyHeroContent} pointerEvents="none">
                <Text style={styles.historyHeroTitle}>היסטוריית הרכישות</Text>
                <Text style={styles.historyHeroSubtitle}>לצפייה בחשבוניות ובדיווחים שלך</Text>
                <View style={styles.historyHeroCta}>
                  <Text style={styles.historyHeroCtaText}>להיסטוריית הרכישות</Text>
                  <Ionicons name="chevron-back" size={14} color={colors.primary} />
                </View>
              </View>
            </Pressable>

            {/* STAGE 25.7: richer promotional banner - a purely
                informational block, still not a Pressable (no onPress
                anywhere in it), no route, no backend call, no new business
                logic. "למימוש הנקודות" (the quick action above) remains the
                one real action toward Rewards. Uses only existing Ionicons
                + styled Views for the decorative reward area - no new image
                asset, no new dependency. Same overall width as the
                purchase-history hero above (both are plain children of
                sheetInner, width:'100%' by default, no explicit override on
                either), so their left/right edges already align. */}
            <LinearGradient
              colors={[colors.primarySoft, colors.white]}
              start={{ x: 0.05, y: 0 }}
              end={{ x: 0.95, y: 1 }}
              style={styles.motivationBanner}>
              <View style={styles.motivationBannerTopRow}>
                <View style={styles.motivationBannerTextWrap}>
                  <Text style={styles.motivationBannerTitle}>
                    {'🎁 כל קנייה משתלמת יותר עם '}
                    <Text style={styles.motivationBannerTitleAccent}>{isolateLTR('Golden Light')}</Text>
                    {'!'}
                  </Text>
                  <Text style={styles.motivationBannerBody}>
                    המשיכו לצבור נקודות על כל רכישה של מוצרי Golden Light והמירו אותן למתנות, הטבות ופרסים שווים
                    במיוחד.
                  </Text>
                </View>

                {/* Decorative reward area - a larger gift badge with a small
                    overlapping sparkle accent, built entirely from existing
                    Ionicons + styled Views (no illustration asset). */}
                <View style={styles.motivationBannerGiftArea}>
                  <View style={styles.motivationBannerGiftBadge}>
                    <Ionicons name="gift" size={32} color={colors.primary} />
                  </View>
                  <View style={styles.motivationBannerSparkleBadge}>
                    <Ionicons name="sparkles" size={12} color={colors.primaryPressed} />
                  </View>
                </View>
              </View>

              <View style={styles.motivationBannerFooter}>
                <Ionicons name="sparkles" size={13} color={colors.primaryPressed} />
                <Text style={styles.motivationBannerFooterText}>קונים וצוברים נקודות — ממשיכים ליהנות!</Text>
              </View>
            </LinearGradient>
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
    // STAGE 25, Part A: a touch more top breathing room than before
    // (spacing.sm -> spacing.md), matching the larger welcome block below -
    // deliberately modest, not an oversized hero (Part A's own "do not make
    // the top excessively tall").
    paddingTop: spacing.md,
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
  // STAGE 25.6: heroInner (spacing.lg = 16px horizontal padding) and
  // sheetInner (spacing.md = 12px) share the exact same maxWidth:480,
  // alignSelf:'center' outer box, but use different padding - which was the
  // actual, sole cause of the points card (a plain block that stretches to
  // fill heroInner's own content width, same as the greeting/title/tagline
  // Text elements above it) rendering 4px narrower on each side than the
  // light section's own content. Rather than reducing heroInner's own
  // padding (which would also shift the welcome text's position/wrapping -
  // explicitly not wanted this stage), this negative margin - applied only
  // to the card via its own existing `style` prop - pulls just the card's
  // outer edges out by that same 4px on each side, landing it exactly on
  // sheetInner's own content edges: card left edge = heroInner's content
  // left (spacing.lg) minus 4 = spacing.md, matching sheetInner's own left
  // padding precisely (and symmetrically on the right) - a relative,
  // token-derived value, not a hardcoded pixel width, so it stays correct
  // at any screen width.
  pointsCardWidthOverride: {
    marginHorizontal: -(spacing.lg - spacing.md),
  },
  // STAGE 25.1: fontSize 17 -> 18, still clearly the smallest/most muted
  // line of the three, but large enough to read as a real opening line
  // rather than a caption.
  // STAGE 27: fontSize 18 -> 28, fontWeight 600 -> 800 - this line is now
  // the screen's true visual entry point, clearly stronger than before,
  // while still staying smaller than `title` below it (36px) so the
  // approved greeting -> headline -> tagline -> points-card hierarchy reads
  // correctly rather than the two lines competing. marginBottom trimmed
  // 8 -> 4 to absorb most of the added line height, so the hero's overall
  // height grows only modestly rather than by the full ~10px fontSize
  // increase.
  // STAGE 27.1: color textOnDark (white) -> primary (the app's own
  // turquoise brand token, already used throughout for accents/CTAs) - the
  // greeting is now immediately recognizable in the brand color against the
  // dark hero, per this stage's explicit request. Size/weight/spacing all
  // unchanged from Stage 27.
  greeting: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '800',
    letterSpacing: -0.2,
    color: colors.primary,
    textAlign: 'right',
    marginBottom: 4,
  },
  // STAGE 25.1: fontSize 32 -> 36, letterSpacing added - clearly larger and
  // bolder, the real hero headline of the screen. fontWeight stays '800'
  // (the app's reserved maximum weight, otherwise only used for hero/
  // display numerals - already adopted for this in Stage 25).
  // numberOfLines/adjustsFontSizeToFit/minimumFontScale (see the render
  // above) are what keep "ברוכים הבאים ל GOLDEN+" on one line at every
  // supported width instead of wrapping.
  title: {
    fontSize: 36,
    lineHeight: 42,
    fontWeight: '800',
    letterSpacing: -0.3,
    color: colors.textOnDark,
    textAlign: 'right',
  },
  // STAGE 25.1: fontSize 15 -> 16, marginTop/marginBottom both nudged up
  // slightly for a touch more breathing room before the points card, on
  // top of Stage 25's own spacing.xl -> spacing.xxl increase.
  tagline: {
    fontSize: 16,
    fontWeight: '500',
    color: colors.mutedOnDark,
    textAlign: 'right',
    marginTop: 8,
    marginBottom: spacing.xxl + spacing.xs,
  },
  sheet: {
    flex: 1,
    backgroundColor: colors.background,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    marginTop: -radius.xl,
  },
  // Larger gap BETWEEN sections (quick actions vs. the history hero) than
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
  // STAGE 26: one-time celebratory banner - same white/border/softCard
  // card language as the quick-action cards below it, not a new visual
  // system.
  birthdayBanner: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.primary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    ...shadows.softCard,
  },
  birthdayBannerIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 14,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  birthdayBannerTextWrap: {
    flex: 1,
    gap: 2,
  },
  birthdayBannerTitle: {
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  birthdayBannerBody: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
  },
  birthdayBannerClose: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
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
  // STAGE 25.7: both quick-action cards now share this exact same icon-
  // badge treatment - the "למימוש הנקודות" card's own solid-teal accent
  // variant (Stage 25, Part D) was removed at the user's request.
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
  // STAGE 25, Part F: landscape hero card, ~1.8:1 (within the requested
  // 1.7-2:1 range) - width:'100%' of sheetInner, which is itself capped at
  // maxWidth:480 and centered, so this never grows "absurdly tall" on
  // tablet/web (Part O) - it's bounded by the exact same column every other
  // Home content already uses.
  historyHero: {
    width: '100%',
    aspectRatio: 1.8,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: colors.charcoal,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.softCard,
  },
  historyHeroPressed: {
    opacity: 0.92,
  },
  historyHeroImage: {
    ...StyleSheet.absoluteFillObject,
  },
  // STAGE 25, Part H: a restrained top-transparent -> bottom-dark gradient,
  // not a flat opaque layer - the image stays visible through most of the
  // card; only the lower portion (where the text sits) darkens enough for
  // white text to stay readable.
  historyHeroOverlay: {
    ...StyleSheet.absoluteFillObject,
  },
  historyHeroContent: {
    flex: 1,
    justifyContent: 'flex-end',
    padding: spacing.lg,
  },
  historyHeroTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: colors.textOnDark,
    textAlign: 'right',
  },
  historyHeroSubtitle: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.mutedOnDark,
    textAlign: 'right',
    marginTop: 4,
    marginBottom: spacing.md,
  },
  // STAGE 25, Part H: compact outlined/teal-accent CTA - a soft-teal-tinted
  // pill with a teal border, reading as "integrated into the card" rather
  // than a separate solid white button sitting on top of a photo.
  historyHeroCta: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    alignSelf: 'flex-end',
    gap: 4,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: 'rgba(46, 196, 199, 0.16)',
  },
  historyHeroCtaText: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.primary,
  },
  // STAGE 25.7: richer promotional banner below the history hero - a
  // subtle two-stop gradient (colors.primarySoft -> colors.white, both
  // existing tokens, no new palette) reading as a premium "rewards card"
  // rather than a flat fill, a soft teal-tinted border (a local rgba value
  // scoped to just this style, not a new shared theme token), and the same
  // restrained shadow every other Home card uses. Same width as the
  // purchase-history hero above (see the render's own comment).
  motivationBanner: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: 'rgba(46, 196, 199, 0.35)',
    paddingHorizontal: 20,
    paddingVertical: 20,
    gap: spacing.lg,
    ...shadows.softCard,
  },
  motivationBannerTopRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.md,
  },
  motivationBannerTextWrap: {
    flex: 1,
    gap: 6,
  },
  motivationBannerTitle: {
    fontSize: 18,
    lineHeight: 24,
    fontWeight: '800',
    color: colors.text,
    textAlign: 'right',
  },
  // The "Golden Light" accent within the title (see the render's nested
  // Text) - same size/weight as the surrounding title, only the color
  // changes, so it reads as emphasis rather than a separate heading.
  motivationBannerTitleAccent: {
    color: colors.primaryPressed,
  },
  motivationBannerBody: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
  },
  // Decorative reward area - fixed-size, flexShrink: 0 so it never
  // squeezes the text column; the surrounding 84x84 box gives the small
  // overlapping sparkle badge room to sit outside the main 72x72 gift
  // badge without being clipped.
  motivationBannerGiftArea: {
    width: 84,
    height: 84,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  motivationBannerGiftBadge: {
    width: 72,
    height: 72,
    borderRadius: 26,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(46, 196, 199, 0.25)',
    ...shadows.sm,
  },
  motivationBannerSparkleBadge: {
    position: 'absolute',
    top: 2,
    left: 2,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.sm,
  },
  // STAGE 25.7, Part 7: a small non-interactive pill reinforcing the
  // purchase -> points -> reward loop - never a button (no onPress
  // anywhere on it), just a subtle highlighted row under the main text.
  motivationBannerFooter: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    alignSelf: 'flex-end',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.white,
  },
  motivationBannerFooterText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.primaryPressed,
  },
});