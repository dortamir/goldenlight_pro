import { Ionicons } from '@expo/vector-icons';
import * as Font from 'expo-font';
import { DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider } from '../src/context/AuthContext';
import { supabase, supabaseConfigStatus } from '../src/services/supabase';

// React Navigation wraps every screen in its own opaque "Background",
// filled with the current navigation theme's `colors.background` (the
// stock default is rgb(242, 242, 242)) - independent of any screen's own
// content. Every screen in this app already paints its own explicit,
// opaque background via AppScreen, so overriding just this one theme color
// to transparent app-wide is invisible everywhere except where a screen
// deliberately wants to see through it (AuthScreenShell, for the Login/
// Register dark gradient - see app/(auth)/_layout.js).
const transparentBackgroundTheme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, background: 'transparent' },
};

export default function RootLayout() {
  useEffect(() => {
    // Preload the Ionicons font used by the bottom tab bar as early as
    // possible, well before the tab bar itself ever mounts. Each rendered
    // <Ionicons> icon otherwise calls Font.loadAsync internally on its own
    // mount if the font isn't loaded yet; on web that goes through
    // expo-font's fontfaceobserver-based loader, which has a hard ~12s
    // timeout and (due to a known upstream issue) can surface a rejected
    // promise as an unhandled rejection instead of failing quietly. Starting
    // the load here gives it the whole app-launch window to finish before
    // any icon needs it, and catching it here means a slow/failed load on
    // web is never left unhandled. This never blocks rendering - we don't
    // await it or gate any UI on the result.
    Font.loadAsync(Ionicons.font).catch(() => {});
  }, []);

  useEffect(() => {
    if (!__DEV__) {
      return;
    }

    if (!supabase) {
      console.warn('[Supabase] Client not initialized because the public environment variables are missing.');
      return;
    }

    console.info('[Supabase] Client initialized successfully.', {
      hasUrl: supabaseConfigStatus.hasUrl,
      hasAnonKey: supabaseConfigStatus.hasAnonKey,
      isConfigured: supabaseConfigStatus.isConfigured,
    });
  }, []);

  return (
    <SafeAreaProvider>
      <AuthProvider>
        <ThemeProvider value={transparentBackgroundTheme}>
          <Stack screenOptions={{ headerShown: false }} />
        </ThemeProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
