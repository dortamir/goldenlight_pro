-- Admin User Management: lets an existing administrator view the current
-- admin roster, search existing GOLDEN+ users, promote one to admin, and
-- remove admin access from another - entirely through the SAME
-- public.admin_users / public.is_admin() architecture introduced in
-- 008_create_admin_users.sql / 009_admin_read_access.sql. This migration
-- does not create a second permission system, a new role, or any JWT/custom
-- -claim mechanism - admin status remains exactly what it has always been: a
-- row's presence in public.admin_users, checked fresh on every call via
-- public.is_admin().
--
-- Before this migration, public.admin_users had NO write path reachable from
-- the app's client at all (see 008's own comment: "the only ways to write
-- this table are... the Supabase SQL editor/dashboard, a service-role
-- connection, or a FUTURE TRUSTED ADMIN-MANAGEMENT FLOW that itself runs
-- with service-role privileges"). This migration is that flow - implemented
-- as narrowly-scoped SECURITY DEFINER RPCs (the exact pattern already used
-- for every other privileged write in this schema: finalize_purchase_report,
-- award_purchase_points, save_manual_receipt_items, review_purchase_report),
-- never as a broadened RLS policy or a direct client grant on admin_users
-- itself. admin_users' own table privileges/RLS (008) are UNCHANGED by this
-- migration - still zero INSERT/UPDATE/DELETE grant to any client role, at
-- both the RLS and table-privilege level. Every function below independently
-- re-verifies public.is_admin() as its very first statement, exactly like
-- every existing admin RPC - never trusting the caller's own client-side
-- isAdmin state, route protection, or hidden UI.

