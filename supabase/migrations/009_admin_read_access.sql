-- Admin Stage 2: read-only admin access to customer purchase-report data.
--
-- This migration adds ADDITIONAL, admin-only SELECT policies alongside the
-- existing customer policies - it does not remove, replace, or weaken any
-- existing policy. Postgres RLS policies for the same command are combined
-- with OR, so a normal authenticated user's visibility is completely
-- unchanged: they still only ever satisfy their own "auth.uid() = user_id"
-- (or equivalent ownership-chain) policy, never the new admin one, since
-- public.is_admin() returns false for them.
--
-- No INSERT/UPDATE/DELETE access is added anywhere in this migration - this
-- stage is strictly read-only.

-- ------------------------------------------------------------------------
-- public.is_admin(): the single source of truth for "is the calling user an
-- admin?", used by every policy below.
--
-- Why a SECURITY DEFINER function instead of inlining
-- `exists (select 1 from public.admin_users where user_id = auth.uid())`
-- directly into each policy:
--
-- 1. Referencing admin_users directly from another table's RLS policy would
--    still work correctly here (admin_users' own SELECT policy already lets
--    a user read their own membership row, so the subquery would resolve
--    fine and does not recurse - there is no cycle, since admin_users' own
--    policy never references purchase_reports/profiles/etc. back). But it
--    would mean six near-identical subqueries duplicated across policies on
--    purchase_reports, profiles, receipt_ocr_results, receipt_ocr_lines,
--    receipt_line_matches, and storage.objects, all of which would silently
--    need to change together if the admin model ever changes shape.
-- 2. SECURITY DEFINER makes this function's result independent of
--    admin_users' own grants/RLS entirely (it runs as the function owner,
--    bypassing RLS on admin_users), which is the standard, recommended
--    Postgres/Supabase pattern for a role-check helper used inside other
--    tables' policies - it removes any dependency on admin_users' SELECT
--    policy continuing to exist/behave a specific way in the future.
-- 3. `stable` (not the default `volatile`) tells the planner this function's
--    result cannot change within a single statement, so Postgres can avoid
--    redundant re-evaluation when scanning many rows.
--
-- `set search_path = ''` follows the same convention as every other
-- SECURITY DEFINER/trigger function in this schema (see
-- public.handle_new_user() in 001_create_profiles.sql) - it prevents
-- search_path hijacking, which is why public.admin_users is fully
-- schema-qualified in the body below. This function takes no parameters and
-- only ever reports on auth.uid() (the calling user) - it cannot be used to
-- ask about anyone else's admin status.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.admin_users
    where user_id = auth.uid()
  );
$$;

revoke execute on function public.is_admin() from anon;
revoke execute on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- ------------------------------------------------------------------------
-- purchase_reports: admins may read every report (needed for the dashboard
-- summary counts across statuses and the review queue), not only
-- needs_review rows - the review queue itself decides what to filter/show;
-- RLS only gates admin-vs-customer row visibility.
create policy "Admins can view all purchase reports"
  on public.purchase_reports
  for select
  to authenticated
  using (public.is_admin());

-- ------------------------------------------------------------------------
-- profiles: admins may read any profile row, needed to show the report
-- owner's full_name in the queue/detail screens. This does not change the
-- existing column-level grant (still full_name, phone, profession,
-- avatar_path, points_balance, membership_level, approved_purchases_count,
-- id, created_at, updated_at - all already selectable, unchanged since
-- 001_create_profiles.sql) - only which ROWS are visible changes for
-- admins. The admin UI itself only queries full_name for this stage.
create policy "Admins can view all profiles"
  on public.profiles
  for select
  to authenticated
  using (public.is_admin());

-- ------------------------------------------------------------------------
-- receipt_ocr_results / receipt_ocr_lines: admins may read OCR data for any
-- report, for the read-only report detail screen. The existing column-level
-- grant on receipt_ocr_results still excludes error_message (internal
-- backend diagnostic detail, unchanged) - this migration does not touch
-- that grant, so error_message remains unreadable by anyone through the
-- Supabase client, admin included.
create policy "Admins can view all OCR results"
  on public.receipt_ocr_results
  for select
  to authenticated
  using (public.is_admin());

create policy "Admins can view all OCR lines"
  on public.receipt_ocr_lines
  for select
  to authenticated
  using (public.is_admin());

-- ------------------------------------------------------------------------
-- receipt_line_matches: admins may read match results for any report. The
-- existing column-level grant still excludes review_note (unchanged) - see
-- 007_create_product_matching.sql. Extending that grant is out of scope for
-- this read-only stage; it would require a role-aware access path (e.g. a
-- SECURITY DEFINER RPC) since Postgres column grants are not row/policy
-- specific, and a blanket grant would also make review_note selectable by a
-- customer reading their own otherwise-visible row.
create policy "Admins can view all receipt line matches"
  on public.receipt_line_matches
  for select
  to authenticated
  using (public.is_admin());

-- ------------------------------------------------------------------------
-- storage.objects (receipts bucket): admins may read (and therefore create
-- signed URLs for) any receipt file, needed for thumbnail previews in the
-- review queue/detail screen. Additive alongside the existing
-- "Authenticated users can view receipts in their own folder" policy from
-- 002_create_purchase_reports.sql - a normal user's own storage access is
-- unchanged.
create policy "Admins can view any receipt in storage"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'receipts'
    and public.is_admin()
  );
