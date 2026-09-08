-- Fixes PostgreSQL error 42804 ("structure of query does not match function
-- result type"), reported live on the physical app: /admin/users opened
-- correctly, but both loading the admin roster and searching for a
-- promotion candidate failed with this error.
--
-- ROOT CAUSE: public.get_admin_users() and public.search_admin_candidate_
-- users(p_query) (029_admin_user_management.sql) each declare their
-- `returns table (...)` structure with an `email text` column, populated
-- via `u.email` from auth.users - but Supabase's own auth.users table
-- defines `email` as `character varying(255)` (varchar), not `text`. Every
-- OTHER column either function declares already matched its real source
-- type exactly: public.profiles.full_name is `text`
-- (001_create_profiles.sql), and public.admin_users.user_id/created_at are
-- `uuid`/`timestamptz` (008_create_admin_users.sql) - only `email` was
-- ever mismatched.
--
-- In an ordinary top-level `select ... from auth.users`, Postgres would
-- silently, implicitly cast that varchar to text with no error at all -
-- which is exactly why this was not caught before deployment (nothing in
-- either function's own body, read in isolation, looks wrong). The failure
-- is specific to how plpgsql's `return query` works against a `returns
-- table (...)` signature: unlike an ordinary SELECT's result columns,
-- `return query`'s output columns must match the function's declared OUT
-- parameter types EXACTLY (the same type OID) - varchar returned where the
-- function's own signature promises text raises SQLSTATE 42804, with a
-- hint naming the exact column and the "character varying vs text"
-- mismatch.
--
-- FIX: cast `u.email::text` in the SELECT projection of both functions.
-- This is the smallest possible change - the functions' PUBLIC contract
-- (their `returns table` structure, still declaring `email text`) is
-- completely unchanged, so src/services/adminUsersService.js and
-- src/screens/AdminUsersScreen.js need no update at all: the client already
-- only ever treated `email` as a plain JS string, exactly as before.
--
-- Both functions are recreated via `create or replace function` with the
-- EXACT SAME name, argument types, and `returns table` structure as
-- 029 - this replaces their body in place without dropping/recreating the
-- function object. Postgres does not reset a function's grants when its
-- signature is unchanged, so Stage 31's revoke/grant privileges were never
-- actually lost by this bug - the revoke/grant statements below are
-- reissued anyway purely to match this schema's own established convention
-- (see 016_simplify_eligible_amount_calc.sql redefining
-- award_purchase_points() the same way) of every function-defining
-- migration being fully self-contained and independently verifiable,
-- without requiring a reader to cross-reference an earlier file to confirm
-- the privileges are still correct.
--
-- Every other Stage 31 security property is preserved byte-for-byte:
-- SECURITY DEFINER, set search_path = '', the public.is_admin() gate as the
-- unconditional first statement, anon/PUBLIC revoked, authenticated
-- granted, the 2-character search minimum, the `limit 20` cap, and the
-- exclusion of existing admins from search results. public.add_admin_user
-- and public.remove_admin_user are NOT touched by this migration - neither
-- returns a table/row structure (boolean and void respectively), so
-- neither was ever susceptible to this specific error, and their bodies
-- (including add_admin_user's Stage 31.1 "target exists in BOTH
-- public.profiles AND auth.users" join) are completely unchanged.

-- ------------------------------------------------------------------------
-- public.get_admin_users(): identical to 029's version except the `email`
-- projection is now explicitly cast to text.
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
      u.email::text,
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
-- public.search_admin_candidate_users(p_query): identical to 029's version
-- except the `email` projection is now explicitly cast to text. The
-- `u.email ilike '%' || v_query || '%'` filter in the where clause is
-- unaffected by this fix - ILIKE against a varchar column has always
-- worked correctly and was never part of the 42804 failure (that error is
-- specific to the return-query/returns-table column-type binding, not to
-- filtering/comparison expressions).
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
      u.email::text
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
