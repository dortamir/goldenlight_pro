-- Security grant hardening patch.
--
-- CONTEXT: Stage 9's security review found that row-level RLS on the
-- receipt/OCR tables is correct (every existing policy already scopes a
-- non-admin session to `pr.user_id = auth.uid()` - verified live, no
-- migration touches any of this), but the COLUMN-level `grant select`
-- given to the shared `authenticated` role on several tables is wider than
-- what the actual app (customer OR admin) reads. This migration narrows
-- those column grants to exactly what was found in use, table by table -
-- see the per-table comments below for the precise inventory. No RLS
-- policy is created, dropped, or altered anywhere in this file. No
-- INSERT/UPDATE/DELETE grant is touched (none of the affected tables give
-- `authenticated` any write access beyond the existing, unmodified
-- `purchase_reports` insert grant from 002_create_purchase_reports.sql).
-- `anon` already has zero SELECT access to any of these five tables
-- (verified live) and is not touched. `service_role` is a separate
-- grantee entirely and is unaffected by anything revoked from
-- `authenticated` here.
--
-- CRITICAL ACL MECHANIC THIS MIGRATION DEPENDS ON (verified live before
-- writing the final version of this file, not assumed): a column-level
-- `revoke select (col) on table t from role` only has any effect if that
-- role's access to the table came from a COLUMN-level grant in the first
-- place. If the role ALSO holds a broader `grant select on table t to
-- role` (no column list - i.e. every column, from `pg_class.relacl`),
-- that whole-table grant is a SEPARATE, ADDITIVE privilege - a column-
-- level revoke does NOT remove or narrow it, and the column remains
-- fully readable regardless. This was confirmed live (inspecting
-- pg_class.relacl directly, then empirically testing both cases as a
-- simulated customer session) while drafting this migration: three of
-- the five tables in scope (purchase_reports, receipt_ocr_lines,
-- receipt_manual_items) were created with a whole-table
-- `grant select ... to authenticated` (002_create_purchase_reports.sql /
-- receipt_ocr_lines' own foundation migration / 019_product_matching_
-- manual_items.sql respectively) - this is also, incidentally, the exact
-- reason 022_ocr_normalization.sql's own column-level revoke of
-- receipt_ocr_lines' Stage 2 columns never actually took effect (already
-- confirmed live during Stage 4 of this session, at the time attributed
-- to "something re-granted it" - it was actually never revoked to begin
-- with, for this exact reason). This migration does not edit 022 (an
-- already-applied migration) - instead, receipt_ocr_lines is fully closed
-- below via a table-level revoke, which supersedes and fully achieves
-- what 022 originally intended, using the correct mechanism.
--
-- For those three tables, this migration therefore does
-- `revoke select on table t from authenticated` (removing the whole-table
-- grant entirely) followed by an explicit
-- `grant select (safe, column, list) on table t to authenticated`
-- (re-adding back only the columns actually in use). The other two tables
-- (receipt_ocr_results, receipt_line_matches) never had a whole-table
-- grant - only column-level grants from their own origin migrations
-- (021_ocr_azure_document_intelligence.sql / 007_create_product_matching.sql)
-- - so a plain column-level revoke is correct and sufficient for those,
-- and was verified live to actually take effect (a revoked column
-- returns a real `permission denied for table ...` error, not a silent
-- success).
--
-- FOLLOW-UP (still inside this same, not-yet-applied migration - not a new
-- migration file, since 025 has never been deployed): the first version of
-- this migration left `receipt_ocr_results` and `receipt_line_matches`
-- with admin-required content columns (raw_text; product_id/match_status/
-- match_method/confidence/matched_text) still grant-readable by
-- `authenticated`, because adminReportService.js's getAdminReportDetail()
-- read both via a PLAIN `.from(...).select(...)` query rather than a
-- SECURITY DEFINER RPC - and, since admin and customer share the exact
-- same `authenticated` role with an unmodified customer-ownership RLS
-- policy on both tables, a customer could still reach those columns for
-- their own report. That gap is now closed: adminReportService.js's
-- receipt_ocr_results read was switched to the existing (previously
-- unused) SECURITY DEFINER get_admin_ocr_result() RPC
-- (021_ocr_azure_document_intelligence.sql - already is_admin()-gated and
-- already granted execute to authenticated, just never called until now),
-- and a new SECURITY DEFINER get_admin_receipt_line_matches() RPC (defined
-- below) replaces the plain receipt_line_matches select, additionally
-- absorbing the separate `products` sku/name lookup adminReportService.js
-- used to do as a second round trip. Both tables are now revoked to zero
-- direct SELECT for `authenticated` below - see each table's own section.
-- This, in turn, also removes the ONLY reason `receipt_ocr_lines` still
-- needed to keep `id`/`ocr_result_id` grant-readable (the cross-table RLS
-- policy on `receipt_line_matches` that joined through it, described
-- below) - since `receipt_line_matches` itself is now fully closed to
-- direct `authenticated` access, that join is never evaluated for a plain
-- session any more, so `receipt_ocr_lines` is now fully closed too.
--
-- Exact source of truth for every "what does X actually read" claim
-- below: a full grep of `\.from\('purchase_reports'\)`,
-- `\.from\('receipt_ocr_results'\)`, `\.from\('receipt_ocr_lines'\)`,
-- `\.from\('receipt_line_matches'\)`, and `\.from\('receipt_manual_items'\)`
-- across the entire src/ tree - confirmed exactly two files reference any
-- of these five tables at all: adminReportService.js and
-- purchaseReportService.js. Every .select()/.eq()/.in()/.order() column
-- each one actually references was read directly from the live file
-- before writing this migration, not inferred from the schema.