-- ------------------------------------------------------------------------
-- public.get_admin_users(): the current admin roster, for the "ניהול
-- מנהלים" screen's own list. Admin-gated read - a non-admin caller gets
-- 'not_admin' and zero rows, never a partial/empty-but-silent result.
--
-- Reads auth.users.email directly - something no client-facing grant in
-- this schema has ever exposed before (public.profiles, deliberately, has
-- no email column - see 001_create_profiles.sql). This is safe specifically
-- BECAUSE it happens inside a SECURITY DEFINER function that (a) requires
-- the caller to already be a verified admin, and (b) only ever returns the
-- email of an existing ADMIN (a small, already-trusted set), never an
-- arbitrary user's email - see search_admin_candidate_users below for the
-- equivalent, separately-scoped decision for the search path. Running as
-- the function owner (not the caller's own role) is what makes reading
-- auth.users possible at all - the anon-key client itself has no grant on
-- that schema and never will.
--
-- full_name is returned exactly as stored (nullable in practice only if a
-- profiles row is somehow missing - handle_new_user() always creates one on
-- signup, so this is a defensive left join, not an expected case). The
-- caller (AdminUsersScreen.js) applies the same "משתמש ללא שם" display
-- fallback every other admin screen already uses for a missing name -
-- this function itself invents no display text, per the existing
-- convention of RPCs returning raw data only.
create or replace function public.get_admin_users()
returns table (
  user_id uuid,
  full_name text,
  email text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;

  return query
    select
      au.user_id,
      p.full_name,
      u.email,
      au.created_at
    from public.admin_users au
    left join public.profiles p on p.id = au.user_id
    left join auth.users u on u.id = au.user_id
    order by coalesce(p.full_name, ''), au.created_at asc;
end;
$$;

revoke execute on function public.get_admin_users() from anon;
revoke execute on function public.get_admin_users() from public;
grant execute on function public.get_admin_users() to authenticated;

-- ------------------------------------------------------------------------
-- public.search_admin_candidate_users(p_query): server-side search over
-- EXISTING registered users, for the "+ הוספת מנהל" search step. Never
-- returns the whole user base - three independent limits, all enforced
-- here, not trusted to the client:
--   1. p_query must be at least 2 trimmed characters, or this raises
--      'query_too_short' rather than matching everything.
--   2. Matches are scoped to full_name/email via ILIKE '%...%' - a
--      substring search, not a dump.
--   3. `limit 20` caps the result set regardless of how many rows match.
--
-- Deliberately EXCLUDES anyone already in admin_users (via the `not exists`
-- below) - a user who's already an admin has nothing to "add", so they
-- simply never appear as a candidate; this keeps the client simple (no
-- disabled/already-admin state to render) rather than exposing admin status
-- for every search hit.
--
-- Only user_id/full_name/email are returned - no phone, profession,
-- points_balance, membership_level, or any other profiles column, and
-- nothing from auth.users beyond email (no last-sign-in, no provider data,
-- no metadata). This is intentionally a narrower projection than
-- get_admin_users() above even though both read the same two tables -
-- searching the ENTIRE user base for a match is a materially different
-- exposure than listing the already-small, already-trusted admin set, so
-- this path is kept as minimal as the UI actually needs.
create or replace function public.search_admin_candidate_users(p_query text)
returns table (
  user_id uuid,
  full_name text,
  email text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_query text;
begin
  if not public.is_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;

  v_query := btrim(coalesce(p_query, ''));

  if length(v_query) < 2 then
    raise exception 'query_too_short' using errcode = '22023';
  end if;

  return query
    select
      p.id,
      p.full_name,
      u.email
    from public.profiles p
    join auth.users u on u.id = p.id
    where (
        p.full_name ilike '%' || v_query || '%'
        or u.email ilike '%' || v_query || '%'
      )
      and not exists (
        select 1 from public.admin_users au where au.user_id = p.id
      )
    order by p.full_name asc
    limit 20;
end;
$$;

revoke execute on function public.search_admin_candidate_users(text) from anon;
revoke execute on function public.search_admin_candidate_users(text) from public;
grant execute on function public.search_admin_candidate_users(text) to authenticated;

-- ------------------------------------------------------------------------
-- public.add_admin_user(p_target_user_id): promotes an existing GOLDEN+
-- user to admin. This is the ONLY write path to admin_users this migration
-- adds for insertion.
--
--   1. Caller must be a real admin_users member - checked first,
--      unconditionally, exactly like every other admin RPC in this schema.
--   2. p_target_user_id is required.
--   3. The target must exist in BOTH public.profiles AND auth.users -
--      'target_user_not_found' otherwise. Checked with a join, not just a
--      profiles lookup alone: profiles.id is a foreign key to auth.users(id)
--      (001_create_profiles.sql), so in the normal case a profiles row
--      already implies a matching auth.users row - but this deliberately
--      does not lean on that FK holding as its only evidence. The join
--      confirms the SAME row genuinely exists on both sides at the moment
--      of promotion, rather than trusting a profiles-only read - no
--      auth.users column is selected or returned anywhere, this only tests
--      existence (STAGE 31.1 hardening). This migration never creates a new
--      auth user or profile; only promotes an existing one.
--   4. `insert ... on conflict (user_id) do nothing` makes this idempotent -
--      promoting an already-admin user a second time is a harmless no-op,
--      never a duplicate row and never an error. The function returns
--      whether a row was actually inserted (true = newly promoted, false =
--      already was an admin), which the client uses purely for a clearer
--      confirmation message - never for anything security-relevant.
--   5. created_by is always auth.uid() (the promoting admin) - never
--      accepted from the client - matching admin_users' own existing
--      column comment ("Optional provenance only... never trusted for
--      authorization itself", 008_create_admin_users.sql).
create or replace function public.add_admin_user(p_target_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target_exists boolean;
  v_row_count integer;
begin
  if not public.is_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;

  if p_target_user_id is null then
    raise exception 'target_required' using errcode = '22023';
  end if;

  -- STAGE 31.1: confirms the target exists in BOTH tables via a join,
  -- rather than trusting the profiles.id -> auth.users(id) foreign key
  -- alone as evidence that a matching auth user is present. No auth.users
  -- column is selected here - only used inside the join condition to prove
  -- existence.
  select exists(
    select 1
    from public.profiles p
    join auth.users u on u.id = p.id
    where p.id = p_target_user_id
  ) into v_target_exists;

  if not v_target_exists then
    raise exception 'target_user_not_found' using errcode = 'P0002';
  end if;

  insert into public.admin_users (user_id, created_by)
  values (p_target_user_id, auth.uid())
  on conflict (user_id) do nothing;

  get diagnostics v_row_count = row_count;

  return v_row_count > 0;
end;
$$;

revoke execute on function public.add_admin_user(uuid) from anon;
revoke execute on function public.add_admin_user(uuid) from public;
grant execute on function public.add_admin_user(uuid) to authenticated;

-- ------------------------------------------------------------------------
-- public.remove_admin_user(p_target_user_id): removes an existing admin's
-- access. The ONLY write path to admin_users this migration adds for
-- deletion.
--
--   1. Caller must be a real admin_users member - checked first.
--   2. p_target_user_id is required.
--   3. SELF-REMOVAL PROTECTION: p_target_user_id = auth.uid() is rejected
--      with 'cannot_remove_self' BEFORE anything else is checked (including
--      before the table lock below) - an admin can never remove their own
--      access through this function, server-side, regardless of what the
--      client UI does or doesn't disable.
--   4. CONCURRENCY / LAST-ADMIN PROTECTION: `lock table public.admin_users
--      in exclusive mode` is taken before counting. EXCLUSIVE mode conflicts
--      with the ROW EXCLUSIVE lock every INSERT/UPDATE/DELETE on this table
--      takes (including add_admin_user's insert above and any other
--      concurrent call to this same function), so at most one
--      admin_users-modifying transaction runs at a time - a second,
--      near-simultaneous remove_admin_user call for a DIFFERENT target
--      blocks here until the first commits, then re-counts against the
--      now-updated row set, so two concurrent removals can never both
--      "see" the same pre-removal count and jointly empty the table. Plain
--      SELECTs (e.g. the client's own "check my admin membership" query,
--      or is_admin() itself) take only ACCESS SHARE and are NOT blocked by
--      an EXCLUSIVE lock, so this never stalls unrelated reads - only other
--      writers to this specific table, for the brief duration of this one
--      function call.
--   5. The target must currently be an admin - 'target_not_admin' otherwise
--      (covers both "never was one" and "someone else already removed them
--      a moment ago").
--   6. If removing the target would leave zero admins (current count <= 1),
--      this raises 'cannot_remove_last_admin' and the delete never happens
--      - the system can never end up with no administrators through this
--      function.
--   7. Only then does the actual delete run.
create or replace function public.remove_admin_user(p_target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target_is_admin boolean;
  v_admin_count integer;
begin
  if not public.is_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;

  if p_target_user_id is null then
    raise exception 'target_required' using errcode = '22023';
  end if;

  if p_target_user_id = auth.uid() then
    raise exception 'cannot_remove_self' using errcode = '22023';
  end if;

  -- Serializes every concurrent admin_users writer (this function and
  -- add_admin_user above) for the rest of this transaction - see the
  -- function-level comment for why this is what makes the count-then-delete
  -- below race-free.
  lock table public.admin_users in exclusive mode;

  select exists(
    select 1 from public.admin_users where user_id = p_target_user_id
  ) into v_target_is_admin;

  if not v_target_is_admin then
    raise exception 'target_not_admin' using errcode = 'P0002';
  end if;

  select count(*) into v_admin_count from public.admin_users;

  if v_admin_count <= 1 then
    raise exception 'cannot_remove_last_admin' using errcode = '23514';
  end if;

  delete from public.admin_users where user_id = p_target_user_id;
end;
$$;

revoke execute on function public.remove_admin_user(uuid) from anon;
revoke execute on function public.remove_admin_user(uuid) from public;
grant execute on function public.remove_admin_user(uuid) to authenticated;
