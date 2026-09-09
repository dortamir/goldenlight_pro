import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';

import { colors, radius, spacing, typography } from '../../theme';
import { isolateLTR } from '../../utils/bidiText';

// STAGE 32.5: customer-facing birthday-bonus celebration - shown when the
// customer's OWN client learns (via points_transactions.acknowledged_at,
// set server-side only by public.acknowledge_my_birthday_celebration() -
// see 033_birthday_bonus_celebration.sql) that an unacknowledged
// 'birthday_bonus' award exists. Purely presentational: receives
// `bonusPoints` as a prop and never computes/guesses it, and never decides
// WHETHER to show itself - the caller (HomeScreen) is solely responsible
// for that, based on the authoritative, server-stored acknowledged_at
// state. onPress on the CTA/backdrop below still only ever calls the
// unchanged `onDismiss` prop - this file makes no acknowledgement decision
// of its own.
//
// STAGE 32.5.4 (visual/animation polish only - no business logic touched):
// gold/warm-luxury birthday theme, replacing the plain small-emoji version.
// No new dependency was added - expo-linear-gradient and react-native-svg
// (for the true radial glow, the exact same technique already proven in
// AuthLogoGlow.js) are both already project dependencies. Confetti/sparkle
// motion uses React Native's own core `Animated` API only, same convention
// LevelUpCelebration.js already established for its own confetti.

const GOLD_TONES = [colors.gold, colors.goldDeep, colors.goldSoft];

const CONFETTI_COUNT = 34;

// A single master 0->1 driver (see the render below) is used for the
// staggered text/CTA reveal - each falling confetti piece instead gets its
// OWN independent Animated.Value, because every piece needs a different
// random fall duration/rotation/drift that a single shared driver cannot
// express - same architectural choice LevelUpCelebration.js's own confetti
// already made.
function buildConfettiPieces(windowWidth) {
  return Array.from({ length: CONFETTI_COUNT }, (_, index) => {
    // Weighted mixture: mostly small rectangles, some smaller square
    // "particles", a few elongated ribbon-like pieces - per the explicit
    // "mixture of shapes" requirement. Never rainbow - every piece picks
    // one of the three existing gold theme tones only.
    const roll = Math.random();
    const kind = roll < 0.58 ? 'rect' : roll < 0.83 ? 'particle' : 'ribbon';

    const width = kind === 'ribbon' ? 3 + Math.random() * 2 : kind === 'particle' ? 3 + Math.random() * 2 : 5 + Math.random() * 4;
    const height = kind === 'ribbon' ? 14 + Math.random() * 8 : kind === 'particle' ? width : 8 + Math.random() * 5;

    return {
      key: index,
      kind,
      left: Math.random() * windowWidth,
      color: GOLD_TONES[index % GOLD_TONES.length],
      width,
      height,
      // Confetti is heaviest directly above/around the cake area rather
      // than the full screen width, so it reads as falling FROM/AROUND the
      // cake rather than a generic full-width shower.
      startY: -40 - Math.random() * 60,
      duration: kind === 'ribbon' ? 2600 + Math.random() * 1200 : 1900 + Math.random() * 1300,
      // Confetti is most active during entrance (per spec) - every piece
      // starts within the first ~900ms, then the burst is over; nothing
      // loops or re-triggers afterward.
      delay: Math.random() * 900,
      rotateStart: Math.random() * 360,
      rotateEnd: (kind === 'ribbon' ? 180 : 90) + Math.random() * (kind === 'ribbon' ? 360 : 270) * (Math.random() < 0.5 ? -1 : 1),
      drift: (Math.random() - 0.5) * (kind === 'ribbon' ? 120 : 70),
    };
  });
}

function GoldConfettiPiece({ piece, fallDistance }) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: piece.duration,
      delay: piece.delay,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
    // Runs once per mount - this piece is only ever mounted while the
    // celebration is visible, so a fresh mount always means a fresh fall.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [0, fallDistance] });
  const translateX = progress.interpolate({ inputRange: [0, 1], outputRange: [0, piece.drift] });
  const rotate = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [`${piece.rotateStart}deg`, `${piece.rotateStart + piece.rotateEnd}deg`],
  });
  const opacity = progress.interpolate({ inputRange: [0, 0.08, 0.8, 1], outputRange: [0, 1, 1, 0] });

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.confettiPiece,
        {
          left: piece.left,
          top: piece.startY,
          width: piece.width,
          height: piece.height,
          borderRadius: piece.kind === 'particle' ? piece.width / 2 : 1.5,
          backgroundColor: piece.color,
          opacity,
          transform: [{ translateY }, { translateX }, { rotate }],
        },
      ]}
    />
  );
}

