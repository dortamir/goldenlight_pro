import { createClient } from '@supabase/supabase-js';

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

export const supabase = isMissingConfig
  ? null
  : createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

export const supabaseConfigStatus = {
  hasUrl: Boolean(supabaseUrl),
  hasAnonKey: Boolean(supabaseAnonKey),
  isConfigured: Boolean(supabaseUrl && supabaseAnonKey),
};
