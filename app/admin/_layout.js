import { Redirect, Stack } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { useAuth } from '../../src/context/AuthContext';
import { colors } from '../../src/theme';

// Route guard for the entire /admin area (not a customer tab - see
// app/(tabs)/_layout.js for the four real bottom tabs, which this never
// touches or appears in).
//
// STAGE 17: reads isAdmin/adminLoading from AuthContext instead of running
// its own separate isCurrentUserAdmin() check - that same check now runs
// exactly once per session, in AuthContext, shared with app/index.js's own
// routing decision (see that file). The guard logic itself - never render
// admin content until the check resolves, redirect anyone who isn't
// actually an admin - is UNCHANGED; only the SOURCE of the boolean moved.
//
// IMPORTANT - this guard is an INTERFACE control only. It decides whether
// admin screens render in this app; it does not and cannot make any
// database write safe by itself. Every future privileged admin write
// (approving a purchase report, awarding points, editing another user's
// data, ...) must be independently enforced by its own RLS policy or a
// trusted/service-role backend function. A client-side `isAdmin` check is
// trivial to bypass by anyone inspecting/modifying the app, so it must never
// be the ONLY thing standing between a request and a privileged mutation.
// See supabase/migrations/008_create_admin_users.sql and supabase/README.md.
export default function AdminLayout() {
  const { session, loading: authLoading, isAdmin, adminLoading } = useAuth();

  if (authLoading || adminLoading) {
    return <View style={styles.loadingState} />;
  }

  if (!session) {
    return <Redirect href="/(auth)/login" />;
  }

  if (!isAdmin) {
    // Authenticated but not an admin - deny access and land back in the
    // normal app, never on an admin screen and never on a bare error page
    // that would hint at what this route is.
    return <Redirect href="/(tabs)" />;
  }

  return <Stack screenOptions={{ headerShown: false }} />;
}

const styles = StyleSheet.create({
  loadingState: {
    flex: 1,
    backgroundColor: colors.bgDark,
  },
});