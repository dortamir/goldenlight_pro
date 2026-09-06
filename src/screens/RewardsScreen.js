import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Image, Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import AppScreen from '../components/common/AppScreen';
import PointsBalanceCard from '../components/common/PointsBalanceCard';
import { GOLDEN_LIGHT_WEBSITE_URL, POINTS_REDEMPTION_URL } from '../constants/externalLinks';
import { getMembershipLevelInfo } from '../constants/membershipLevels';
import { useAuth } from '../context/AuthContext';
import { getProfile } from '../services/profileService';
import { colors, radius, shadows, spacing, typography } from '../theme';
import { isolateLTR } from '../utils/bidiText';

// Opens an external link through the same safe canOpenURL-gated mechanism
// already used elsewhere in the app (see HelpSupportScreen's
// openUrlSafely), plus an explicit guard for the not-yet-configured
// placeholder URLs in constants/externalLinks.js: a null/empty url means
// "this destination isn't ready yet" and is intentionally a no-op, never a
// navigation to a fake/invented destination.
async function openExternalLinkSafely(url) {
  if (!url) {
    if (__DEV__) {
      console.warn('[Rewards] Tried to open a link before its real URL was configured in constants/externalLinks.js.');
    }
    return;
  }

  try {
    const canOpen = await Linking.canOpenURL(url);
    if (canOpen) {
      await Linking.openURL(url);
    }
  } catch (err) {
    if (__DEV__) {
      console.warn('[Rewards] Failed to open URL', url, err);
    }
  }
}

// STAGE 18.5/18.6: compact dark promo-banner card - now used for the gift
// card only (the Golden Light card became its own richer, vertically-
// composed component in Stage 18.6 - see GoldenLightCard below). Sits
// directly on the dark page background, no white/light wrapper. `visual`
// is caller-supplied JSX for the left-side badge. `url` decides the CTA
// entirely: truthy -> a real active turquoise pill wired through
// openExternalLinkSafely(); falsy -> the exact same position/geometry,
// restyled as a dark translucent "בקרוב" pill with a small lock icon -
// never hidden, never a normal-looking button with no real action.
//
// STAGE 27.1: this remains the exact same structure (visual badge + text
// column + CTA), still the only caller of this component (the redemption
// card) - only made visually richer/more dominant per this stage's explicit
// request, not restructured or replaced. The base gradient/background is
// still the same [gradientDarkStart, gradientDarkEnd] pair every other dark
// card in this app uses (GoldenLightCard included) - `promoCardSheen`, an
// absolute-fill overlay using the existing colors.primaryGlow token at a
// gentle diagonal, is layered ON TOP of that same base for a "richer
// dark-teal" surface without swapping the app's established gradient.
function PromoCard({ visual, title, description, ctaLabel, url, style }) {
  const isActive = Boolean(url);

  return (
    <LinearGradient
      colors={[colors.gradientDarkStart, colors.gradientDarkEnd]}
      start={{ x: 0.1, y: 0 }}
      end={{ x: 0.9, y: 1 }}
      style={[styles.promoCard, style]}>
      <LinearGradient
        colors={[colors.primaryGlow, 'transparent']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.promoCardSheen}
        pointerEvents="none"
      />

      {visual}

      <View style={styles.promoContent}>
        {/* STAGE 27.2: numberOfLines={1} removed - on a real device, 21px
            title text + the 120x120 gift visual from Stage 27.1 left the
            text column too narrow for the full "מימוש נקודות למתנות" to
            fit on one line, so numberOfLines={1} was silently truncating it
            with an ellipsis. The text column is now wider (see promoCard/
            promoVisualGlow below) so the title fits on one line on
            standard/larger phones in practice, but no numberOfLines cap
            remains here at all - the title can never be cut off again,
            even on the narrowest supported width, where it wraps to a
            natural second line instead. */}
        <Text style={styles.promoTitle}>{title}</Text>
        <View style={styles.promoTitleAccent} />
        <Text style={styles.promoDescription} numberOfLines={2}>
          {description}
        </Text>

        <Pressable
          onPress={isActive ? () => openExternalLinkSafely(url) : undefined}
          disabled={!isActive}
          accessibilityRole="button"
          accessibilityLabel={isActive ? ctaLabel : `${ctaLabel} - בקרוב`}
          accessibilityState={{ disabled: !isActive }}
          style={({ pressed }) => [
            styles.promoCta,
            !isActive && styles.promoCtaDisabled,
            pressed && isActive && styles.promoCtaPressed,
          ]}>
          {!isActive ? <Ionicons name="lock-closed-outline" size={14} color={colors.mutedOnDark} /> : null}
          <Text style={[styles.promoCtaText, !isActive && styles.promoCtaTextDisabled]} numberOfLines={1}>
            {isActive ? ctaLabel : 'בקרוב'}
          </Text>
          {isActive ? <Ionicons name="chevron-back" size={14} color={colors.black} /> : null}
        </Pressable>
      </View>
    </LinearGradient>
  );
}

