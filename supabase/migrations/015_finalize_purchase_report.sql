-- Unified one-click initial review workflow: replaces the fragmented
-- three-step admin flow (save manual items -> approve -> award points) with
-- a single atomic action, "אישור וסיום טיפול", for the NORMAL review case
-- (a report still 'submitted' or 'needs_review').
--
-- This migration deliberately creates exactly ONE new function,
-- public.finalize_purchase_report(p_report_id, p_items), and reuses the
-- three existing, already-hardened functions instead of duplicating their
-- logic:
--   - public.save_manual_receipt_items() (011, extended 014) - validates
--     and atomically replaces the manual item set, including
--     is_golden_light.
--   - public.award_purchase_points() (013, replaced 014) - calculates the
--     eligible total from is_golden_light rows, computes
--     floor(eligible_total * 0.2), inserts the points_transactions row, and
--     increments profiles.points_balance.
--   - public.is_admin() (008) - the authorization check both of the above
--     already perform.
--
-- public.review_purchase_report() (010) is UNCHANGED and remains the only
-- way to reject a report - rejection stays a separate, simpler action that
-- never touches receipt_manual_items or points, exactly as before. Its
-- 'approved' decision path also still exists at the database level (kept,
-- not dropped, since nothing about it is unsafe), but the admin UI no
-- longer calls it for the normal review flow - see supabase/README.md for
-- the full rationale.

-- ------------------------------------------------------------------------
-- public.finalize_purchase_report(p_report_id, p_items): the single action
-- behind "אישור וסיום טיפול". security definer, set search_path = '' (same
-- convention as every other definer function in this schema).
--
-- The client sends ONLY the report id and the final item list - never
-- points, points_awarded, an eligible total, reviewed_by, reviewed_at, or
-- any other authoritative value.
--
--   1. Requires public.is_admin() - checked first, before touching any row.
--   2. Locks the target purchase_reports row with `for update` immediately
--      - this is the concurrency boundary for the whole operation: a second
--      near-simultaneous finalize call for the same report blocks here
--      until the first commits, then re-reads the now-'approved' status and
--      correctly fails with 'report_not_reviewable' rather than finalizing
--      twice.
--   3. Requires the report to exist.
--   4. Requires status to be exactly 'submitted' or 'needs_review' -
--      'report_not_reviewable' otherwise (already approved, already
--      rejected, or still 'processing').
--   5. Calls public.save_manual_receipt_items(p_report_id, p_items) to
--      validate every item and atomically replace the report's manual item
--      set (including is_golden_light) - identical validation/behavior as
--      the existing manual-entry feature, not reimplemented here.
--   6. Marks the report approved: status = 'approved', reviewed_at =
--      now(), reviewed_by = auth.uid(), rejection_reason = null.
--   7. Calls public.award_purchase_points(p_report_id), which independently
--      re-verifies is_admin() and status = 'approved' (both already true at
--      this point), sums the just-saved is_golden_light rows, computes
--      floor(eligible_total * 0.2), and raises 'no_eligible_amount' or
--      'no_points_to_award' if the result isn't a real positive award -
--      exactly the "do not silently award zero points" rule. It also
--      independently guards against a duplicate 'purchase_reward' row
--      (impossible in the normal flow, since the report was just
--      'submitted'/'needs_review' a moment ago, but checked anyway as
--      defense in depth) and performs the points_transactions insert,
--      purchase_reports.points_awarded update, and
--      profiles.points_balance increment.
--
-- Because every one of these steps runs inside this single function call -
-- one Postgres transaction - an exception raised at ANY step (invalid item,
-- no eligible amount, zero points, a duplicate, ...) aborts and rolls back
-- the entire call, including the manual-items replace and the status
-- change from step 6. There is no code path that can leave items saved but
-- the report unapproved, or the report approved but points not awarded.
create or replace function public.finalize_purchase_report(
  p_report_id uuid,
  p_items jsonb
)
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

  v_points := public.award_purchase_points(p_report_id);

  return v_points;
end;
$$;

revoke execute on function public.finalize_purchase_report(uuid, jsonb) from anon;
revoke execute on function public.finalize_purchase_report(uuid, jsonb) from public;
-- Granted broadly to `authenticated` on purpose, same reasoning as every
-- other admin RPC in this schema - there is no separate Postgres role for
-- admins; authorization happens inside the function (step 1 above).
grant execute on function public.finalize_purchase_report(uuid, jsonb) to authenticated;
