import { Redirect, Stack, usePathname } from 'expo-router';

import { useAuth } from '../../src/context/AuthContext';

export default function AuthLayout() {
  const { session, loading, passwordRecovery } = useAuth();
  const pathname = usePathname();
  const isResetPasswordRoute = Boolean(pathname && pathname.includes('reset-password'));

  if (loading) {
    return null;
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

  return <Stack screenOptions={{ headerShown: false }} />;
}