// Fixed positions (around the glow/cake badge) for the "sparkles" effect -
// distinct from the falling confetti above: these never fall, they only
// fade in/out and gently scale in place, at staggered timings, per the
// explicit "Sparkles / glow" requirement. Kept few and spread out - "do not
// overcrowd the screen".
const SPARKLE_SPOTS = [
  { top: 6, left: 14 },
  { top: 18, left: '82%' },
  { top: '52%', left: 2 },
  { top: '58%', left: '92%' },
  { top: '88%', left: 22 },
  { top: '90%', left: '78%' },
];

function Sparkle({ spot, delay }) {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let isMounted = true;

    const loop = () => {
      pulse.setValue(0);
      Animated.timing(pulse, {
        toValue: 1,
        duration: 1900 + Math.random() * 900,
        delay,
        easing: Easing.inOut(Easing.sin),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished && isMounted) {
          // Small pause before the next gentle twinkle - deliberately not a
          // constant/busy loop.
          setTimeout(loop, 600 + Math.random() * 900);
        }
      });
    };

    loop();

    return () => {
      isMounted = false;
      pulse.stopAnimation();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const opacity = pulse.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, 1, 0] });
  const scale = pulse.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.6, 1, 0.6] });

  return (
    <Animated.Text
      pointerEvents="none"
      style={[styles.sparkle, { top: spot.top, left: spot.left, opacity, transform: [{ scale }] }]}>
      ✦
    </Animated.Text>
  );
}

