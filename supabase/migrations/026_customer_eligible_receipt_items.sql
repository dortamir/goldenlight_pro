-- Customer receipt detail refinement: the customer-facing "products" list on
-- PurchaseReportDetailsScreen must show ONLY the confirmed Golden Light
-- items that actually contributed to points - i.e. exactly the rows
-- public.award_purchase_points() (019_product_matching_manual_items.sql)
-- itself sums into eligible_total: receipt_manual_items rows with
-- match_status = 'matched', for this report. Before this migration, the
-- customer screen showed every saved receipt_manual_items row regardless of
-- match_status (unresolved/not_golden_light included), which could visually
-- imply a row earned points when it did not.
--
-- Migration 025 (already live) deliberately narrowed the customer/admin-
-- shared `authenticated` role's direct SELECT grant on receipt_manual_items
-- to a fixed safe column list that does NOT include match_status,
-- product_id, match_type, match_confidence, or is_golden_light - so the
-- customer client cannot filter by match_status itself, by design. This
-- migration does not touch that grant (still exactly id, purchase_report_id,
-- line_index, description, sku, quantity, unit_price, line_total) and does
-- not add match_status or any other internal column to it. Instead, it adds
-- one new, narrowly-scoped SECURITY DEFINER function that performs the
-- match_status = 'matched' filter SERVER-SIDE and returns only the same
-- safe display columns the customer already had access to - the customer
-- never gains any new column-level visibility, only a pre-filtered ROW set
-- of a shape they could already fully see per-row.
--
-- public.get_my_eligible_receipt_items(p_report_id): the customer's own
-- read path for this. Ownership is enforced by joining to purchase_reports
-- and requiring pr.user_id = auth.uid() - the exact same ownership
-- condition every existing customer-facing RLS policy in this schema
-- already uses (e.g. purchase_reports' own "Users can view their own
-- purchase reports" policy, 002_create_purchase_reports.sql). A report
-- that does not exist and a report that exists but belongs to someone else
-- both simply resolve to zero rows - no exception, no distinguishable
-- error - matching this schema's established "never leak whether a
-- resource exists" convention (see purchase_reports' own RLS: a customer
-- requesting another user's report id resolves to "not found," never a
-- separate "exists but denied" state). `stable` (not the default
-- `volatile`) matches public.is_admin()'s own convention - this function
-- has no side effects and its result cannot change within one statement.
-- `set search_path = ''` follows the same convention as every other
-- SECURITY DEFINER function in this schema, which is why every table
-- reference below is fully schema-qualified.
--
-- This is a genuinely customer-facing (not admin-gated) SECURITY DEFINER
-- function - the first one in this schema. It does not call
-- public.is_admin() because it is not an admin-only read; it is scoped by
-- ownership instead, exactly like every other customer-facing read in this
-- app. It grants no elevated write access of any kind (no INSERT/UPDATE/
-- DELETE anywhere in this function), and does not change what an admin
-- session can do - adminReportService.js is untouched by this migration.
create or replace function public.get_my_eligible_receipt_items(p_report_id uuid)
returns table (
  id uuid,
  description text,
  sku text,
  quantity numeric,
  unit_price numeric,
  line_total numeric,
  line_index integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    item.id,
    item.description,
    item.sku,
    item.quantity,
    item.unit_price,
    item.line_total,
    item.line_index
  from public.receipt_manual_items item
  join public.purchase_reports pr on pr.id = item.purchase_report_id
  where item.purchase_report_id = p_report_id
    and item.match_status = 'matched'
    and pr.user_id = auth.uid()
  order by item.line_index asc;
$$;

revoke execute on function public.get_my_eligible_receipt_items(uuid) from anon;
revoke execute on function public.get_my_eligible_receipt_items(uuid) from public;
grant execute on function public.get_my_eligible_receipt_items(uuid) to authenticated;