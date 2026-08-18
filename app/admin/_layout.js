import { Redirect, Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useAuth } from '../../src/context/AuthContext';
import { isCurrentUserAdmin } from '../../src/services/adminService';
import { colors } from '../../src/theme';

// Route guard for the entire /admin area (not a customer tab - see
// app/(tabs)/_layout.js for the four real bottom tabs, which this never
// touches or appears in).
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
  const { session, user, loading: authLoading } = useAuth();
  // 'checking' | 'admin' | 'not-admin' - starts at 'checking' so there is
  // never a frame where a non-admin sees admin content while the async
  // admin_users lookup is still in flight.
  const [adminStatus, setAdminStatus] = useState('checking');

  useEffect(() => {
    let isActive = true;

    if (authLoading) {
      return undefined;
    }

    if (!user) {
      setAdminStatus('not-admin');
      return undefined;
    }

    setAdminStatus('checking');

    isCurrentUserAdmin().then((isAdmin) => {
      if (isActive) {
        setAdminStatus(isAdmin ? 'admin' : 'not-admin');
      }
    });

    return () => {
      isActive = false;
    };
    // user?.id (not the whole user/session object) - a token refresh emits a
    // new session/user object for the same person and must not re-trigger
    // this check.
  }, [authLoading, user?.id]);

  if (authLoading || adminStatus === 'checking') {
    return <View style={styles.loadingState} />;
  }

  if (!session) {
    return <Redirect href="/(auth)/login" />;
  }

  if (adminStatus !== 'admin') {
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
