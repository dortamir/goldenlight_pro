-- Stage 32.7.1: fixes 42501 ("permission denied for table purchase_reports")
-- raised when a customer opens PurchaseReportDetailsScreen - confirmed via
-- physical runtime diagnostics ([InvoiceDetailDiag]): navigation/routing
-- were proven correct, and the error occurs exactly at
-- purchaseReportService.js's getPurchaseReportById(), a plain
-- `.from('purchase_reports').select(...)` call.
--
-- ROOT CAUSE (same class of bug already fixed once this session for a
-- different call site - see 032_pending_tier_promotion_rpc.sql):
-- 025_customer_column_grant_hardening.sql narrowed the customer-facing
-- SELECT grant on purchase_reports to an explicit column list:
--
--   grant select (
--     id, user_id, receipt_path, original_filename, status, points_awarded,
--     rejection_reason, created_at, updated_at, reviewed_at
--   ) on table public.purchase_reports to authenticated;
--
-- `promoted_to_tier`/`promotion_acknowledged_at` were added six migrations
-- later by 031_membership_tier_rewards.sql, whose own comment incorrectly
-- assumed the ORIGINAL whole-table grant (002_create_purchase_reports.sql)
-- was still active - it was not, 025 had already replaced it. Unlike
-- get_my_pending_tier_promotion() (032), getPurchaseReportById() was never
-- migrated off the plain select at the time - this migration closes that
-- gap using the exact same pattern.
--
-- FIX: a new SECURITY DEFINER RPC, narrowly scoped to exactly what
-- PurchaseReportDetailsScreen actually reads (verified directly against
-- both that screen and purchaseReportService.js before writing this, not
-- assumed from the old select list) - no table grant is widened, and no
-- historical migration is touched.
--
-- COLUMN SET VERIFIED AGAINST ACTUAL USAGE: id, original_filename,
-- receipt_path, status, points_awarded, rejection_reason, created_at,
-- promoted_to_tier, promotion_acknowledged_at - every one of these is read
-- somewhere in PurchaseReportDetailsScreen.js (report.id, .original_filename,
-- .receipt_path, .status, .points_awarded, .rejection_reason, .created_at,
-- .promoted_to_tier, .promotion_acknowledged_at). `updated_at` - present in
-- the OLD select list - was deliberately dropped here: a full search of
-- PurchaseReportDetailsScreen.js found no reference to it anywhere: it was
-- unused. This mirrors 025's own stated philosophy ("narrow every grant to
-- exactly what was found in use") applied to this RPC's return shape
-- instead of a table grant.
--
-- SECURITY: takes only p_report_id - no user_id parameter exists for a
-- client to pass, so identity can only ever come from auth.uid(). A report
-- that exists but belongs to another customer, or doesn't exist at all,
-- resolves to zero rows (not an error) - the exact same "not found" shape
-- getPurchaseReportById()'s callers already handle via .maybeSingle(),
-- preserving that contract with no client-code behavior change beyond the
-- data-access method itself.
create or replace function public.get_my_purchase_report(p_report_id uuid)
returns table (
  id uuid,
  original_filename text,
  receipt_path text,
  status text,
  points_awarded integer,
  rejection_reason text,
  created_at timestamptz,
  promoted_to_tier text,
  promotion_acknowledged_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_caller_id uuid;
begin
  v_caller_id := auth.uid();

  if v_caller_id is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  return query
    select
      pr.id,
      pr.original_filename,
      pr.receipt_path,
      pr.status,
      pr.points_awarded,
      pr.rejection_reason,
      pr.created_at,
      pr.promoted_to_tier,
      pr.promotion_acknowledged_at
    from public.purchase_reports pr
    where pr.id = p_report_id
      and pr.user_id = v_caller_id;
end;
$$;

revoke execute on function public.get_my_purchase_report(uuid) from anon;
revoke execute on function public.get_my_purchase_report(uuid) from public;
grant execute on function public.get_my_purchase_report(uuid) to authenticated;
