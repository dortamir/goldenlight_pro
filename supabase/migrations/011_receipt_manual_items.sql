-- Admin Stage 4 (rework): manual receipt line-item entry, for when OCR
-- failed, is missing, or produced no usable lines. This is a foundation
-- only - it deliberately does NOT touch points, product matching, or the
-- product catalog. It is entirely separate from OCR data: manual items are
-- never written into receipt_ocr_lines, and this migration does not modify
-- receipt_ocr_results/receipt_ocr_lines/receipt_line_matches in any way.
--
-- NOTE: an earlier version of this migration was written but never applied
-- to the live database and no longer exists in this repository - this is a
-- fresh 011, not an edit of an already-applied migration.

-- ------------------------------------------------------------------------
-- public.receipt_manual_items: one row per manually-entered line, admin/
-- internal only (not exposed to the customer at this stage - see the
-- RLS/grants below, which give it NO customer-facing access at all, unlike
-- purchase_reports where a customer reads their own row).
create table if not exists public.receipt_manual_items (
  id uuid primary key default gen_random_uuid(),
  purchase_report_id uuid not null references public.purchase_reports(id) on delete cascade,
  line_index integer not null constraint receipt_manual_items_line_index_nonnegative check (line_index >= 0),
  description text not null,
  sku text,
  quantity numeric,
  unit_price numeric,
  line_total numeric,
  -- Always the admin who saved this set - see
  -- public.save_manual_receipt_items() below, which is the only writer and
  -- never accepts this as client input.
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint receipt_manual_items_report_line_unique unique (purchase_report_id, line_index),
  constraint receipt_manual_items_description_not_blank check (length(btrim(description)) > 0),
  constraint receipt_manual_items_description_max_length check (length(description) <= 500),
  constraint receipt_manual_items_sku_max_length check (sku is null or length(sku) <= 100),
  constraint receipt_manual_items_quantity_positive check (quantity is null or quantity > 0),
  constraint receipt_manual_items_unit_price_nonnegative check (unit_price is null or unit_price >= 0),
  constraint receipt_manual_items_line_total_nonnegative check (line_total is null or line_total >= 0)
);

-- Reuses the shared public.set_updated_at() trigger function from
-- 001_create_profiles.sql. Every real write today is a fresh INSERT (see
-- save_manual_receipt_items()'s replace-the-whole-set strategy below), so
-- this only matters if a future stage ever updates a row in place instead.
drop trigger if exists receipt_manual_items_set_updated_at on public.receipt_manual_items;
create trigger receipt_manual_items_set_updated_at
before update on public.receipt_manual_items
for each row
execute function public.set_updated_at();

alter table public.receipt_manual_items enable row level security;

create index if not exists idx_receipt_manual_items_purchase_report_id
  on public.receipt_manual_items (purchase_report_id);

-- Admin-only read. There is no customer-facing SELECT policy at all - a
-- customer gets zero rows regardless of which report they ask about, not
-- just rows scoped to their own reports. Manual entries stay internal/
-- admin-only; customer visibility is a separate future decision.
drop policy if exists "Admins can view manual receipt items" on public.receipt_manual_items;
create policy "Admins can view manual receipt items"
  on public.receipt_manual_items
  for select
  to authenticated
  using (public.is_admin());

revoke all on table public.receipt_manual_items from anon;
revoke all on table public.receipt_manual_items from authenticated;
revoke all on table public.receipt_manual_items from public;

grant select on table public.receipt_manual_items to authenticated;
grant usage on schema public to authenticated;

-- No INSERT/UPDATE/DELETE grant or policy exists for authenticated at all -
-- the only writer is public.save_manual_receipt_items() below, via
-- SECURITY DEFINER.

-- ------------------------------------------------------------------------
-- public.save_manual_receipt_items(p_report_id, p_items): replaces the
-- FULL manual-item set for one report in a single atomic operation. This is
-- what makes repeated saves/edits safe - the whole delete-then-insert
-- happens inside one function call (one Postgres transaction), unlike the
-- OCR pipeline's documented non-atomic delete-then-insert (two separate
-- client calls, see ocrPersistence.ts in supabase/functions/process-receipt).
--
-- p_items is a JSONB array of objects shaped like:
--   { "description": "...", "sku": "...", "quantity": ..., "unit_price": ..., "line_total": ... }
-- (sku/quantity/unit_price/line_total may be omitted or null). line_index
-- is NEVER read from the client - it is assigned server-side from array
-- order, the same "never trust a client-supplied index" rule already used
-- for receipt_ocr_lines (see ocrParser.ts's line_index handling).
--
-- Every item is validated BEFORE anything is deleted, so an invalid payload
-- never leaves a report's existing manual set half-destroyed.
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
-- Granted broadly to `authenticated` on purpose, same reasoning as
-- public.review_purchase_report() in 010_purchase_report_review.sql -
-- there is no separate Postgres role for admins; authorization happens
-- inside the function (the is_admin() check above), not via the grant.
grant execute on function public.save_manual_receipt_items(uuid, jsonb) to authenticated;
