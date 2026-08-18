-- Points Stage 1 rework: the admin no longer types a total eligible amount.
-- Points are now calculated ENTIRELY from receipt_manual_items rows the
-- admin has already entered/confirmed, specifically the ones marked as a
-- real Golden Light product via the new is_golden_light flag added below.
-- This replaces public.award_purchase_points(uuid, numeric) (migration 013)
-- with public.award_purchase_points(uuid) - the client sends only the
-- report id; every number used to compute points now comes from database
-- rows, never from JavaScript.
--
-- Still no OCR integration, no real product catalog/matching, no VAT
-- parsing, no membership-tier logic. is_golden_light is an explicit,
-- temporary, admin-confirmed substitute for real product matching - see
-- "Designed for future replacement" below.

-- ------------------------------------------------------------------------
-- receipt_manual_items.is_golden_light: per-row admin confirmation that a
-- manually-entered line is a real Golden Light product, and therefore
-- counts toward points eligibility. Defaults to false - a freshly-entered
-- row is never eligible until an admin explicitly marks it, matching the
-- existing "nothing is trusted/derived automatically" posture of this
-- entire manual-entry feature.
alter table public.receipt_manual_items
  add column if not exists is_golden_light boolean not null default false;

-- Hidden from every client role's plain SELECT, the same defense-in-depth
-- carve-out already used for receipt_manual_items.created_by (see
-- 012_customer_manual_items_read.sql) and purchase_reports.reviewed_by (see
-- 010_purchase_report_review.sql): column grants are role-level, not
-- row/policy-specific, and customers/admins share the same `authenticated`
-- role, so this is the only way to keep a column off a customer's plain
-- table read regardless of which columns their own client code happens to
-- request. Unlike created_by/reviewed_by, the ADMIN genuinely needs this
-- value (to render/preload the "מוצר Golden Light" checkbox and to preview
-- the eligible total) - see public.get_admin_manual_items() below, a new
-- SECURITY DEFINER function that is now the admin's only read path for
-- receipt_manual_items, replacing its previous plain
-- `.from('receipt_manual_items').select(...)` call.
revoke select (is_golden_light) on public.receipt_manual_items from authenticated;