// STAGE 18.6: the Golden Light promotional card - a richer, vertically-
// composed "mini landing page" card (logo -> title -> description -> CTA),
// distinct in kind from the compact horizontal gift banner above it. Lives
// on the NEW light section (see RewardsScreen's own lightSection below),
// so it stays a dark, near-black card for intentional contrast against
// that light background - no white border, the light background itself is
// the separation. The real logo asset is shown at a natural, readable
// size (not shrunk into a small icon tile - see this stage's own Part F).
// GOLDEN_LIGHT_WEBSITE_URL is the real, approved production URL (set in
// Stage 18.5's own follow-up) - read from constants/externalLinks.js, never
// duplicated/hardcoded here, and opened only through the same
// openExternalLinkSafely() every other external link in this app uses.
function GoldenLightCard() {
  return (
    <LinearGradient
      colors={[colors.gradientDarkStart, colors.gradientDarkEnd]}
      start={{ x: 0.1, y: 0 }}
      end={{ x: 0.9, y: 1 }}
      style={styles.glCard}>
      <Image
        source={require('../assets/images/golden-light-logo-white.png')}
        style={styles.glLogo}
        resizeMode="contain"
      />
      <Text style={styles.glTitle}>מוצרי גולדן לייט</Text>
      <Text style={styles.glDescription}>{'מגוון פתרונות תאורה איכותיים\nלכל מטרה ולכל פרויקט'}</Text>

      <Pressable
        onPress={() => openExternalLinkSafely(GOLDEN_LIGHT_WEBSITE_URL)}
        accessibilityRole="button"
        accessibilityLabel="לעבור לאתר גולדן לייט"
        style={({ pressed }) => [styles.glCta, pressed && styles.glCtaPressed]}>
        <Text style={styles.glCtaText}>לעבור לאתר גולדן לייט</Text>
        <Ionicons name="chevron-back" size={16} color={colors.black} />
      </Pressable>
    </LinearGradient>
  );
}

