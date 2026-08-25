-- Admin Finalization & Points Safety - Stage 5 correction.
--
-- Business decision: unresolved receipt_manual_items rows must NOT block
-- finalization. 023_finalize_requires_resolved_items.sql added a guard to
-- public.finalize_purchase_report() that raised 'unresolved_items_remain'
-- whenever any saved row was still match_status = 'unresolved'. That guard
-- is removed here - it is confirmed live (023 has already been applied),
-- so this is a genuine behavior change via CREATE OR REPLACE, not an edit
-- to the already-applied 023 file itself.
--
-- New (permanent) rule, unchanged from the existing points model - nothing
-- about eligibility itself changes, only whether an unresolved row is
-- allowed to coexist with a finalized report:
--   - match_status = 'matched'         -> counts toward the eligible total
--                                          (award_purchase_points(), untouched).
--   - match_status = 'unresolved'      -> allowed to remain on a finalized
--                                          report; contributes 0 points.
--   - match_status = 'not_golden_light' -> allowed; contributes 0 points.
-- This was already exactly how award_purchase_points() computed eligibility
-- (`where match_status = 'matched'`, unchanged, not touched by this
-- migration) - the only thing 023 added, and this migration removes, was a
-- separate gate on whether finalize_purchase_report() would even reach
-- that calculation while an unresolved row existed.
--
-- Everything else about finalize_purchase_report() is byte-for-byte
-- identical to the live (023) version: admin authorization, the
-- `for update` report lock, the reviewable-status check,
-- save_manual_receipt_items(), the approval update, recalculate_membership_
-- level(), award_purchase_points(), and the fact that all of this remains
-- one atomic SECURITY DEFINER call. Duplicate-award protection is
-- untouched (the `for update` lock + award_purchase_points()'s own
-- `not exists` check + the idx_points_transactions_one_purchase_reward_
-- per_report partial unique index all live entirely outside this
-- function's body and are not modified by removing this guard).
--
-- No signature/return-type change (still (uuid, jsonb) -> integer), so a
-- plain CREATE OR REPLACE is sufficient - no DROP FUNCTION, no re-grant;
-- the existing EXECUTE grant to authenticated (gated internally by
-- is_admin(), as always) carries over unchanged.
create or replace function public.finalize_purchase_report(p_report_id uuid, p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_report public.purchase_reports;
  v_points integer;
begin
  if not public.is_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;

  select * into v_report
  from public.purchase_reports
  where id = p_report_id
  for update;

  if not found then
    raise exception 'report_not_found' using errcode = 'P0002';
  end if;

  if v_report.status not in ('submitted', 'needs_review') then
    raise exception 'report_not_reviewable' using errcode = '40001';
  end if;

  perform public.save_manual_receipt_items(p_report_id, p_items);

  update public.purchase_reports
  set status = 'approved',
      reviewed_at = now(),
      reviewed_by = auth.uid(),
      rejection_reason = null
  where id = p_report_id;

  perform public.recalculate_membership_level(v_report.user_id);

  v_points := public.award_purchase_points(p_report_id);

  return v_points;
end;
$$;