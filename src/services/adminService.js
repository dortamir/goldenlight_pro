import { supabase } from './supabase';

// Client-side admin check - controls ONLY whether admin UI/routes render for
// the current user. It is NOT a security boundary for any privileged
// database write: the anon-key client can only ever SELECT its own
// admin_users row (see supabase/migrations/008_create_admin_users.sql), so
// this function can never be tricked into returning true for a non-admin by
// manipulating the client. Any future admin-only mutation must still be
// independently enforced by its own RLS policy or a trusted/service-role
// backend - never by trusting this boolean alone. See app/admin/_layout.js
// and supabase/README.md for the full explanation.
export async function isCurrentUserAdmin() {
  if (!supabase) {
    return false;
  }

  const { data: { user }, error: userError } = await supabase.auth.getUser();

  if (userError || !user) {
    return false;
  }

  const { data, error } = await supabase
    .from('admin_users')
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) {
    if (__DEV__) {
      console.warn('[Admin] Failed to check admin membership', { code: error.code, message: error.message });
    }
    return false;
  }

  return Boolean(data);
}
