import { Image, StyleSheet, Text, View } from 'react-native';

import { colors, radius, shadows, spacing, typography } from '../../theme';
import AppBackButton from './AppBackButton';
import AppCard from './AppCard';
import AppScreen from './AppScreen';
import AuthLogoGlow from './AuthLogoGlow';
import AuthSegmentedControl from './AuthSegmentedControl';

// Shared visual frame for the Login/Register screens: a compact logo +
// heading floating on the dark background, and the actual form on a light
// card below. Owns layout/visuals ONLY - all auth state, validation, and
// submit handlers stay in whichever screen renders this, passed in as
// `children`.
//
// Deliberately does NOT render its own background gradient - that lives in
// app/(auth)/_layout.js instead, one level up, because THIS component is
// freshly mounted every time Login/Register swaps (Expo Router's web Stack
// briefly renders the incoming screen through a display:none phase during
// that swap). expo-linear-gradient's web output measures its own pixel size
// via onLayout to compute the gradient's CSS angle; a fresh LinearGradient
// mounted mid-swap can have that measurement race the visibility toggle and
// permanently latch onto 0x0, which is what made the dark background
// disappear after navigating between the two screens. The layout-level
// gradient is a single instance that survives Login<->Register navigation
// untouched, so it only ever measures once, on a normal full mount.
export default function AuthScreenShell({
  title,
  subtitle,
  activeTab,
  onRegisterPress,
  onLoginPress,
  // Both opt-in and fully backward-compatible: every existing caller
  // (Login/Register) leaves these unset, which keeps their current
  // rendering byte-for-byte identical. A secondary auth action (e.g.
  // ForgotPasswordScreen) that isn't part of the login/register toggle can
  // set showTabs={false} to omit AuthSegmentedControl entirely, and pass
  // backFallbackRoute to render a back button (reusing AppBackButton's own
  // canGoBack()-then-fallback behavior, not new navigation logic) in the
  // same top-right position every other secondary screen uses.
  showTabs = true,
  backFallbackRoute,
  children,
}) {
  return (
    <View style={styles.root}>
      <AppScreen backgroundColor="transparent">
        <View style={styles.screenContent}>
          {backFallbackRoute ? (
            <AppBackButton
              fallbackRoute={backFallbackRoute}
              color={colors.mutedOnDark}
              style={styles.backButton}
            />
          ) : null}

          <View style={styles.heroSection}>
            {/* Single true radial-gradient glow (see AuthLogoGlow) - one
                continuous falloff, not stacked flat-opacity rings. */}
            <AuthLogoGlow />

            {/* Real white logo asset (golden-light-logo-white.png) - same
                aspect ratio, never cropped/stretched. Sits directly on the
                dark gradient with no border/background/shadow of its own -
                only the glow behind it marks its position. */}
            <View style={styles.logoWrap}>
              <Image
                source={require('../../assets/images/golden-light-logo-white.png')}
                style={styles.logo}
                resizeMode="contain"
              />
            </View>
            <Text style={styles.title}>{title}</Text>
            {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}

            {showTabs ? (
              <AuthSegmentedControl
                activeTab={activeTab}
                onRegisterPress={onRegisterPress}
                onLoginPress={onLoginPress}
              />
            ) : null}
          </View>

          <AppCard style={styles.card}>
            <View style={styles.formSection}>{children}</View>
          </AppCard>
        </View>
      </AppScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  screenContent: {
    flex: 1,
    width: '100%',
    justifyContent: 'center',
    position: 'relative',
  },
  // Top-right, same position every other secondary screen's back button
  // uses - only rendered when backFallbackRoute is passed in (see above).
  backButton: {
    position: 'absolute',
    top: 0,
    right: 0,
    zIndex: 1,
  },
  heroSection: {
    alignItems: 'center',
    marginBottom: spacing.xl,
    paddingTop: spacing.md,
  },
  // No background/border/shadow - the logo sits freely on the gradient,
  // set off only by AuthLogoGlow behind it.
  logoWrap: {
    marginBottom: spacing.lg,
  },
  // Aspect ratio preserved exactly - never stretched/cropped.
  logo: {
    width: 220,
    height: 110,
  },
  title: {
    fontSize: typography.heading.fontSize,
    lineHeight: typography.heading.lineHeight,
    fontWeight: typography.heading.fontWeight,
    color: colors.textOnDark,
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  subtitle: {
    fontSize: typography.body.fontSize,
    lineHeight: typography.body.lineHeight,
    color: colors.mutedOnDark,
    textAlign: 'center',
    maxWidth: 280,
    marginBottom: spacing.lg,
  },
  // Warm light-gray card (colors.cardLight) - deliberately not white/not
  // black, floating on the dark gradient behind it.
  card: {
    width: '100%',
    maxWidth: 380,
    alignSelf: 'center',
    borderRadius: radius.xl,
    backgroundColor: colors.cardLight,
    ...shadows.softCard,
  },
  formSection: {
    width: '100%',
    alignItems: 'stretch',
  },
});