export default function RewardsScreen() {
  const { user, profileVersion } = useAuth();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // STAGE 15.3: see HomeScreen.js's own hasLoadedProfileRef for the full
  // explanation - distinguishes the true first load (full-screen spinner)
  // from a background refresh-on-focus (last-good points stay visible).
  const hasLoadedProfileRef = useRef(false);

  // STAGE 9: useFocusEffect, not a plain mount-only useEffect - see the
  // identical reasoning on HomeScreen's own profile load. A customer
  // returning to this tab after a receipt is approved elsewhere must see
  // their real points_balance, not a stale value from first mount. The
  // backend profile/ledger remains authoritative - this only re-fetches it.
  useFocusEffect(
    useCallback(() => {
      let isActive = true;

      async function loadProfile() {
        if (!user?.id) {
          hasLoadedProfileRef.current = false;
          setProfile(null);
          setLoading(false);
          setError('');
          return;
        }

        // STAGE 15.3: only the true first load blocks with the spinner - a
        // background refresh-on-focus keeps the last-good points balance
        // visible the whole time instead of flashing to a spinner on every
        // tab revisit.
        const isInitialLoad = !hasLoadedProfileRef.current;

        try {
          if (isInitialLoad) {
            setLoading(true);
          }
          setError('');
          const data = await getProfile(user.id);

          if (isActive) {
            setProfile(data);
            hasLoadedProfileRef.current = true;
          }
        } catch (err) {
          if (isActive && isInitialLoad) {
            setProfile(null);
            setError('לא הצלחנו לטעון את יתרת הנקודות');
          }
        } finally {
          if (isActive) {
            setLoading(false);
          }
        }
      }

      loadProfile();

      return () => {
        isActive = false;
      };
    // STAGE 26: see HomeScreen.js's identical comment - profileVersion is a
    // "please re-fetch now" signal bumped by AuthContext only when the
    // birthday-bonus RPC actually awards points, not a second data source.
    }, [user?.id, profileVersion]),
  );

  const pointsBalance = profile?.points_balance ?? 0;

  // Same real, database-authoritative G Level computation as HomeScreen's
  // own identical block (see that file) - membership_level and
  // approved_purchases_count are already part of getProfile()'s existing
  // PROFILE_COLUMNS select, so this is real live data already being
  // fetched by this screen, not a new query or invented value. Kept in
  // sync with HomeScreen's logic rather than importing from it, since
  // neither screen shares component state - both independently derive the
  // same result from the same real profile fields via the shared
  // getMembershipLevelInfo() helper.
  const membershipLevel = String(profile?.membership_level || 'BRONZE').toUpperCase();
  const safeMembershipLevel = ['BRONZE', 'SILVER', 'GOLD', 'TITANIUM'].includes(membershipLevel)
    ? membershipLevel
    : 'BRONZE';
  const approvedPurchasesCount = profile?.approved_purchases_count ?? 0;
  const levelInfo = getMembershipLevelInfo(approvedPurchasesCount);
  const levelProgressLabel = levelInfo.nextLevel
    ? `${isolateLTR(`${levelInfo.progressInBracket} / ${levelInfo.bracketSize}`)} ל-${isolateLTR(levelInfo.nextLevel)}`
    : 'הגעתם לרמה הגבוהה ביותר';

  return (
    <View style={styles.root}>
      {/* Full-bleed dark background - see root's own matching flat
          backgroundColor below for why the page still reads as dark all
          the way down even where this fixed-to-viewport gradient doesn't
          reach (unchanged from Stage 18.5). Now only covers the DARK
          portion of the screen (header/points/gift card) - the light
          section below (see styles.lightSection) paints over it with its
          own background starting after the gift card. */}
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
        // tab bar (GoldenBottomTabBar, untouched by this stage), which
        // already provides its own clearance below the content via
        // lightSection's own paddingBottom (see below).
        edges={['top', 'left', 'right']}>
        {/* STAGE 18.6: dark content only - header, subtitle, live points/
            G-Level card, and the gift redemption card. Never wrapped in a
            light/white background. */}
        <View style={styles.pageInner}>
          <Text style={styles.title}>מתנות</Text>
          <Text style={styles.subtitle}>
            {`עקבו אחרי הנקודות שצברתם וגלו את עולם המתנות של ${isolateLTR('GOLDEN+')}`}
          </Text>

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
                .then((data) => {
                  setProfile(data);
                  setError('');
                })
                .catch(() => setError('לא הצלחנו לטעון את יתרת הנקודות'))
            }
            style={styles.pointsCard}
          />

          <PromoCard
            visual={
              <View style={styles.promoVisualGlow}>
                <Ionicons name="gift" size={48} color={colors.primary} />
              </View>
            }
            title="מימוש נקודות למתנות"
            description={'בחרו מתנות והטבות שוות\nוממשו את הנקודות שצברתם'}
            ctaLabel="לעבור לאתר המתנות"
            url={POINTS_REDEMPTION_URL}
            style={styles.giftCard}
          />
        </View>

        {/* STAGE 18.6: NEW light section - only the Golden Light card lives
            here, never the gift card. A warm, light near-off-white surface
            (colors.cardLight - the same token already reserved for "a
            light surface sitting on a dark hero gradient", see that
            token's own definition in theme/colors.js) with rounded TOP
            corners only, so it reads as a deliberate page section
            transitioning out of the dark GOLDEN+ area above it - not
            another card, and not the old giant white wrapper (which used
            to hold BOTH promo cards and the app's plain colors.background
            token). The dark GoldenLightCard sitting on top of it is the
            only content here - contrast comes from that color pairing,
            never from a white border around the card itself. */}
        <View style={styles.lightSection}>
          <GoldenLightCard />
        </View>
      </AppScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    // Matches heroGradient's own END color (colors.charcoal) - see that
    // element's comment above for why this specific color, not
    // colors.background (the app's default light surface every other
    // screen's `root` correctly still uses).
    backgroundColor: colors.charcoal,
  },
  heroGradient: {
    ...StyleSheet.absoluteFillObject,
  },
  // Same cancel-AppScreen's-own-wrapper technique as HomeScreen/
  // ProfileScreen/PurchaseScreen (see HomeScreen's screenInner comment for
  // the full flex-chain explanation).
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
  pageInner: {
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    alignItems: 'flex-end',
  },
  // STAGE 27: overridden locally (not via the shared typography.title token,
  // which many other screens' headers still use unchanged) - fontSize 20 ->
  // 24 (+4, within the requested 3-5px range), fontWeight 600 -> 800, plus a
  // small marginBottom so the title area reads as more clearly separated/
  // dominant above the subtitle, immediately signaling "this is the rewards
  // page" the moment it's opened.
  title: {
    fontSize: 24,
    fontWeight: '800',
    color: colors.textOnDark,
    textAlign: 'right',
    marginBottom: 2,
  },
  subtitle: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.mutedOnDark,
    textAlign: 'right',
    marginTop: spacing.xs,
    lineHeight: 18,
  },
  // STAGE 18.6, Part J ("header -> points card: current spacing or
  // slightly tighter"): reduced from spacing.xl (20) to spacing.lg (16) -
  // the points card itself is unchanged (still the shared, approved
  // PointsBalanceCard component, not touched), only its distance from the
  // header above it was tightened slightly to give the rest of the screen
  // a little more visual room, per this stage's own explicit ask.
  pointsCard: {
    width: '100%',
    marginTop: spacing.lg,
  },
  // STAGE 27.1 pushed this to spacing.xxxl (32) for "stronger visual
  // separation from the points card above" - on a real device that read as
  // too much empty space between the two dark cards. STAGE 27.2: reduced to
  // a local 18px (no existing spacing token lands there - spacing.lg is 16,
  // spacing.xl is 20; 18 was the explicitly requested target, so a small
  // local value is used rather than rounding to either neighbor) - enough
  // for clear separation without the cards feeling disconnected.
  giftCard: {
    marginTop: 18,
  },
  // Compact horizontal "promo banner" card - a fixed-size visual badge plus
  // a flexible text column, so total height is driven by content (title +
  // 2-line description + a compact, non-stretched CTA), never a large
  // fixed panel. Plain `flexDirection: 'row'` (not 'row-reverse') with the
  // visual as the FIRST child is what puts the visual on the physical LEFT
  // and the text column on the physical RIGHT, explicitly - not left to
  // I18nManager/RTL auto-reversal.
  //
  // STAGE 27.1: this is now the visual hero of the Rewards page (the
  // "what I can do with my points" card, vs. PointsBalanceCard's "what I
  // have" above it - PointsBalanceCard itself untouched). borderColor
  // strengthened from the faint charcoalBorder tint to solid colors.primary
  // at a touch more width, the glow pushed a little further than
  // shadows.glow's base values, and paddingVertical increased - still the
  // exact same card shape/position/content, not a redesign. overflow:
  // 'hidden' clips promoCardSheen (added below) to this card's own rounded
  // corners.
  // STAGE 27.2: paddingHorizontal spacing.xl (20) -> spacing.lg (16) and gap
  // spacing.md (12) -> spacing.sm (8) - freed horizontal room for the text
  // column (root cause of the title clipping, together with
  // promoVisualGlow's width - see that style below), without touching
  // paddingVertical/border/glow, which stay exactly as Stage 27.1 approved.
  promoCard: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.xl,
    borderWidth: 1.5,
    borderColor: colors.primary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xxl,
    gap: spacing.sm,
    overflow: 'hidden',
    shadowColor: colors.primary,
    shadowOpacity: 0.38,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 10 },
    elevation: 10,
  },
  // STAGE 27.1: a very subtle diagonal turquoise overlay (colors.primaryGlow
  // - already the app's own "turquoise glow, pre-mixed with alpha" token -
  // fading to fully transparent), layered on top of promoCard's base
  // [gradientDarkStart, gradientDarkEnd] gradient for a "richer dark-teal"
  // surface. Absolute-fill, non-interactive, drawn behind the visual/text
  // content (first child) so it never affects touch targets or contrast.
  promoCardSheen: {
    ...StyleSheet.absoluteFillObject,
  },
  // STAGE 18.6 Part B: bumped from 72x72 (Stage 18.5) to 80x80.
  // STAGE 27.1: bumped again, 80x80 -> 120x120 - "the gift visual should be
  // substantially more dominant" - with a soft-turquoise translucent fill
  // (an rgba built from the exact same RGB triplet as colors.primary/
  // colors.primaryGlow, just a different alpha - not a new color) in place
  // of the previous plain white-tinted glassFill, and a stronger glow to
  // match. Still the same real Ionicons "gift" glyph (no new icon, no
  // image asset), still well short of the text column's own natural
  // height (title + accent + 2-line description + CTA).
  // STAGE 27.2: 120x120 -> 108x108 (icon 52 -> 48 at the call site) - on a
  // real device, 120px left too little width for the 21px title text next
  // to it (the actual cause of the clipping, together with promoCard's own
  // padding/gap above). Still substantially larger than Stage 27's 80x80 -
  // not a rollback, just enough narrower to guarantee the full title fits.
  promoVisualGlow: {
    width: 108,
    height: 108,
    flexShrink: 0,
    borderRadius: radius.lg,
    backgroundColor: 'rgba(46, 196, 199, 0.14)',
    borderWidth: 1.5,
    borderColor: colors.primaryGlow,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.primary,
    shadowOpacity: 0.5,
    shadowRadius: 26,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
  promoContent: {
    flex: 1,
    minWidth: 0,
  },
  // STAGE 27.1: fontSize 16 -> 21, fontWeight 700 -> 800 - "the most
  // important text on the card," clearly stronger than before.
  // STAGE 27.2: explicit lineHeight added (was relying on the platform
  // default) and the render's own numberOfLines={1} was removed entirely -
  // on the narrowest supported widths the full title now wraps to a
  // natural, comfortably-spaced second line instead of ever being cut off
  // with an ellipsis.
  promoTitle: {
    fontSize: 21,
    lineHeight: 26,
    fontWeight: '800',
    color: colors.textOnDark,
    textAlign: 'right',
  },
  // STAGE 27.1: a short turquoise accent line under the title, the same
  // restrained "accent language" already used elsewhere in the app (e.g.
  // PointsBalanceCard's own accentLine) - reproduced locally here rather
  // than importing/touching that component.
  promoTitleAccent: {
    width: 28,
    height: 2,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
    opacity: 0.8,
    marginTop: 6,
    alignSelf: 'flex-end',
  },
  // STAGE 27.1: fontSize 12 -> 15, lineHeight 16 -> 20 - "improve
  // readability slightly" - still 2 lines (numberOfLines={2} at the call
  // site, unchanged), still the same copy.
  promoDescription: {
    marginTop: spacing.sm,
    fontSize: 15,
    lineHeight: 20,
    color: colors.mutedOnDark,
    textAlign: 'right',
  },
  // Deliberately NOT `alignSelf: 'stretch'` - a compact, content-sized pill
  // hugging the column's own end (right, matching RTL reading direction),
  // never an almost-full-width bar.
  // STAGE 27.1: minHeight 38 -> 44, paddingHorizontal spacing.md -> spacing.lg
  // - a wider, more legible pill for both the active and "בקרוב" states.
  promoCta: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    alignSelf: 'flex-end',
    gap: spacing.xs,
    marginTop: spacing.md,
    minHeight: 44,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.lg,
    ...shadows.buttonGlow,
  },
  promoCtaPressed: {
    backgroundColor: colors.primaryPressed,
  },
  // Dark translucent pill (the same "glass" token as promoVisualGlow, not a
  // solid opaque fill) - reads unmistakably as inactive next to the active
  // card's solid turquoise CTA, never mistakeable for a live button.
  // STAGE 27.1: border strengthened from charcoalBorder (0.18 alpha) to
  // primaryGlow (0.35 alpha, same existing token) and the fill given a
  // faint turquoise tint instead of plain white-tinted glassFill - "subtle
  // turquoise surface/border" for a more intentional, premium "coming soon"
  // capsule - while staying translucent/unfilled (never colors.primary
  // solid) so it still reads unmistakably as disabled next to the active
  // state's solid turquoise pill.
  promoCtaDisabled: {
    backgroundColor: 'rgba(46, 196, 199, 0.08)',
    borderWidth: 1,
    borderColor: colors.primaryGlow,
    shadowOpacity: 0,
    elevation: 0,
  },
  // STAGE 27.1: fontSize 13 -> 14 - "בקרוב" easier to read inside the now-
  // wider pill (see promoCta above).
  promoCtaText: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.black,
    textAlign: 'center',
  },
  promoCtaTextDisabled: {
    color: colors.mutedOnDark,
  },
  // STAGE 18.6, Part C: the new light section - colors.cardLight is a
  // warm light-gray (not pure white) already reserved in theme/colors.js
  // specifically for "a light surface sitting on a dark hero gradient"
  // (its own original use: the auth form card on AuthScreenShell's dark
  // hero) - the exact same visual scenario as this section transitioning
  // out of the dark GOLDEN+ area above it, so reusing it here is a
  // deliberate, purpose-matched choice rather than introducing a new
  // color. Rounded TOP corners only (radius.xl = 28, the same token the
  // old hero/sheet seam used) - width/maxWidth/alignSelf mirror pageInner
  // exactly so both read as the same column width on every device.
  // paddingBottom is the real bottom clearance above GoldenBottomTabBar
  // (untouched by this stage) - generous enough that the card is never
  // hidden behind it, without any further empty space beyond that.
  lightSection: {
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    backgroundColor: colors.cardLight,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    marginTop: spacing.xxl,
    paddingHorizontal: spacing.lg,
    paddingTop: 28,
    paddingBottom: spacing.giant,
  },
  // STAGE 18.6, Part D/E/F: the Golden Light "mini landing page" card - a
  // vertically-composed dark card (distinct in kind from the gift card's
  // compact horizontal banner), sitting directly on the light section
  // above with no white border of its own - the light background is the
  // only separation, per this stage's explicit instruction.
  // STAGE 27: modestly more compact overall (~10-12% less vertical height)
  // - paddingVertical trimmed, the logo/gaps below tightened too. Same
  // width, same border/shadow/dark-card treatment, same content - nothing
  // removed.
  glCard: {
    width: '100%',
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.charcoalBorder,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xl,
    alignItems: 'center',
    ...shadows.glow,
  },
  // STAGE 27: 156x78 -> 132x66 - still the same 2:1 source aspect ratio
  // (never stretched/cropped) and comfortably legible, just slightly less
  // dominant vertically as part of this card's overall trim.
  glLogo: {
    width: 132,
    height: 66,
    marginBottom: spacing.sm,
  },
  glTitle: {
    fontSize: typography.heading.fontSize,
    lineHeight: typography.heading.lineHeight,
    fontWeight: typography.heading.fontWeight,
    color: colors.textOnDark,
    textAlign: 'center',
  },
  glDescription: {
    marginTop: spacing.xs,
    fontSize: typography.body.fontSize,
    lineHeight: typography.body.lineHeight,
    color: colors.mutedOnDark,
    textAlign: 'center',
    maxWidth: 300,
  },
  // Content-sized pill (no explicit width) - "not unnecessarily full-
  // width," centered by the card's own alignItems: 'center'. minHeight kept
  // at 44 (a comfortable tap target) even after this stage's trim - only
  // its marginTop was tightened.
  glCta: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    marginTop: spacing.lg,
    minHeight: 44,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.xl,
    ...shadows.buttonGlow,
  },
  glCtaPressed: {
    backgroundColor: colors.primaryPressed,
  },
  glCtaText: {
    fontSize: typography.button.fontSize,
    fontWeight: '700',
    color: colors.black,
    textAlign: 'center',
  },
});