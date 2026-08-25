-- Admin Finalization & Points Safety - Stage 5.
--
-- Narrowly scoped: this migration changes exactly one thing -
-- public.finalize_purchase_report() gains a single additional guard that
-- blocks finalization while any saved receipt_manual_items row for the
-- report is still 'unresolved' (i.e. the admin has not yet explicitly
-- decided it is a matched Golden Light product OR explicitly marked it
-- 'not_golden_light'). No new table, no new column, no new state - the
-- existing three-state match_status model (011/019) already distinguishes
-- "not yet decided" (unresolved) from both real decisions, this migration
-- only makes finalize_purchase_report() itself require that every row it
-- is about to approve has actually been decided.
--
-- Everything else about the finalization/points pipeline was inspected and
-- found already correct, so nothing else changes:
--   - Duplicate-award protection is already complete: finalize_purchase_
--     report()/award_purchase_points() both `select ... for update` the
--     purchase_reports row (serializing any two concurrent calls for the
--     same report), award_purchase_points() re-checks
--     `not exists (select 1 from points_transactions where
--     purchase_report_id = ... and transaction_type = 'purchase_reward')`
--     before inserting, and - independent of both of those -
--     idx_points_transactions_one_purchase_reward_per_report (a genuine
--     partial UNIQUE INDEX on points_transactions (purchase_report_id)
--     where transaction_type = 'purchase_reward', already live) makes a
--     second purchase-reward row for the same report physically
--     impossible at the database level regardless of any future
--     application-logic change. No new index/constraint is needed.
--   - Points are already computed only from the ADMIN-SAVED
--     receipt_manual_items rows (match_status = 'matched'), specifically
--     `floor(sum(quantity * unit_price) * 0.2)` - never from
--     receipt_ocr_lines/receipt_line_matches/normalized_* columns/OCR
--     confidence. save_manual_receipt_items() already independently
--     re-validates every field itself, so the admin's actually-saved
--     values (not whatever OCR originally suggested) are what
--     award_purchase_points() sums.
--   - finalize_purchase_report() is already one single SECURITY DEFINER
--     function (save items -> require resolution [new] -> approve ->
--     recalculate membership -> award points), so it was already fully
--     atomic - any failure at any step (including this new check) already
--     rolled back the whole call, with no partial state ever committed.
--   - Rejection (review_purchase_report) already never touches
--     receipt_manual_items/points_transactions/profiles.points_balance/
--     approved_purchases_count, so this migration does not touch it.
--   - A report with zero eligible amount already cannot be finalized at
--     all today - award_purchase_points() already raises
--     'no_eligible_amount'/'no_points_to_award', which (being inside the
--     same transaction as everything above) already rolls back the whole
--     finalize_purchase_report() call, leaving the report exactly as it
--     was (still reviewable, no partial save). This migration does not
--     change that existing behavior - seeing this bullet in a Stage 5
--     migration is a deliberate confirmation that it was not silently
--     "improved" here, not an oversight.
--
-- No signature/return-type change (still (uuid, jsonb) -> integer), so a
-- plain CREATE OR REPLACE is sufficient - unlike get_admin_ocr_lines() in
-- 022, no explicit DROP FUNCTION is needed here, and every existing grant
-- (EXECUTE to authenticated, gated internally by is_admin() as always)
-- carries over unchanged.
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

  -- Stage 5: admin review is the authority, and finalization means "the
  -- admin's review of this receipt is complete" - a row still sitting at
  -- the default 'unresolved' status (see receipt_manual_items_match_status_
  -- check, 011/019) means no decision was ever made about it, matched or
  -- otherwise. Blocking here (after the rows are validated by
  -- save_manual_receipt_items() above, so we're checking the real,
  -- just-saved state) stops a half-reviewed receipt from becoming
  -- permanently 'approved' with an item nobody ever actually looked at.
  -- A row the admin doesn't want to deal with can still be removed
  -- entirely (the existing "remove row" UI action) or explicitly marked
  -- 'not_golden_light' - both already-existing, already-valid final
  -- states; this does not require or invent anything new.
  if exists (
    select 1
    from public.receipt_manual_items
    where purchase_report_id = p_report_id
      and match_status = 'unresolved'
  ) then
    raise exception 'unresolved_items_remain' using errcode = '40001';
  end if;

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