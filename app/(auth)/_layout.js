import { LinearGradient } from 'expo-linear-gradient';
import { Redirect, Stack, usePathname } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { useAuth } from '../../src/context/AuthContext';
import { colors } from '../../src/theme';

export default function AuthLayout() {
  const { session, loading, passwordRecovery } = useAuth();
  const pathname = usePathname();
  const isResetPasswordRoute = Boolean(pathname && pathname.includes('reset-password'));

  if (loading) {
    // Same reasoning as app/index.js: a themed placeholder instead of
    // `null`, so there is never an unstyled blank/light flash before
    // LoginScreen/RegisterScreen (or the redirect below) render - the exact
    // gap that made the finalized auth design look broken on a first load
    // but fine after a refresh (faster hydration hides the same gap).
    return <View style={{ flex: 1, backgroundColor: colors.bgDark }} />;
  }

  // A password-recovery session is a real, authenticated Supabase session
  // (see AuthContext's deep-link handling), so without this check the
  // ordinary "already signed in -> tabs" redirect below would immediately
  // bounce a recovering user away from reset-password before they could set
  // a new password. If they somehow land on a different auth screen while
  // recovering (e.g. login), send them to reset-password instead of tabs -
  // never leave a recovery session sitting on login/register.
  if (session && passwordRecovery && !isResetPasswordRoute) {
    return <Redirect href="/(auth)/reset-password" />;
  }

  if (session && !passwordRecovery) {
    return <Redirect href="/(tabs)" />;
  }

  // Login/Register's dark gradient background lives here, not inside
  // AuthScreenShell (see that file for the full explanation) - this layout
  // component is never remounted while navigating between sibling routes in
  // the same Stack, so a gradient rendered here mounts once and never
  // re-measures, avoiding the onLayout race that made it disappear after
  // switching between Login and Register. Scoped to exactly those two
  // routes so forgot-password/reset-password keep their own unrelated
  // (light) background untouched.
  const showAuthBackground = pathname === '/login' || pathname === '/register';

  return (
    <View style={styles.root}>
      {showAuthBackground ? (
        <LinearGradient
          colors={[colors.gradientDarkStart, colors.gradientDarkEnd]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      {/* Transparent so this gradient shows through - see the
          transparentBackgroundTheme override in app/_layout.js, which is
          what actually makes React Navigation's per-screen Background
          transparent (Stack's own contentStyle/cardStyle options do not
          control it). */}
      <Stack screenOptions={{ headerShown: false }} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