-- ---------------------------------------------------------------------
-- purchase_reports (had a whole-table grant - revoke-then-re-grant)
--
-- Customer (purchaseReportService.js): getMyPurchaseReports() - select('*')
-- - id/original_filename/receipt_path/status/points_awarded/created_at
-- actually read; getPurchaseReportById() - explicit
-- id/original_filename/receipt_path/status/points_awarded/rejection_reason/
-- created_at/updated_at; both .eq('user_id', ...) (requires user_id
-- itself to stay selectable - a WHERE-clause column reference needs
-- SELECT on that column same as a projected one).
--
-- Admin (adminReportService.js): getAdminReviewQueue()/getAdminReports() -
-- id/user_id/receipt_path/original_filename/status/points_awarded/
-- created_at; getAdminReportDetail() - the same plus reviewed_at/
-- rejection_reason/updated_at; getAdminDashboardSummary() - id/status only.
--
-- NEITHER caller ever selects admin_note or reviewed_by - both are safe
-- to drop entirely, with zero impact on any existing screen.
-- admin_note (002_create_purchase_reports.sql) has never been written by
-- any RPC/migration either (grepped) - always null today, dropped as a
-- latent-risk column regardless. reviewed_by is populated on every real
-- approval/rejection (finalize_purchase_report()/review_purchase_report())
-- and, before this migration, was readable by the OWNING customer via
-- their own existing getMyPurchaseReports()/select('*') call - confirmed
-- live before writing this migration by simulating that exact customer
-- session against a real reviewed report.
revoke select on table public.purchase_reports from authenticated;
grant select (
  id, user_id, receipt_path, original_filename, status, points_awarded,
  rejection_reason, created_at, updated_at, reviewed_at
) on table public.purchase_reports to authenticated;

