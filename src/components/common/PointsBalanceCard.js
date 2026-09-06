import { LinearGradient } from 'expo-linear-gradient';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, shadows, spacing, typography } from '../../theme';
import { isolateLTR } from '../../utils/bidiText';

// Loyalty tier -> accent color. Only real, currently-reachable tiers
// (membership_level is validated/defaulted by the caller - see HomeScreen's
// safeMembershipLevel) map to a color; anything else simply hides the tier
// row rather than guessing. TITANIUM is the current maximum G Level - see
// src/constants/membershipLevels.js.
const TIER_COLORS = {
  BRONZE: colors.tierBronze,
  SILVER: colors.tierSilver,
  GOLD: colors.tierGold,
  TITANIUM: colors.tierTitanium,
};

function formatPoints(value) {
  const numericValue = Number.isFinite(value) ? value : 0;
  return numericValue.toLocaleString('he-IL');
}

// Shared dark "hero" card for the real points balance - used by both
// HomeScreen and RewardsScreen so the two never drift apart visually. Pure
// presentation: every number/label/loading/error state is driven entirely
// by props, nothing here fetches data or fabricates a value.
//
// Props:
//   label            - small caption above the number (both current
//                       screens use the same Hebrew text; overridable).
//   pointsBalance     - real profile.points_balance. Formatted, never
//                       invented.
//   meta              - optional secondary line under the number (each
//                       screen supplies its own - "benefits coming soon"
//                       on Home vs. "available to redeem" on Rewards).
//   membershipLevel   - optional real profile.membership_level (G Level).
//                       When omitted (or unrecognized), the tier row/
//                       progress bar are not rendered at all - no default
//                       is invented here.
//   progressPercent   - optional 0-100 fill for the tier-progress bar.
//                       The caller computes this from the real
//                       approved_purchases_count (see
//                       src/constants/membershipLevels.js's
//                       getMembershipLevelInfo) - clamped defensively here,
//                       never computed in this component.
//   progressLabel     - optional text under the tier badge describing real
//                       progress toward the next G Level (e.g.
//                       "3 / 12 ל-GOLD"), or a maxed-out message when
//                       already at the top level. Falls back to a generic
//                       label when not provided.
//   loading / error   - real loading/error state from the caller's own
//                       profile fetch.
//   onRetry           - retry handler; the retry row is omitted entirely
//                       if not provided.
//   style             - optional outer style override (e.g. margin).
export default function PointsBalanceCard({
  // STAGE 26.3: "נקודות שנצברו" ("points accumulated") - the customer-facing
  // balance label, changed from "יתרת הנקודות שלך" here in the one shared
  // component both HomeScreen and RewardsScreen render, rather than as a
  // per-screen override (neither currently passes its own `label`, so both
  // pick this up automatically).
  label = 'נקודות שנצברו',
  pointsBalance = 0,
  meta,
  membershipLevel,
  progressPercent = 0,
  progressLabel = 'רמת החברות מעודכנת מהמערכת',
  loading = false,
  error = '',
  onRetry,
  style,
}) {
  const tierKey =
    membershipLevel && TIER_COLORS[String(membershipLevel).toUpperCase()]
      ? String(membershipLevel).toUpperCase()
      : null;
  const tierColor = tierKey ? TIER_COLORS[tierKey] : colors.primary;
  const clampedProgress = Math.max(0, Math.min(100, Number.isFinite(progressPercent) ? progressPercent : 0));

  return (
    <LinearGradient
      colors={[colors.gradientDarkStart, colors.gradientDarkEnd]}
      start={{ x: 0.1, y: 0 }}
      end={{ x: 0.9, y: 1 }}
      style={[styles.card, style]}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.accentLine} />

      {loading ? (
        <View style={styles.loadingState}>
          <ActivityIndicator color={colors.primary} size="small" />
        </View>
      ) : error ? (
        <View style={styles.errorState}>
          <Text style={styles.errorText}>{error}</Text>
          {onRetry ? (
            <Pressable
              onPress={onRetry}
              accessibilityRole="button"
              accessibilityLabel="נסו שוב"
              style={styles.retryButton}
              hitSlop={8}>
              <Text style={styles.retryText}>נסו שוב</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <>
          <View style={styles.pointsRow}>
            <Text
              style={styles.pointsValue}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.55}>
              {formatPoints(pointsBalance)}
            </Text>
            <Text style={styles.pointsUnit}>נק׳</Text>
          </View>
          {meta ? <Text style={styles.meta}>{meta}</Text> : null}

          {tierKey ? (
            <>
              <View style={styles.tierRow}>
                {/* STAGE 26.3: "המעמד שלי" (Hebrew, RTL) replaces "G Level" -
                    only the English tier value itself is isolateLTR'd now,
                    not the whole string, matching src/utils/bidiText.js's
                    own "wrap ONLY the embedded LTR segment" convention -
                    wrapping the entire previous "G Level · SILVER" string
                    was correct only because that whole label was English. */}
                <Text style={[styles.tierBadge, { color: tierColor }]} numberOfLines={1}>
                  {`המעמד שלי · ${isolateLTR(tierKey)}`}
                </Text>
                <Text style={styles.tierMeta} numberOfLines={1}>
                  {progressLabel}
                </Text>
              </View>
              <View style={styles.progressTrack}>
                <View
                  style={[styles.progressFill, { width: `${clampedProgress}%`, backgroundColor: tierColor }]}
                />
              </View>
            </>
          ) : null}
        </>
      )}
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  // radius.xl (not .lg) deliberately - this is the app's one true "hero"
  // card, the case radius.xl exists for; regular cards elsewhere keep
  // radius.lg so the roundness hierarchy stays legible instead of
  // everything looking equally rounded.
  //
  // STAGE 25.2: paddingVertical restored to spacing.xxl (Stage 25.1 had
  // trimmed it to spacing.lg for a more compact card). Used by both
  // HomeScreen and RewardsScreen (the only two real callers - verified via
  // repo-wide search); both render this card as a normal in-flow block
  // with no fixed-height dependency on its own rendered size, so this
  // applies consistently to both.
  //
  // STAGE 25.5: Stage 25.4's further paddingVertical increase and minHeight
  // floor (an attempt to compensate for the removed meta row's lost space)
  // were reverted at the user's explicit request - back to exactly the
  // Stage 25.3 values below.
  card: {
    borderRadius: radius.xl,
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.xxl,
    borderWidth: 1,
    borderColor: colors.charcoalBorder,
    ...shadows.glow,
  },
  // STAGE 25.3: fontSize 13 -> 15, weight 600 -> 700 - stronger and easier
  // to read, still clearly secondary to pointsValue below (hierarchy:
  // pointsValue > label > tierBadge > tierMeta, per this stage's own
  // ordering).
  label: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '700',
    color: colors.mutedOnDark,
    textAlign: 'right',
  },
  accentLine: {
    width: 36,
    height: 2,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
    opacity: 0.7,
    marginTop: spacing.sm,
    alignSelf: 'flex-end',
  },
  loadingState: {
    minHeight: 140,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: spacing.md,
  },
  errorState: {
    minHeight: 140,
    justifyContent: 'center',
    alignItems: 'flex-end',
    paddingVertical: spacing.md,
    gap: spacing.xs,
  },
  errorText: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.error,
    textAlign: 'right',
  },
  // minHeight 44 - meets the minimum mobile touch-target size even though
  // the label text itself is small.
  retryButton: {
    minHeight: 44,
    justifyContent: 'center',
  },
  retryText: {
    ...typography.caption,
    fontWeight: '700',
    color: colors.primary,
    textAlign: 'right',
  },
  // STAGE 25.2: marginTop restored to spacing.lg (see `card` above).
  pointsRow: {
    flexDirection: 'row-reverse',
    alignItems: 'baseline',
    marginTop: spacing.lg,
    gap: spacing.xs,
  },
  // STAGE 25.1: fontSize/lineHeight raised from the theme's shared "hero"
  // token (52/56) to an explicit 60/66 - about a 15% increase, making this
  // the single most dominant element on the screen as requested. Overridden
  // directly here (not by changing typography.hero itself) so no other
  // consumer of that shared token is affected - this is the only screen
  // element using it. adjustsFontSizeToFit + minimumFontScale={0.55} (see
  // the render) still let a very large balance shrink proportionally
  // (down to ~33px) instead of wrapping or clipping.
  pointsValue: {
    ...typography.hero,
    fontSize: 60,
    lineHeight: 66,
    color: colors.primary,
    textAlign: 'right',
    flexShrink: 1,
    textShadowColor: colors.primaryGlow,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 16,
  },
  // STAGE 25.3: fontSize 20 -> 22, weight 600 -> 700 - stronger, staying
  // visually proportional to pointsValue beside it.
  pointsUnit: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.textOnDark,
    lineHeight: 26,
    marginBottom: 1,
    flexShrink: 0,
  },
  // STAGE 25.2: HomeScreen no longer passes a `meta` string ("מתנות יופיעו
  // בהמשך" was removed entirely, not replaced - see that screen's own
  // PointsBalanceCard call) and RewardsScreen never has. This style/the
  // conditional render above it stay in place only as a generic, optional
  // capability for a future caller that might supply one - unused by
  // either current real usage today, so no vertical space is reserved for
  // it in practice.
  meta: {
    marginTop: spacing.xs,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
    color: colors.mutedOnDark,
    textAlign: 'right',
  },
  // STAGE 25.2: marginTop/paddingTop restored to spacing.xl/spacing.xs (see
  // `card` above).
  // STAGE 25.3: explicit gap added - with tierBadge/tierMeta both now
  // meaningfully larger (Part 3), justifyContent: 'space-between' alone
  // only distributes LEFTOVER space between them - if their combined
  // shrunk width ever equals the row's full width on a narrow screen, they
  // would otherwise sit flush against each other with zero gap. This
  // guarantees a minimum visual separation regardless.
  // STAGE 25.5: Stage 25.4's further marginTop increase (spacing.xl ->
  // spacing.xxl) was reverted at the user's explicit request - back to
  // exactly the Stage 25.3 value below.
  tierRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
    paddingTop: spacing.xs,
    gap: spacing.sm,
  },
  // STAGE 25.3: fontSize 11 -> 14, weight 700 -> 800 - noticeably stronger/
  // more premium as requested, letterSpacing kept from typography.micro.
  // flexShrink + the render's own numberOfLines={1} keep this from
  // colliding with tierMeta (its tierRow sibling, laid out via
  // justifyContent: 'space-between') on narrow widths now that both are
  // meaningfully larger than before.
  tierBadge: {
    ...typography.micro,
    fontSize: 14,
    fontWeight: '800',
    flexShrink: 1,
  },
  // STAGE 25.3: fontSize 13 -> 14, weight 600 -> 700 - stronger, still
  // clearly secondary to pointsValue/label. flexShrink for the same
  // narrow-width safety as tierBadge above.
  tierMeta: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.mutedOnDark,
    textAlign: 'right',
    flexShrink: 1,
  },
  progressTrack: {
    height: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.bgDarkInset,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: radius.pill,
  },
});
