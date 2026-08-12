// Shared CORS headers for Supabase Edge Functions in this project.
// Permissive origin is the standard Supabase Edge Function pattern for a
// JSON API intended to be called from a browser (Expo Web) in addition to
// native clients, which don't send/enforce CORS at all.
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
