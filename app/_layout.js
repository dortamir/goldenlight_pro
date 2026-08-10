import { Stack } from 'expo-router';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider } from '../src/context/AuthContext';
import { supabase, supabaseConfigStatus } from '../src/services/supabase';

export default function RootLayout() {
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
        <Stack screenOptions={{ headerShown: false }} />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
