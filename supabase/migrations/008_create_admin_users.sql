-- Admin authorization foundation: public.admin_users determines who may
-- access the admin area of the app.
--
-- Deliberately a SEPARATE table, not a flag on public.profiles. Authenticated
-- users already hold a column-level UPDATE grant on their own profiles row
-- (full_name, phone, profession, avatar_path - see 001_create_profiles.sql
-- and 006_add_profile_avatar.sql). An admin flag living in that same table
-- would require every future grant/policy change on profiles to remember to
-- keep excluding it, forever. A separate table with NO authenticated
-- INSERT/UPDATE/DELETE access at all removes that risk structurally: a
-- normal user cannot self-promote to admin no matter what happens to
-- profiles' own grants later.

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  -- Optional provenance only (which admin/service action added this row).
  -- Nullable - never required, never trusted for authorization itself.
  created_by uuid references auth.users(id)
);

alter table public.admin_users enable row level security;

-- No INSERT/UPDATE/DELETE policy exists for any role, anon or authenticated.
-- Under Postgres RLS, the absence of a policy for an operation denies that
-- operation by default once RLS is enabled - so admin membership cannot be
-- inserted, updated, or deleted through the app's Supabase client (anon key)
-- under any circumstance. The only ways to write this table are a trusted
-- context that bypasses RLS entirely: the Supabase SQL editor/dashboard, a
-- service-role connection, or a future trusted admin-management flow that
-- itself runs with service-role privileges. See supabase/README.md for the
-- exact manual SQL used to add the first admin.

-- The signed-in user may check ONLY their own membership row - this is the
-- minimum access required for the client-side admin route guard to ask "is
-- the current user an admin?" without being able to list or infer anyone
-- else's admin status.
create policy "Users can check their own admin membership"
  on public.admin_users
  for select
  using (auth.uid() = user_id);

-- Defense in depth: revoke everything first, then grant back only SELECT to
-- authenticated. Even if a policy were ever mistakenly added later, no
-- INSERT/UPDATE/DELETE grant exists at the table-privilege level either, so
-- the write would still be rejected before RLS is even evaluated. anon has
-- no access at all - checking admin membership requires being authenticated.
revoke all on table public.admin_users from anon;
revoke all on table public.admin_users from authenticated;
revoke all on table public.admin_users from public;

grant select on table public.admin_users to authenticated;
grant usage on schema public to authenticated;
