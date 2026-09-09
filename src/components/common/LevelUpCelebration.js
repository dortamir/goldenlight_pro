import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import PrimaryButton from './PrimaryButton';
import { getMembershipLevelRewardPer1000 } from '../../constants/membershipLevels';
import { colors, radius, spacing, typography } from '../../theme';
import { isolateLTR } from '../../utils/bidiText';

// STAGE 32: customer-facing GOLDEN+ level-up celebration - shown when the
// customer's OWN client learns (via purchase_reports.promoted_to_tier, set
// server-side by public.award_purchase_points() - see
// 031_membership_tier_rewards.sql) that a specific invoice just promoted
// them to a new membership tier. This component is purely presentational:
// it receives `tier` as a prop and never computes/guesses one itself, and
// it never decides WHETHER to show itself - the caller (currently
// PurchaseReportDetailsScreen) is solely responsible for that decision,
// based on the authoritative, server-stored, once-only
// promoted_to_tier/promotion_acknowledged_at state.
//
// No new dependency was added for this - confetti is built entirely from
// React Native's own core `Animated` API (already available everywhere,
// no reanimated/worklets required for a simple one-shot entrance effect
// like this), plain colored Views. See this stage's own final report for
// why a confetti package was not installed.
const TIER_COLORS = {
  BRONZE: colors.tierBronze,
  SILVER: colors.tierSilver,
  GOLD: colors.tierGold,
  PLATINUM: colors.tierPlatinum,
  DIAMOND: colors.tierDiamond,
};

const CONFETTI_COLORS = [colors.primary, colors.gold, colors.white, colors.tierSilver];
const CONFETTI_COUNT = 36;

function buildConfettiPieces(windowWidth) {
  return Array.from({ length: CONFETTI_COUNT }, (_, index) => ({
    key: index,
    left: Math.random() * windowWidth,
    color: CONFETTI_COLORS[index % CONFETTI_COLORS.length],
    size: 6 + Math.random() * 6,
    duration: 2200 + Math.random() * 1400,
    delay: Math.random() * 500,
    rotateStart: Math.random() * 360,
    rotateEnd: Math.random() * 720 - 360,
    drift: (Math.random() - 0.5) * 80,
  }));
}

function ConfettiPiece({ piece, fallDistance }) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: piece.duration,
      delay: piece.delay,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
    // Runs once per mount - this component is only ever mounted while the
    // celebration is visible (see the parent's conditional render), so a
    // fresh mount always means a fresh fall.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [0, fallDistance] });
  const translateX = progress.interpolate({ inputRange: [0, 1], outputRange: [0, piece.drift] });
  const rotate = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [`${piece.rotateStart}deg`, `${piece.rotateStart + piece.rotateEnd}deg`],
  });
  const opacity = progress.interpolate({ inputRange: [0, 0.85, 1], outputRange: [1, 1, 0] });

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.confettiPiece,
        {
          left: piece.left,
          width: piece.size,
          height: piece.size * 1.6,
          backgroundColor: piece.color,
          opacity,
          transform: [{ translateY }, { translateX }, { rotate }],
        },
      ]}
    />
  );
}

