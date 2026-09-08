import { supabase } from './supabase';

// STAGE 31: thin client wrappers around the four SECURITY DEFINER RPCs added
// in supabase/migrations/029_admin_user_management.sql. Deliberately no
// caching layer here (unlike profileService.js/purchaseReportService.js) -
// the admin roster changes rarely and this screen is only ever opened
// explicitly by an admin who wants the current, authoritative state, not a
// high-frequency screen that benefits from stale-while-revalidate. Every
// function below is a direct, unmodified passthrough to its RPC - all real
// authorization/validation happens server-side (see the migration's own
// comments); nothing here is itself a security boundary.

// STAGE 31.2: dev-only diagnostic log for an RPC failure - captures the four
// fields a PostgrestError actually carries (code/message/details/hint) so a
// real Postgres-side failure (e.g. the 42804 type-mismatch this stage fixed)
// can be diagnosed directly from the dev console, without ever reaching the
// user-facing UI - getAdminUsersErrorMessage() below remains the ONLY thing
// any screen shows an admin. Deliberately logs only the error object's own
// fields, never the request's own arguments (a search query or a target
// user id), since those aren't needed to diagnose a schema/type/permission
// failure and have no reason to be in a log line at all.
function logAdminUsersRpcError(context, error) {
  if (!__DEV__) {
    return;
  }

  console.error(`[Admin users] ${context}`, {
    code: error?.code,
    message: error?.message,
    details: error?.details,
    hint: error?.hint,
  });
}

// The current admin roster - admin-gated server-side (029). A non-admin
// caller gets a rejected promise with error.message === 'not_admin', never
// a partial or empty-but-silent result.
export async function getAdminUsers() {
  if (!supabase) {
    return [];
  }

  const { data, error } = await supabase.rpc('get_admin_users');

  if (error) {
    logAdminUsersRpcError('get_admin_users failed', error);
    throw error;
  }

  return data || [];
}

// Server-side search over EXISTING registered users only, excluding anyone
// already an admin (029 filters this out itself). Never called with a
// query shorter than 2 trimmed characters - the RPC itself also enforces
// this (raises 'query_too_short'), this is just an early client-side guard
// so a 1-character keystroke never fires a request at all.
export async function searchAdminCandidates(query) {
  if (!supabase) {
    return [];
  }

  const trimmed = (query || '').trim();
  if (trimmed.length < 2) {
    return [];
  }

  const { data, error } = await supabase.rpc('search_admin_candidate_users', { p_query: trimmed });

  if (error) {
    logAdminUsersRpcError('search_admin_candidate_users failed', error);
    throw error;
  }

  return data || [];
}

// Promotes an existing user to admin. Resolves to true if this call
// actually created the admin_users row, false if the target was already an
// admin (the RPC is idempotent - see its own comment) - used only to pick
// the right confirmation message, never for anything security-relevant.
export async function addAdminUser(targetUserId) {
  if (!supabase || !targetUserId) {
    throw new Error('Admin promotion is not available.');
  }

  const { data, error } = await supabase.rpc('add_admin_user', { p_target_user_id: targetUserId });

  if (error) {
    logAdminUsersRpcError('add_admin_user failed', error);
    throw error;
  }

  return Boolean(data);
}

// Removes an existing admin's access. Self-removal and last-admin
// protection are both enforced server-side (029) - this function never
// second-guesses or pre-validates those rules client-side beyond the UI
// simply not offering the self-removal action at all (see
// AdminUsersScreen.js).
export async function removeAdminUser(targetUserId) {
  if (!supabase || !targetUserId) {
    throw new Error('Admin removal is not available.');
  }

  const { error } = await supabase.rpc('remove_admin_user', { p_target_user_id: targetUserId });

  if (error) {
    logAdminUsersRpcError('remove_admin_user failed', error);
    throw error;
  }
}

// Maps this file's RPCs' known Postgres error codes to Hebrew, user-facing
// messages - same convention as AdminReportDetailScreen.js's own
// getActionErrorMessage(): never surface a raw Postgres/Supabase error
// string to an admin, and never guess at an unrecognized one beyond a safe
// generic fallback.
export function getAdminUsersErrorMessage(err) {
  switch (err?.message) {
    // STAGE 31.3: exact wording specified for the four errors
    // remove_admin_user can raise - shared by every RPC in this file since
    // 'not_admin' in particular is common to all four, not remove-specific.
    case 'not_admin':
      return 'אין לך הרשאה לבצע פעולה זו.';
    case 'cannot_remove_self':
      return 'לא ניתן להסיר את הרשאת המנהל של המשתמש המחובר.';
    case 'cannot_remove_last_admin':
      return 'לא ניתן להסיר את המנהל האחרון במערכת.';
    case 'target_not_admin':
      return 'המשתמש כבר אינו מנהל.';
    case 'target_required':
      return 'יש לבחור משתמש.';
    case 'target_user_not_found':
      return 'המשתמש שנבחר אינו קיים במערכת.';
    case 'query_too_short':
      return 'יש להקליד לפחות 2 תווים לחיפוש.';
    default:
      return 'לא ניתן היה לבצע את הפעולה. נסו שוב.';
  }
}
