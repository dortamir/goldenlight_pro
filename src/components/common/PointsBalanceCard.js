import { LinearGradient } from 'expo-linear-gradient';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, shadows, spacing, typography } from '../../theme';

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
  label = 'יתרת הנקודות שלך',
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
                <Text style={[styles.tierBadge, { color: tierColor }]}>{`G Level · ${tierKey}`}</Text>
                <Text style={styles.tierMeta}>{progressLabel}</Text>
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
  card: {
    borderRadius: radius.xl,
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.xxl,
    borderWidth: 1,
    borderColor: colors.charcoalBorder,
    ...shadows.glow,
  },
  label: {
    ...typography.caption,
    fontWeight: '600',
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
  pointsRow: {
    flexDirection: 'row-reverse',
    alignItems: 'baseline',
    marginTop: spacing.lg,
    gap: spacing.xs,
  },
  // Base size comes from the theme's single "hero" token - adjustsFontSizeToFit
  // + minimumFontScale let a very large balance shrink proportionally
  // (down to 55% of typography.hero.fontSize) instead of wrapping or
  // clipping, without introducing a second hardcoded pixel size anywhere.
  pointsValue: {
    ...typography.hero,
    color: colors.primary,
    textAlign: 'right',
    flexShrink: 1,
    textShadowColor: colors.primaryGlow,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 16,
  },
  pointsUnit: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.textOnDark,
    lineHeight: 22,
    marginBottom: 1,
    flexShrink: 0,
  },
  meta: {
    marginTop: spacing.sm,
    ...typography.caption,
    fontWeight: '500',
    color: colors.mutedOnDark,
    textAlign: 'right',
  },
  tierRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
    paddingTop: spacing.xs,
  },
  tierBadge: {
    ...typography.micro,
  },
  tierMeta: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.mutedOnDark,
    textAlign: 'right',
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