export default function LevelUpCelebration({ visible, tier, onDismiss }) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [reduceMotionEnabled, setReduceMotionEnabled] = useState(false);
  const contentOpacity = useRef(new Animated.Value(0)).current;
  const contentScale = useRef(new Animated.Value(0.85)).current;

  // Respect the platform's Reduce Motion setting where it's reasonably
  // available (AccessibilityInfo.isReduceMotionEnabled is a real, standard
  // React Native API on iOS/Android/web) - the celebration's CONTENT
  // (badge, title, reward text, dismiss button) always still appears
  // either way; only the confetti fall and the entrance scale/bounce are
  // skipped in favor of a plain, minimal fade when this is enabled.
  useEffect(() => {
    let isMounted = true;
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then((enabled) => {
        if (isMounted) {
          setReduceMotionEnabled(Boolean(enabled));
        }
      })
      .catch(() => {});
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!visible) {
      contentOpacity.setValue(0);
      contentScale.setValue(0.85);
      return;
    }

    if (reduceMotionEnabled) {
      Animated.timing(contentOpacity, { toValue: 1, duration: 250, useNativeDriver: true }).start();
      contentScale.setValue(1);
      return;
    }

    Animated.parallel([
      Animated.timing(contentOpacity, { toValue: 1, duration: 400, useNativeDriver: true }),
      Animated.spring(contentScale, { toValue: 1, friction: 6, tension: 50, useNativeDriver: true }),
    ]).start();
    // Re-runs each time the celebration becomes visible for a NEW
    // promotion (this component is remounted per-report by its caller, so
    // `visible` transitioning to true always means a fresh celebration).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, reduceMotionEnabled]);

  const confettiPieces = useMemo(
    () => (visible && !reduceMotionEnabled ? buildConfettiPieces(windowWidth) : []),
    [visible, reduceMotionEnabled, windowWidth],
  );

  const tierColor = TIER_COLORS[tier] || colors.primary;
  const rewardPer1000 = getMembershipLevelRewardPer1000(tier);

  if (!tier) {
    return null;
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDismiss}>
      <LinearGradient
        colors={[colors.gradientDarkStart, colors.gradientDarkEnd]}
        start={{ x: 0.1, y: 0 }}
        end={{ x: 0.9, y: 1 }}
        style={styles.root}>
        {confettiPieces.map((piece) => (
          <ConfettiPiece key={piece.key} piece={piece} fallDistance={windowHeight + 80} />
        ))}

        <Animated.View
          style={[
            styles.content,
            { opacity: contentOpacity, transform: [{ scale: contentScale }] },
          ]}>
          <View style={[styles.tierBadge, { borderColor: tierColor, shadowColor: tierColor }]}>
            <LinearGradient
              colors={['rgba(255, 255, 255, 0.14)', 'rgba(255, 255, 255, 0)']}
              start={{ x: 0.5, y: 0 }}
              end={{ x: 0.5, y: 1 }}
              style={styles.tierBadgeSheen}
              pointerEvents="none"
            />
            <Text style={[styles.tierBadgeText, { color: tierColor }]} numberOfLines={1}>
              {isolateLTR(tier)}
            </Text>
          </View>

          <Text style={styles.title}>{`עלית למעמד ${isolateLTR(tier)}`}</Text>

          {rewardPer1000 != null ? (
            <Text style={styles.subtitle}>
              {`מעכשיו כל ${isolateLTR('₪1,000')} מזכים אותך ב-${isolateLTR(`₪${rewardPer1000}`)}`}
            </Text>
          ) : null}

          <PrimaryButton title="איזה כיף" onPress={onDismiss} style={styles.dismissButton} />
        </Animated.View>

        {/* Full-area tap-to-dismiss, behind the content card - the button
            above remains the primary, explicit dismiss CTA. */}
        <Pressable
          style={StyleSheet.absoluteFillObject}
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel="סגירת חגיגת העלייה בדרגה"
        />
      </LinearGradient>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  confettiPiece: {
    position: 'absolute',
    top: -20,
    borderRadius: 2,
  },
  content: {
    width: '100%',
    maxWidth: 360,
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    gap: spacing.md,
  },
  tierBadge: {
    minWidth: 160,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    backgroundColor: colors.glassFill,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    shadowOpacity: 0.45,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
  tierBadgeSheen: {
    ...StyleSheet.absoluteFillObject,
  },
  tierBadgeText: {
    ...typography.hero,
    fontSize: 30,
    lineHeight: 36,
    fontWeight: '800',
    textAlign: 'center',
  },
  title: {
    fontSize: 24,
    lineHeight: 30,
    fontWeight: '800',
    color: colors.textOnDark,
    textAlign: 'center',
  },
  subtitle: {
    ...typography.body,
    color: colors.mutedOnDark,
    textAlign: 'center',
  },
  dismissButton: {
    width: '100%',
    marginTop: spacing.lg,
  },
});