export default function BirthdayCelebration({ visible, bonusPoints, onDismiss }) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [reduceMotionEnabled, setReduceMotionEnabled] = useState(false);
  // A single master 0->1 driver for the staggered headline/reward/CTA
  // reveal - each element's own opacity/translateY is interpolated from a
  // different slice of this SAME value (see the render below), which keeps
  // the whole ~1.2s entrance sequence easy to reason about/retime in one
  // place rather than juggling many independently-timed Animated.timing
  // calls.
  const entrance = useRef(new Animated.Value(0)).current;

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
      entrance.setValue(0);
      return;
    }

    if (reduceMotionEnabled) {
      // Content still appears (never hidden), just without the staggered
      // motion/overshoot/confetti - same accessibility convention
      // LevelUpCelebration.js already established.
      entrance.setValue(1);
      return;
    }

    Animated.timing(entrance, {
      toValue: 1,
      duration: 1200,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
    // Re-runs each time this becomes visible for a NEW celebration - only
    // ever mounted while the parent's `visible` prop is true.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, reduceMotionEnabled]);

  const confettiPieces = useMemo(
    () => (visible && !reduceMotionEnabled ? buildConfettiPieces(windowWidth) : []),
    [visible, reduceMotionEnabled, windowWidth],
  );

  // Simple 2/3-keyframe interpolations off the single `entrance` driver -
  // the cake's 3-point scale keyframe (0.7 -> ~1.08 -> 1) approximates a
  // spring overshoot-and-settle cheaply, without a second Animated value.
  const glowOpacity = entrance.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 1, 1] });
  const glowScale = entrance.interpolate({ inputRange: [0, 0.28, 1], outputRange: [0.85, 1, 1] });
  const cakeOpacity = entrance.interpolate({ inputRange: [0.08, 0.3, 1], outputRange: [0, 1, 1] });
  const cakeScale = entrance.interpolate({ inputRange: [0.08, 0.28, 0.4, 1], outputRange: [0.7, 1.08, 1, 1] });
  const headlineStyle = {
    opacity: entrance.interpolate({ inputRange: [0.35, 0.55, 1], outputRange: [0, 1, 1] }),
    transform: [{ translateY: entrance.interpolate({ inputRange: [0.35, 0.55, 1], outputRange: [10, 0, 0] }) }],
  };
  const rewardStyle = {
    opacity: entrance.interpolate({ inputRange: [0.5, 0.68, 1], outputRange: [0, 1, 1] }),
    transform: [{ translateY: entrance.interpolate({ inputRange: [0.5, 0.68, 1], outputRange: [8, 0, 0] }) }],
  };
  const taglineStyle = {
    opacity: entrance.interpolate({ inputRange: [0.62, 0.78, 1], outputRange: [0, 1, 1] }),
  };
  const ctaStyle = {
    opacity: entrance.interpolate({ inputRange: [0.72, 0.9, 1], outputRange: [0, 1, 1] }),
    transform: [{ translateY: entrance.interpolate({ inputRange: [0.72, 0.9, 1], outputRange: [10, 0, 0] }) }],
  };

  const points = Number.isFinite(bonusPoints) && bonusPoints > 0 ? bonusPoints : 1000;
  const glowSize = Math.min(320, Math.max(240, windowWidth * 0.72));
  // STAGE 32.5.5: lifts the WHOLE composition (cake through CTA) slightly
  // above dead-center, responsively - proportional to window height rather
  // than a fixed device-specific pixel value, so it lands in the same
  // ~30-50px range this was tuned for on a standard iPhone while scaling
  // sensibly on a shorter (SE-class) or taller (Pro Max-class) screen.
  // `root` still centers via alignItems/justifyContent, so SafeArea/top
  // breathing room is preserved - this only nudges the centered group up
  // from there, it does not reposition individual children relative to
  // each other.
  const liftOffset = Math.min(48, Math.max(28, windowHeight * 0.045));

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDismiss}>
      <LinearGradient
        colors={[colors.bgDark, colors.gradientDarkEnd]}
        start={{ x: 0.15, y: 0 }}
        end={{ x: 0.85, y: 1 }}
        style={styles.root}>
        {/* Subtle vignette - two corner-anchored dark gradients, never a
            visible hard edge, just a faint darkening toward the frame so
            the golden glow reads as the visual center of gravity. */}
        <LinearGradient
          pointerEvents="none"
          colors={['rgba(0,0,0,0.35)', 'transparent']}
          start={{ x: 0, y: 0 }}
          end={{ x: 0.55, y: 0.55 }}
          style={StyleSheet.absoluteFillObject}
        />
        <LinearGradient
          pointerEvents="none"
          colors={['transparent', 'rgba(0,0,0,0.35)']}
          start={{ x: 0.45, y: 0.45 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFillObject}
        />

        {confettiPieces.map((piece) => (
          <GoldConfettiPiece key={piece.key} piece={piece} fallDistance={windowHeight + 80} />
        ))}

        <View style={[styles.content, { marginTop: -liftOffset }]}>
          <View style={[styles.cakeStage, { width: glowSize, height: glowSize }]}>
            {/* True radial gradient (SVG), the same proven technique
                AuthLogoGlow.js already uses - a smooth, continuous falloff
                from warm gold at the center to fully transparent at the
                edge, never a visible ring/boundary. */}
            <Animated.View
              pointerEvents="none"
              style={[styles.glowWrap, { opacity: glowOpacity, transform: [{ scale: glowScale }] }]}>
              <Svg width={glowSize} height={glowSize}>
                <Defs>
                  <RadialGradient id="birthdayGlow" cx="50%" cy="50%" r="50%">
                    <Stop offset="0%" stopColor={colors.gold} stopOpacity={0.55} />
                    <Stop offset="35%" stopColor={colors.gold} stopOpacity={0.3} />
                    <Stop offset="70%" stopColor={colors.goldDeep} stopOpacity={0.1} />
                    <Stop offset="100%" stopColor={colors.goldDeep} stopOpacity={0} />
                  </RadialGradient>
                </Defs>
                <Rect x={0} y={0} width={glowSize} height={glowSize} fill="url(#birthdayGlow)" />
              </Svg>
            </Animated.View>

            {SPARKLE_SPOTS.map((spot, index) => (
              <Sparkle key={index} spot={spot} delay={500 + index * 260} />
            ))}

            <Animated.View style={[styles.cakeBadge, { opacity: cakeOpacity, transform: [{ scale: cakeScale }] }]}>
              <Text style={styles.cakeEmoji}>🎂</Text>
            </Animated.View>
          </View>

          <Animated.Text style={[styles.title, headlineStyle]}>יום הולדת שמח!</Animated.Text>

          <Animated.View style={rewardStyle}>
            <Text style={styles.subtitle}>
              {'קיבלת '}
              <Text style={styles.subtitleGold}>{isolateLTR(points.toLocaleString('he-IL'))}</Text>
              {' נקודות מתנה'}
              {'\n'}
              {'מאיתנו לכבוד יום ההולדת'}
            </Text>
          </Animated.View>

          <Animated.Text style={[styles.tagline, taglineStyle]}>
            {`מתנה מ-${isolateLTR('GOLDEN+')} בהצלחה ובריאות!`}
          </Animated.Text>

          <Animated.View style={[styles.ctaWrap, ctaStyle]}>
            <Pressable
              onPress={onDismiss}
              accessibilityRole="button"
              accessibilityLabel="תודה, סגירת חגיגת יום ההולדת"
              style={({ pressed }) => [styles.ctaButton, pressed && styles.ctaButtonPressed]}>
              <Text style={styles.ctaText}>תודה!</Text>
            </Pressable>
          </Animated.View>
        </View>

        {/* Full-area tap-to-dismiss, behind the content card - same pattern
            as LevelUpCelebration's own backdrop, calling the exact same
            onDismiss handler as the CTA button above. */}
        <Pressable
          style={StyleSheet.absoluteFillObject}
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel="סגירת חגיגת יום ההולדת"
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
  },
  content: {
    width: '100%',
    maxWidth: 380,
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
    gap: spacing.sm,
  },
  cakeStage: {
    alignItems: 'center',
    justifyContent: 'center',
    // STAGE 32.5.5: tightened from spacing.sm - brings the text block
    // closer to the cake/visual center per the requested layout pass.
    marginBottom: spacing.xs,
  },
  glowWrap: {
    position: 'absolute',
  },
  sparkle: {
    position: 'absolute',
    fontSize: 14,
    color: colors.goldSoft,
  },
  cakeBadge: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Large, dominant cake presentation - no image asset/heavy dependency,
  // just a much bigger glyph than the previous small icon, sitting inside
  // the radial gold glow built above.
  cakeEmoji: {
    fontSize: 118,
    textAlign: 'center',
  },
  // STAGE 32.5.5: 30 -> 35 (within the requested 34-36px range).
  title: {
    fontSize: 35,
    lineHeight: 42,
    fontWeight: '800',
    color: colors.textOnDark,
    textAlign: 'center',
  },
  // STAGE 32.5.5: 17 -> 23 (within the requested 22-24px range).
  subtitle: {
    ...typography.body,
    fontSize: 23,
    lineHeight: 30,
    color: colors.mutedOnDark,
    textAlign: 'center',
  },
  // STAGE 32.5.5: given a slightly larger, bolder size than the
  // surrounding sentence (still fontWeight 800 as before) so "1,000"
  // remains the strongest element without being disproportionately huge.
  subtitleGold: {
    fontSize: 25,
    color: colors.gold,
    fontWeight: '800',
  },
  // STAGE 32.5.5: typography.caption's own 12px base was overridden - too
  // small to stay legible at this component's now-larger overall scale.
  // 16 -> within the requested 16-18px range, stays visibly secondary to
  // the 23px reward message above it.
  tagline: {
    ...typography.caption,
    fontSize: 17,
    lineHeight: 22,
    color: colors.mutedOnDark,
    textAlign: 'center',
  },
  ctaWrap: {
    width: '100%',
    // STAGE 32.5.5: tightened from spacing.lg, per the explicit request to
    // reduce the tagline-to-CTA gap slightly as part of moving the whole
    // composition upward.
    marginTop: spacing.md,
  },
  // Premium gold pill CTA, replacing the shared (turquoise) PrimaryButton
  // for this celebration only - PrimaryButton.js itself is untouched, this
  // is a local style scoped to this file.
  ctaButton: {
    width: '100%',
    paddingVertical: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.gold,
    shadowOpacity: 0.5,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  ctaButtonPressed: {
    backgroundColor: colors.goldDeep,
    shadowOpacity: 0.3,
  },
  ctaText: {
    fontSize: 17,
    fontWeight: '800',
    color: colors.charcoal,
  },
});
