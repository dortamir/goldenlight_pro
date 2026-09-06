import { LinearGradient } from 'expo-linear-gradient';
import { Redirect, Stack, usePathname } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { useAuth } from '../../src/context/AuthContext';
import { colors } from '../../src/theme';

export default function AuthLayout() {
  const { session, loading, isAdmin, adminLoading, passwordRecovery } = useAuth();
  const pathname = usePathname();
  const isResetPasswordRoute = Boolean(pathname && pathname.includes('reset-password'));

  // STAGE 17: also waits for adminLoading (once there's a real, non-recovery
  // session to route) before the "already signed in" redirect below fires -
  // same reasoning as app/index.js/LoginScreen.js/RegisterScreen.js's own
  // gating, so an admin who lands back on an auth route while already
  // signed in (e.g. browser back navigation, a stale deep link) is still
  // routed straight to /admin rather than through /(tabs) first.
  if (loading || (session && !passwordRecovery && adminLoading)) {
    // Same reasoning as app/index.js: a themed placeholder instead of
    // `null`, so there is never an unstyled blank/light flash before
    // LoginScreen/RegisterScreen (or the redirect below) render - the exact
    // gap that made the finalized auth design look broken on a first load
    // but fine after a refresh (faster hydration hides the same gap).
    return <View style={{ flex: 1, backgroundColor: colors.bgDark }} />;
  }

  // A password-recovery session is a real, authenticated Supabase session
  // (see AuthContext's deep-link handling), so without this check the
  // ordinary "already signed in -> tabs/admin" redirect below would
  // immediately bounce a recovering user away from reset-password before
  // they could set a new password. If they somehow land on a different auth
  // screen while recovering (e.g. login), send them to reset-password
  // instead - never leave a recovery session sitting on login/register.
  if (session && passwordRecovery && !isResetPasswordRoute) {
    return <Redirect href="/(auth)/reset-password" />;
  }

  if (session && !passwordRecovery) {
    return <Redirect href={isAdmin ? '/admin' : '/(tabs)'} />;
  }

  // Login/Register/ForgotPassword/ResetPassword's dark gradient background
  // lives here, not inside AuthScreenShell (see that file for the full
  // explanation) - this layout component is never remounted while
  // navigating between sibling routes in the same Stack, so a gradient
  // rendered here mounts once and never re-measures, avoiding the onLayout
  // race that made it disappear after switching between auth screens.
  // reset-password uses the same AuthScreenShell/dark background as
  // Login/Register/ForgotPassword (see ResetPasswordScreen) for all of its
  // states (validating/invalid-link/form), so the gradient must already be
  // showing before the recovery link even finishes validating.
  const showAuthBackground =
    pathname === '/login' ||
    pathname === '/register' ||
    pathname === '/forgot-password' ||
    pathname === '/reset-password';

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
      {/* STAGE 19.2: Stage 19.1's animation:'none' overrides on the login/
          register routes are gone - they were a workaround for a real
          Stack navigation between two separate screens, which still let
          both briefly appear together on a physical device. login.js and
          register.js now both render the SAME persistent AuthScreen
          component (see src/screens/AuthScreen.js) with a different
          initialMode - switching modes is a local state update inside
          that component, never a Stack navigation, so there is no
          transition left here to disable. Both routes still exist (deep
          links to /login and /register both work, landing on the correct
          starting mode) and still go through this same plain Stack with
          its normal default animation, same as forgot-password/
          reset-password. */}
      <Stack screenOptions={{ headerShown: false }} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
