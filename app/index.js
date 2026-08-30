import { Redirect } from 'expo-router';
import { View } from 'react-native';

import { useAuth } from '../src/context/AuthContext';
import { colors } from '../src/theme';

export default function Index() {
  const { session, loading, isAdmin, adminLoading } = useAuth();

  // STAGE 17: waits for the admin_users check (adminLoading) too, not just
  // auth itself (loading) - but ONLY when there's actually a session to
  // check; an unauthenticated visitor is definitively routed to login
  // without waiting on a role lookup that will never resolve to anything
  // meaningful for them. This is what prevents an admin from ever briefly
  // landing on customer Home before manually navigating to /admin - the
  // route decision below simply doesn't happen until both loading and
  // adminLoading have settled.
  if (loading || (session && adminLoading)) {
    // A plain themed placeholder instead of `null` - `null` renders nothing,
    // which flashes the page's default (light) background until the async
    // session check resolves. That flash is brief on a warm reload but can
    // be clearly visible on a slower first load, which is what made the
    // auth screens look "wrong" until a refresh. This never redesigns
    // anything - it just avoids an unstyled blank frame before the real
    // redirect/screen renders.
    return <View style={{ flex: 1, backgroundColor: colors.bgDark }} />;
  }

  if (!session) {
    return <Redirect href="/(auth)/login" />;
  }

  return <Redirect href={isAdmin ? '/admin' : '/(tabs)'} />;
}