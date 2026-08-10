import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

import 'react-native-url-polyfill/auto';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (__DEV__) {
  if (!supabaseUrl) {
    console.warn('[Supabase] Missing EXPO_PUBLIC_SUPABASE_URL. Set it in the root .env file.');
  }

  if (!supabaseAnonKey) {
    console.warn('[Supabase] Missing EXPO_PUBLIC_SUPABASE_ANON_KEY. Set it in the root .env file.');
  }
}

const isMissingConfig = !supabaseUrl || !supabaseAnonKey;

const storage = {
  getItem: async (key) => {
    try {
      if (typeof globalThis !== 'undefined' && typeof globalThis.window !== 'undefined' && globalThis.window.localStorage) {
        return globalThis.window.localStorage.getItem(key);
      }

      return await AsyncStorage.getItem(key);
    } catch (error) {
      return null;
    }
  },
  setItem: async (key, value) => {
    try {
      if (typeof globalThis !== 'undefined' && typeof globalThis.window !== 'undefined' && globalThis.window.localStorage) {
        globalThis.window.localStorage.setItem(key, value);
        return;
      }

      await AsyncStorage.setItem(key, value);
    } catch (error) {
      return;
    }
  },
  removeItem: async (key) => {
    try {
      if (typeof globalThis !== 'undefined' && typeof globalThis.window !== 'undefined' && globalThis.window.localStorage) {
        globalThis.window.localStorage.removeItem(key);
        return;
      }

      await AsyncStorage.removeItem(key);
    } catch (error) {
      return;
    }
  },
};

export const supabase = isMissingConfig
  ? null
  : createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storage,
      },
    });

export const supabaseConfigStatus = {
  hasUrl: Boolean(supabaseUrl),
  hasAnonKey: Boolean(supabaseAnonKey),
  isConfigured: Boolean(supabaseUrl && supabaseAnonKey),
};
