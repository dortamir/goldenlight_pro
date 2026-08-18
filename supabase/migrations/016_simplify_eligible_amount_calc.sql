-- Simplifies the admin manual-review workflow's row structure: the admin
-- form no longer collects sku or line_total (see AdminReportDetailScreen -
-- each row now shows only description, quantity, unit_price, and the
-- "מוצר Golden Light" checkbox). This migration updates the ONE place that
-- calculates eligible amounts (public.award_purchase_points(), called both
-- directly by finalize_purchase_report() and as the legacy fallback award
-- path - see 015_finalize_purchase_report.sql) so the database-authoritative
-- calculation actually matches what the simplified form produces, instead
-- of relying on line_total merely happening to always be null from now on.
--
-- receipt_manual_items.sku and receipt_manual_items.line_total are NOT
-- dropped by this migration - both columns, and any existing historical row
-- data in them, remain exactly as they are. This migration only changes
-- which columns public.award_purchase_points() reads when computing the
-- eligible total; it is not a schema change and does not touch any existing
-- row. A future OCR/matching stage may still populate and use line_total
-- for its own purposes - that remains entirely possible, just not part of
-- today's manual-review eligibility calculation.

-- ------------------------------------------------------------------------
-- public.award_purchase_points(p_report_id): identical in every other
-- respect to migration 014's version (still security definer, still
-- is_admin()-gated, still locks the report row, still requires 'approved',
-- still prevents duplicate awards, still floors at 0.2, still atomically
-- writes points_transactions/purchase_reports/profiles). The ONLY change is
-- the per-row eligible-amount expression: previously
-- `coalesce(line_total, case when quantity is not null and unit_price is
-- not null then quantity * unit_price else null end)` (line_total
-- preferred when present); now simply `case when quantity is not null and
-- unit_price is not null then quantity * unit_price else null end` -
-- line_total is no longer read at all. A row with quantity or unit_price
-- missing (regardless of any line_total value it might still carry from
-- before this change) contributes 0, exactly matching the simplified
-- form's own "quantity and unit price are the only inputs" rule.
create or replace function public.award_purchase_points(
  p_report_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_report public.purchase_reports;
  v_eligible_total numeric;
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

  if v_report.status <> 'approved' then
    raise exception 'report_not_approved' using errcode = '40001';
  end if;

  if exists (
    select 1
    from public.points_transactions
    where purchase_report_id = p_report_id
      and transaction_type = 'purchase_reward'
  ) then
    raise exception 'points_already_awarded' using errcode = '40001';
  end if;

  select coalesce(sum(
    case
      when item.quantity is not null and item.unit_price is not null
        then item.quantity * item.unit_price
      else null
    end
  ), 0)
  into v_eligible_total
  from public.receipt_manual_items item
  where item.purchase_report_id = p_report_id
    and item.is_golden_light = true;

  if v_eligible_total is null or v_eligible_total <= 0 then
    raise exception 'no_eligible_amount' using errcode = '22023';
  end if;

  v_points := floor(v_eligible_total * 0.2);

  if v_points <= 0 then
    raise exception 'no_points_to_award' using errcode = '22023';
  end if;

  insert into public.points_transactions (
    user_id,
    purchase_report_id,
    transaction_type,
    points,
    eligible_pre_vat_amount,
    created_by
  )
  values (
    v_report.user_id,
    p_report_id,
    'purchase_reward',
    v_points,
    v_eligible_total,
    auth.uid()
  );

  update public.purchase_reports
  set points_awarded = v_points
  where id = p_report_id;

  update public.profiles
  set points_balance = points_balance + v_points
  where id = v_report.user_id;

  return v_points;
end;
$$;

revoke execute on function public.award_purchase_points(uuid) from anon;
revoke execute on function public.award_purchase_points(uuid) from public;
grant execute on function public.award_purchase_points(uuid) to authenticated;