-- ------------------------------------------------------------------------
-- public.get_admin_manual_items(p_report_id): the admin's read path for
-- receipt_manual_items, now that is_golden_light is not selectable via the
-- table's own grant. security definer, set search_path = '' (same
-- convention as every other definer function in this schema), requires
-- public.is_admin() - a non-admin caller gets 'not_admin' and no rows at
-- all, never a silently-filtered result.
create or replace function public.get_admin_manual_items(p_report_id uuid)
returns table (
  id uuid,
  line_index integer,
  description text,
  sku text,
  quantity numeric,
  unit_price numeric,
  line_total numeric,
  is_golden_light boolean,
  created_at timestamptz,
  updated_at timestamptz
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
    item.id,
    item.line_index,
    item.description,
    item.sku,
    item.quantity,
    item.unit_price,
    item.line_total,
    item.is_golden_light,
    item.created_at,
    item.updated_at
  from public.receipt_manual_items item
  where item.purchase_report_id = p_report_id
  order by item.line_index asc;
end;
$$;

revoke execute on function public.get_admin_manual_items(uuid) from anon;
revoke execute on function public.get_admin_manual_items(uuid) from public;
grant execute on function public.get_admin_manual_items(uuid) to authenticated;

-- ------------------------------------------------------------------------
-- public.save_manual_receipt_items(p_report_id, p_items): unchanged in
-- every other respect from migration 011 (still is_admin()-gated, still
-- validates every item before deleting anything, still replaces the FULL
-- set atomically) - the only addition is reading an optional
-- "is_golden_light" boolean per item (defaults to false when omitted/null,
-- matching the column default) and persisting it.
create or replace function public.save_manual_receipt_items(
  p_report_id uuid,
  p_items jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_report_exists boolean;
  v_item jsonb;
  v_description text;
  v_sku text;
  v_quantity numeric;
  v_unit_price numeric;
  v_line_total numeric;
  v_is_golden_light boolean;
  v_index integer;
  v_saved_count integer := 0;
begin
  if not public.is_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;

  select exists (
    select 1 from public.purchase_reports where id = p_report_id
  ) into v_report_exists;

  if not v_report_exists then
    raise exception 'report_not_found' using errcode = 'P0002';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'invalid_items' using errcode = '22023';
  end if;

  if jsonb_array_length(p_items) = 0 then
    raise exception 'items_required' using errcode = '22023';
  end if;

  if jsonb_array_length(p_items) > 200 then
    raise exception 'too_many_items' using errcode = '22023';
  end if;

  -- Pass 1: validate every item. Nothing is written yet.
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_description := nullif(btrim(v_item->>'description'), '');

    if v_description is null then
      raise exception 'description_required' using errcode = '22023';
    end if;

    if length(v_description) > 500 then
      raise exception 'description_too_long' using errcode = '22023';
    end if;

    v_sku := nullif(btrim(v_item->>'sku'), '');
    if v_sku is not null and length(v_sku) > 100 then
      raise exception 'sku_too_long' using errcode = '22023';
    end if;

    begin
      v_quantity := nullif(v_item->>'quantity', '')::numeric;
    exception when others then
      raise exception 'invalid_quantity' using errcode = '22023';
    end;
    if v_quantity is not null and (v_quantity <= 0 or v_quantity = 'NaN'::numeric) then
      raise exception 'invalid_quantity' using errcode = '22023';
    end if;

    begin
      v_unit_price := nullif(v_item->>'unit_price', '')::numeric;
    exception when others then
      raise exception 'invalid_unit_price' using errcode = '22023';
    end;
    if v_unit_price is not null and (v_unit_price < 0 or v_unit_price = 'NaN'::numeric) then
      raise exception 'invalid_unit_price' using errcode = '22023';
    end if;

    begin
      v_line_total := nullif(v_item->>'line_total', '')::numeric;
    exception when others then
      raise exception 'invalid_line_total' using errcode = '22023';
    end;
    if v_line_total is not null and (v_line_total < 0 or v_line_total = 'NaN'::numeric) then
      raise exception 'invalid_line_total' using errcode = '22023';
    end if;

    begin
      v_is_golden_light := coalesce((v_item->>'is_golden_light')::boolean, false);
    exception when others then
      raise exception 'invalid_is_golden_light' using errcode = '22023';
    end;
  end loop;

  -- Pass 2: every item validated - now atomically replace the set.
  delete from public.receipt_manual_items where purchase_report_id = p_report_id;

  v_index := 0;
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    insert into public.receipt_manual_items (
      purchase_report_id,
      line_index,
      description,
      sku,
      quantity,
      unit_price,
      line_total,
      is_golden_light,
      created_by
    )
    values (
      p_report_id,
      v_index,
      btrim(v_item->>'description'),
      nullif(btrim(v_item->>'sku'), ''),
      nullif(v_item->>'quantity', '')::numeric,
      nullif(v_item->>'unit_price', '')::numeric,
      nullif(v_item->>'line_total', '')::numeric,
      coalesce((v_item->>'is_golden_light')::boolean, false),
      auth.uid()
    );

    v_index := v_index + 1;
    v_saved_count := v_saved_count + 1;
  end loop;

  return v_saved_count;
end;
$$;

revoke execute on function public.save_manual_receipt_items(uuid, jsonb) from anon;
revoke execute on function public.save_manual_receipt_items(uuid, jsonb) from public;
grant execute on function public.save_manual_receipt_items(uuid, jsonb) to authenticated;

-- ------------------------------------------------------------------------
-- public.award_purchase_points(p_report_id): REPLACES
-- public.award_purchase_points(p_report_id, p_eligible_pre_vat_amount)
-- (migration 013) - a different signature (one fewer parameter), so the old
-- overload is explicitly dropped rather than left behind as a second,
-- competing way to award points. The client now sends ONLY the report id;
-- there is no p_eligible_pre_vat_amount, no p_points, no p_points_awarded
-- parameter anywhere in this function - every number used below is loaded
-- from database rows, never accepted as input.
drop function if exists public.award_purchase_points(uuid, numeric);

-- Mirrors the same security shape as every other admin RPC in this schema:
-- security definer, set search_path = '', public.is_admin() checked first
-- and unconditionally.
--
--   1. Requires public.is_admin().
--   2. Locks the target purchase_reports row with `for update` (same
--      concurrency-safety technique as migration 013 - two near-simultaneous
--      award attempts for the same report serialize on this lock).
--   3. Requires status = 'approved'.
--   4. Requires no existing 'purchase_reward' points_transactions row for
--      this report (duplicate-award prevention - also independently
--      enforced by the partial unique index from migration 013, which is
--      untouched by this migration).
--   5. Loads every receipt_manual_items row for this report where
--      is_golden_light = true, computes each row's amount as
--      coalesce(line_total, case when quantity is not null and unit_price
--      is not null then quantity * unit_price else null end), and sums
--      them. A row that can produce neither value contributes nothing to
--      the sum (Postgres SUM already ignores NULLs) - exactly the "row
--      contributes 0" rule requested. VAT and the invoice grand total are
--      never read anywhere in this function.
--   6. Requires the resulting eligible total to be > 0 - 'no_eligible_amount'
--      otherwise, so the UI can show "לא קיים סכום מזכה עבור החשבונית"
--      instead of attempting a meaningless award.
--   7. Computes points := floor(eligible_total * 0.2) using NUMERIC
--      arithmetic. If the result is <= 0 (a tiny eligible total that still
--      floors to zero), the award is refused ('no_points_to_award') rather
--      than creating a zero-point ledger row.
--   8. Inserts exactly one 'purchase_reward' points_transactions row
--      (storing the DB-computed eligible_total for audit, never a
--      client-supplied value), updates purchase_reports.points_awarded, and
--      increments profiles.points_balance - all three writes happen inside
--      this one function call/transaction.
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
    coalesce(
      item.line_total,
      case
        when item.quantity is not null and item.unit_price is not null
          then item.quantity * item.unit_price
        else null
      end
    )
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

-- ------------------------------------------------------------------------
-- Designed for future replacement: is_golden_light is an explicit, manual,
-- temporary stand-in for real product matching. Nothing in this migration
-- (or anywhere else in the schema) infers it from OCR, from the product
-- catalog, or from any text-matching heuristic - an admin must explicitly
-- check it per row, exactly like every other manual-entry field. When real
-- OCR/product matching exists, a future migration can derive eligibility
-- from matched receipt_line_matches rows instead (or alongside) this
-- column, without changing award_purchase_points()'s external contract
-- (still just p_report_id) - only its internal eligible-total query would
-- need to change.