-- ---------------------------------------------------------------------
-- receipt_ocr_lines (had a whole-table grant - now revoked to zero,
-- no re-grant at all)
--
-- No customer screen queries this table at all. The admin reads its real
-- CONTENT EXCLUSIVELY through the SECURITY DEFINER get_admin_ocr_lines()
-- RPC (021_ocr_azure_document_intelligence.sql/022_ocr_normalization.sql)
-- - confirmed no plain `.from('receipt_ocr_lines')` call exists anywhere
-- in adminReportService.js. A SECURITY DEFINER function runs with the
-- function OWNER's privileges, never the calling role's own table grants,
-- so narrowing this table's grant has zero effect on that RPC.
--
-- An earlier version of this migration kept `id`/`ocr_result_id` grant-
-- readable, discovered live to be structurally required at the time:
-- receipt_line_matches' own customer-ownership RLS policy ("Authenticated
-- users can view match results for their own purchase reports",
-- 007_create_product_matching.sql - completely UNCHANGED by this
-- migration) joins THROUGH receipt_ocr_lines (`... FROM
-- receipt_ocr_lines line JOIN receipt_ocr_results ocr ON ocr.id =
-- line.ocr_result_id ... WHERE line.id = receipt_line_matches.ocr_line_id
-- ...`), and RLS policy expressions are evaluated with the QUERYING
-- role's own privileges - so a fully-revoked receipt_ocr_lines used to
-- make that OTHER policy impossible to even evaluate for the plain
-- `authenticated` role, breaking the admin's then-plain
-- `.from('receipt_line_matches')` query. That plain query no longer
-- exists (see the receipt_line_matches section below - it now goes
-- through a SECURITY DEFINER RPC of its own), so that policy is never
-- evaluated for a plain `authenticated` session any more, and
-- receipt_ocr_lines can now be closed completely. Every piece of OCR
-- content (raw_text, raw_item, every *_confidence column, every Stage 2
-- normalized_*/normalization_* column) and both structural id columns are
-- revoked below - verified live (full end-to-end admin-flow re-test,
-- see this migration's test notes) that this does not break
-- get_admin_ocr_lines()/get_admin_receipt_line_matches().
revoke select on table public.receipt_ocr_lines from authenticated;

-- ---------------------------------------------------------------------
-- receipt_manual_items (had a whole-table grant - revoke-then-re-grant)
--
-- Customer (purchaseReportService.js): getReceiptManualItems() - explicit
-- id/description/sku/quantity/unit_price/line_total,
-- .eq('purchase_report_id', ...), .order('line_index', ...) (both also
-- require staying selectable, same WHERE/ORDER BY reasoning as above).
--
-- Admin reads this table EXCLUSIVELY through the SECURITY DEFINER
-- get_admin_manual_items() RPC (fetchManualItems() in
-- adminReportService.js, confirmed - no plain `.from('receipt_manual_items')`
-- select exists) - so, like receipt_ocr_lines above, narrowing this grant
-- has zero effect on the admin review screen.
--
-- Re-grants exactly: id, purchase_report_id, line_index, description,
-- sku, quantity, unit_price, line_total (everything getReceiptManualItems()
-- actually touches). Everything else - the match/internal columns - is
-- dropped entirely: none of them are ever selected by the customer app,
-- and (per 019_product_matching_manual_items.sql's own established
-- convention for created_by) internal admin-review state was never meant
-- to be customer-visible.
revoke select on table public.receipt_manual_items from authenticated;
grant select (
  id, purchase_report_id, line_index, description, sku, quantity,
  unit_price, line_total
) on table public.receipt_manual_items to authenticated;

-- ---------------------------------------------------------------------
-- receipt_ocr_results (column-level grants only, no whole-table grant -
-- now revoked to zero, no re-grant at all)
--
-- No customer screen queries this table. The admin previously read this
-- table via a PLAIN `.from('receipt_ocr_results')` query
-- (getAdminReportDetail(), adminReportService.js) selecting id, status,
-- provider, raw_text, processed_at - that call has been switched to the
-- existing SECURITY DEFINER get_admin_ocr_result(uuid) RPC
-- (021_ocr_azure_document_intelligence.sql - already is_admin()-gated,
-- already `grant execute ... to authenticated`, defined but never
-- actually called by any screen until this change), which runs with the
-- function owner's privileges and needs no table-level grant at all. With
-- no remaining plain query against this table, `authenticated` needs zero
-- direct SELECT on it.
revoke select on table public.receipt_ocr_results from authenticated;

-- ---------------------------------------------------------------------
-- receipt_line_matches (column-level grants only, no whole-table grant -
-- now revoked to zero, no re-grant at all)
--
-- No customer screen queries this table. The admin previously read this
-- table via a PLAIN `.from('receipt_line_matches')` query
-- (getAdminReportDetail(), adminReportService.js) selecting id,
-- ocr_line_id, product_id, match_status, match_method, confidence,
-- matched_text, filtered by `.in('ocr_line_id', ...)`, followed by a
-- second plain query against `products` to resolve each match's sku/name
-- - that two-query sequence has been replaced by a single call to the new
-- SECURITY DEFINER get_admin_receipt_line_matches(p_report_id) RPC
-- (defined below), which performs both the report-scoped match lookup
-- and the product sku/name join server-side and needs no table-level
-- grant on either table at all. review_note (internal admin diagnostic
-- text) was already correctly excluded from this table's very first
-- column-level grant (007_create_product_matching.sql) and was never
-- reachable by the customer/admin-shared role even before this
-- migration - noted here for completeness, not because anything new was
-- done to it. With no remaining plain query against this table,
-- `authenticated` needs zero direct SELECT on it.
revoke select on table public.receipt_line_matches from authenticated;

-- ---------------------------------------------------------------------
-- public.get_admin_receipt_line_matches(p_report_id): new SECURITY
-- DEFINER RPC, replacing adminReportService.js's former plain
-- `.from('receipt_line_matches')` select (see immediately above) and the
-- separate `products` sku/name lookup that used to follow it. Same
-- is_admin() gate, same security definer / search_path convention as
-- get_admin_ocr_lines()/get_admin_manual_items() elsewhere in this
-- schema. Report-scoped via p_report_id, joining
-- receipt_line_matches.ocr_line_id -> receipt_ocr_lines.id ->
-- receipt_ocr_results.purchase_report_id - the exact same join shape as
-- receipt_line_matches' own existing customer-ownership RLS policy
-- (007_create_product_matching.sql, unchanged), just evaluated inside
-- this function (which needs no grant of its own on either joined table,
-- being SECURITY DEFINER) instead of via a grant-dependent RLS
-- evaluation on the table itself. A normal customer calling this
-- function directly gets the same `not_admin` (42501) rejection every
-- other admin-gated RPC in this schema already gives - the internal
-- is_admin() check is authoritative regardless of what the caller passes
-- as p_report_id, including their own report's id.
create or replace function public.get_admin_receipt_line_matches(p_report_id uuid)
returns table (
  id uuid,
  ocr_line_id uuid,
  product_id uuid,
  match_status text,
  match_method text,
  confidence numeric,
  matched_text text,
  matched_product_sku text,
  matched_product_name text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;

  return query
  select
    m.id, m.ocr_line_id, m.product_id, m.match_status, m.match_method,
    m.confidence, m.matched_text,
    p.sku, p.name
  from public.receipt_line_matches m
  join public.receipt_ocr_lines l on l.id = m.ocr_line_id
  join public.receipt_ocr_results r on r.id = l.ocr_result_id
  left join public.products p on p.id = m.product_id
  where r.purchase_report_id = p_report_id
  order by l.line_index;
end;
$$;

revoke execute on function public.get_admin_receipt_line_matches(uuid) from anon;
revoke execute on function public.get_admin_receipt_line_matches(uuid) from public;
grant execute on function public.get_admin_receipt_line_matches(uuid) to authenticated;