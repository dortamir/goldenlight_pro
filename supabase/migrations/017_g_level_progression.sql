-- G Level: automatic customer membership-level progression.
--
-- We already had public.profiles.approved_purchases_count and
-- .membership_level (001_create_profiles.sql), set once at profile
-- creation and never touched again by anything else in this schema - no
-- trigger or function anywhere updates either column in response to a
-- purchase_reports status change (verified by inspecting every prior
-- migration before writing this one). This migration is what actually
-- keeps them correct going forward, and syncs every existing profile once,
-- immediately, as part of the migration itself.
--
-- Renames the concept from "PLATINUM" (defined in the app's color tokens
-- for completeness, but never a real reachable level - see
-- src/theme/colors.js's own comment) to "TITANIUM", the fourth and current
-- maximum official G Level. No fifth level exists or is planned here.

-- ------------------------------------------------------------------------
-- public.recalculate_membership_level(p_user_id): the single source of
-- truth for keeping a profile's approved_purchases_count/membership_level
-- correct. Deliberately a RECOUNT from public.purchase_reports every time
-- it runs, never a client-supplied or incremented value - this is what
-- makes it safe to call repeatedly (idempotent) and immune to drift:
-- calling it twice for the same user produces the same result as calling
-- it once, calling it for a user who already has the correct values is a
-- harmless no-op update, and there is no stored "already counted this
-- report" flag to get out of sync - the count is always freshly derived
-- from real, current purchase_reports rows.
--
-- Internal helper only - NOT granted to anon or authenticated (see the
-- explicit revokes below). It is only ever reachable via a nested call
-- from another SECURITY DEFINER function already gated by
-- public.is_admin() (public.finalize_purchase_report(),
-- public.review_purchase_report() - both updated below), which is
-- sufficient privilege to execute it regardless of grants. No client, admin
-- or customer, can call this directly - the admin never manually selects a
-- G Level, and the customer never manually changes one.
create or replace function public.recalculate_membership_level(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_approved_count integer;
  v_level text;
begin
  select count(*)
  into v_approved_count
  from public.purchase_reports
  where user_id = p_user_id
    and status = 'approved';

  -- Official G Level thresholds, based ONLY on the real approved-report
  -- count above - never submitted/processing/needs_review/rejected reports.
  --   Bronze:   0-11
  --   Silver:   12-23
  --   Gold:     24-35
  --   Titanium: 36+ (current maximum - no level exists above this)
  v_level := case
    when v_approved_count >= 36 then 'TITANIUM'
    when v_approved_count >= 24 then 'GOLD'
    when v_approved_count >= 12 then 'SILVER'
    else 'BRONZE'
  end;

  update public.profiles
  set approved_purchases_count = v_approved_count,
      membership_level = v_level
  where id = p_user_id;
end;
$$;

revoke execute on function public.recalculate_membership_level(uuid) from anon;
revoke execute on function public.recalculate_membership_level(uuid) from authenticated;
revoke execute on function public.recalculate_membership_level(uuid) from public;

-- ------------------------------------------------------------------------
-- public.finalize_purchase_report(): identical to 015/016's version in
-- every other respect (still is_admin()-gated, still locks the report row,
-- still requires 'submitted'/'needs_review', still delegates to
-- save_manual_receipt_items()/award_purchase_points() exactly as before).
-- The ONLY addition is a call to recalculate_membership_level() for the
-- report's owner immediately after the status flips to 'approved' - inside
-- the SAME transaction as everything else in this function, so if any
-- later step fails (no eligible amount, zero points, ...) the level
-- recalculation rolls back together with the rest of the call. This is
-- exactly what step 3/4 of the "one-click review flow" now includes:
-- approve -> award points -> update approved count -> recalculate G Level,
-- all as part of this one atomic admin action - no separate button, no
-- admin-selected level.
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

  perform public.recalculate_membership_level(v_report.user_id);

  v_points := public.award_purchase_points(p_report_id);

  return v_points;
end;
$$;

revoke execute on function public.finalize_purchase_report(uuid, jsonb) from anon;
revoke execute on function public.finalize_purchase_report(uuid, jsonb) from public;
grant execute on function public.finalize_purchase_report(uuid, jsonb) to authenticated;

-- ------------------------------------------------------------------------
-- public.review_purchase_report(): identical to 010's version in every
-- other respect. Its 'approved' decision path is not used by the current
-- admin UI (finalize_purchase_report() is), but it still exists at the
-- database level and remains a legitimate way for a report to become
-- 'approved' - so it gets the same recalculate_membership_level() call, on
-- the 'approved' path only, for consistency: approved_purchases_count/
-- membership_level must always reflect reality regardless of which
-- function actually performed the approval. The 'rejected' path is
-- completely unchanged - rejection never counts toward G Level.
create or replace function public.review_purchase_report(
  p_report_id uuid,
  p_decision text,
  p_rejection_reason text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_user_id uuid;
  v_trimmed_reason text;
begin
  if not public.is_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;

  if p_decision not in ('approved', 'rejected') then
    raise exception 'invalid_decision' using errcode = '22023';
  end if;

  select status, user_id into v_status, v_user_id
  from public.purchase_reports
  where id = p_report_id
  for update;

  if not found then
    raise exception 'report_not_found' using errcode = 'P0002';
  end if;

  if v_status not in ('submitted', 'needs_review') then
    raise exception 'report_not_reviewable' using errcode = '40001';
  end if;

  if p_decision = 'rejected' then
    v_trimmed_reason := nullif(btrim(p_rejection_reason), '');

    if v_trimmed_reason is null then
      raise exception 'rejection_reason_required' using errcode = '22023';
    end if;

    if length(v_trimmed_reason) > 1000 then
      raise exception 'rejection_reason_too_long' using errcode = '22023';
    end if;
  else
    v_trimmed_reason := null;
  end if;

  update public.purchase_reports
  set
    status = p_decision,
    reviewed_at = now(),
    reviewed_by = auth.uid(),
    rejection_reason = v_trimmed_reason
  where id = p_report_id;

  if p_decision = 'approved' then
    perform public.recalculate_membership_level(v_user_id);
  end if;

  return p_decision;
end;
$$;

revoke execute on function public.review_purchase_report(uuid, text, text) from anon;
revoke execute on function public.review_purchase_report(uuid, text, text) from public;
grant execute on function public.review_purchase_report(uuid, text, text) to authenticated;

-- ------------------------------------------------------------------------
-- Backfill: synchronize every existing profile immediately, so real
-- historical approved reports are reflected in G Level right after this
-- migration runs - no manual per-user fix-up required. Safe to run more
-- than once (recalculate_membership_level() is idempotent).
select public.recalculate_membership_level(id) from public.profiles;

-- ------------------------------------------------------------------------
-- Explicit, defense-in-depth constraint on the actual set of valid G Level
-- values - added AFTER the backfill above so it can never fail against
-- stale data. No CHECK constraint existed on this column before
-- (001_create_profiles.sql only set a default). Every current row is
-- already one of these four values by this point in the migration.
alter table public.profiles
  add constraint profiles_membership_level_valid
  check (membership_level in ('BRONZE', 'SILVER', 'GOLD', 'TITANIUM'));

-- ------------------------------------------------------------------------
-- Security confirmation (no grant changes needed): public.profiles' update
-- grant, set in 001_create_profiles.sql, has always been
-- `grant update (full_name, phone, profession) on table public.profiles to
-- authenticated` - a column-restricted grant that already excludes
-- approved_purchases_count/membership_level/points_balance entirely. A
-- direct `.from('profiles').update({ membership_level: ... })` call from
-- any client, customer or admin, is rejected by Postgres before it could
-- ever reach a row - this migration does not touch that grant, and both
-- columns remain writable ONLY through recalculate_membership_level()
-- above, which is itself unreachable except from inside
-- finalize_purchase_report()/review_purchase_report()'s approved path.
