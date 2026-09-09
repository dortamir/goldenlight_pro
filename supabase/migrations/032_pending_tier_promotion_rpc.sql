-- Stage 32.4.2: fixes 42501 ("permission denied for table purchase_reports")
-- raised when HomeScreen's new pending-tier-promotion check (Stage 32.4)
-- runs a plain `.from('purchase_reports').select('id, promoted_to_tier,
-- reviewed_at')...` as the signed-in customer.
--
-- ROOT CAUSE (verified from the actual deployed migrations, not assumed):
-- 002_create_purchase_reports.sql originally gave `authenticated` a
-- WHOLE-TABLE `grant select on table public.purchase_reports` - under that
-- grant, Stage 32.4's plain select would have worked fine. But
-- 025_customer_column_grant_hardening.sql later replaced that with:
--
--   revoke select on table public.purchase_reports from authenticated;
--   grant select (
--     id, user_id, receipt_path, original_filename, status, points_awarded,
--     rejection_reason, created_at, updated_at, reviewed_at
--   ) on table public.purchase_reports to authenticated;
--
-- - a column-restricted grant, deliberately narrowed (025's own stated
-- purpose) to exactly the columns purchaseReportService.js/
-- adminReportService.js actually read AT THE TIME 025 was written. Two
-- columns did not exist yet when 025 was written and were added six
-- migrations later by 031_membership_tier_rewards.sql:
-- `promoted_to_tier`/`promotion_acknowledged_at`. 031's own comment
-- (line ~113-116) claimed these would be "readable by the report's own
-- owner through the existing whole-table SELECT grant/RLS ownership
-- policy (002_create_purchase_reports.sql) - no new grant needed" - that
-- reasoning was accurate about RLS (RLS is unaffected by column grants;
-- 002's ownership policy still evaluates correctly) but WRONG about the
-- grant itself, because it was written as if 002's whole-table grant was
-- still the live one, without accounting for 025 having already replaced
-- it with a column list that these two new columns were never added to.
-- Postgres reports a column-privilege shortfall on ANY multi-column SELECT
-- as a single, table-level `permission denied for table ...` (42501) -
-- it does not name the specific missing column - which is exactly the
-- error Stage 32.4.1's runtime diagnostics captured.
--
-- IMPORTANT RELATED FINDING (not fixed by this migration - out of this
-- stage's scope, flagged for a prompt follow-up): purchaseReportService.js's
-- existing getPurchaseReportById() - used by PurchaseReportDetailsScreen,
-- i.e. the ORIGINAL Stage 32 celebration trigger, live since 031 was
-- deployed - selects these exact same two columns in a single combined
-- query alongside id/status/etc. Since a Postgres column-privilege
-- shortfall fails the ENTIRE select, not just the offending columns, that
-- existing call is presumably ALSO currently raising 42501 for every
-- customer opening ANY purchase report detail screen (not only a promoted
-- one) - the same root cause as this migration fixes for Home, just on a
-- different, already-shipped call site. This migration deliberately does
-- NOT touch getPurchaseReportById() or PurchaseReportDetailsScreen (out of
-- explicit scope this stage) - see this stage's final report.
--
-- FIX CHOSEN: rather than widen 025's column grant again (which 025 itself
-- was written specifically to narrow, and which would hand the client
-- broad ad-hoc SELECT/WHERE/ORDER BY access over promoted_to_tier for
-- every one of their own rows, not just "is there one pending promotion"),
-- this migration adds a narrowly-scoped, purpose-built SECURITY DEFINER
-- RPC - the same pattern already used throughout this schema
-- (get_my_eligible_receipt_items() in 026, acknowledge_tier_promotion()
-- itself in 031) whenever a customer needs a read that's narrower or
-- differently-shaped than a raw column grant would allow. A SECURITY
-- DEFINER function runs with its OWNER's table privileges, not the
-- calling role's own grants, so it needs no column grant on
-- purchase_reports at all - narrowing, not widening, customer-facing
-- exposure of this table.
--
-- public.get_my_pending_tier_promotion(): takes NO parameters - identity
-- comes exclusively from auth.uid(), so a caller can never request another
-- customer's promotion by passing a different id (there is no id
-- parameter to pass in the first place). Returns at most one row:
-- report_id, promoted_to_tier, reviewed_at - no receipt path, no OCR data,
-- no amounts, no admin metadata, nothing about any other customer. Filters
-- exactly promoted_to_tier is not null and promotion_acknowledged_at is
-- null, ordered reviewed_at asc (oldest unacknowledged promotion first,
-- unchanged reasoning from Stage 32.4) with id as a tie-breaker for full
-- determinism if two rows ever shared an identical reviewed_at, limit 1.
-- stable (read-only, no side effects - same qualifier as get_admin_users()/
-- other pure-read RPCs in this schema). This function does not read or
-- write promotion_acknowledged_at's write path at all - acknowledging
-- remains exclusively acknowledge_tier_promotion()'s job, completely
-- unchanged by this migration.
create or replace function public.get_my_pending_tier_promotion()
returns table (
  report_id uuid,
  promoted_to_tier text,
  reviewed_at timestamptz
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
      pr.promoted_to_tier,
      pr.reviewed_at
    from public.purchase_reports pr
    where pr.user_id = v_caller_id
      and pr.promoted_to_tier is not null
      and pr.promotion_acknowledged_at is null
    order by pr.reviewed_at asc, pr.id asc
    limit 1;
end;
$$;

revoke execute on function public.get_my_pending_tier_promotion() from anon;
revoke execute on function public.get_my_pending_tier_promotion() from public;
grant execute on function public.get_my_pending_tier_promotion() to authenticated;
