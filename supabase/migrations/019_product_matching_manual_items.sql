-- Product Matching Stage 2: links receipt_manual_items to the real Golden
-- Light catalog (public.products, populated in 018_product_catalog_foundation.sql)
-- so an admin reviewing a manually-entered receipt line can attach an
-- authoritative product match instead of relying only on the
-- is_golden_light boolean introduced in 014_automatic_points_eligibility.sql.
--
-- SAME MATCHER, NOT A SECOND ONE: the actual matching cascade (barcode exact
-- -> sku exact -> normalized sku -> alias exact -> description exact ->
-- description fuzzy) lives in src/services/productMatching.js, a plain,
-- dependency-free JS port of the exact same priority order already
-- implemented in supabase/functions/process-receipt/productMatcher.ts (the
-- future OCR pipeline's matcher, still unused/undeployed - see that file's
-- own "SimilarityMatchStrategy ... not implemented" note, now implemented in
-- the JS port). Both mirror public.normalize_catalog_text() for
-- SKU/alias normalization, exactly like the existing TS matcher already
-- does - this migration does not change normalize_catalog_text() at all.
--
-- WHY JS, NOT A NEW POSTGRES MATCHING FUNCTION: public.products/
-- public.product_aliases already grant plain SELECT to `authenticated` for
-- active rows (004_create_product_catalog.sql) - the admin app can already
-- load the ~211-row active catalog once per review session and match
-- in-memory, with zero N+1 queries and no new read RPC. The only genuinely
-- privileged operation is WRITING a match (or an alias) - both go through
-- the existing, already admin-gated public.save_manual_receipt_items(),
-- extended below. This keeps exactly one write path for manual items,
-- exactly as before (018's "avoid duplicating match state" instruction).
--
-- THREE-STATE MATCH STATUS: match_status in ('unresolved', 'matched',
-- 'not_golden_light') - mirrors the "matched requires product_id / non-
-- matched forbids product_id" CHECK-constraint pattern already proven on
-- receipt_line_matches (007_create_product_matching.sql). 'unresolved' is
-- the default for both brand-new rows and every pre-existing historical
-- row backfilled by this migration (see below) - it is never conflated with
-- 'not_golden_light', which requires an explicit admin action.
--
-- is_golden_light (014) is KEPT, not dropped (minimal/compatible schema
-- change), but its role changes: from this migration forward it is always
-- computed server-side as (match_status = 'matched') inside
-- save_manual_receipt_items() - the client-supplied is_golden_light value is
-- no longer read at all, eliminating the possibility of it disagreeing with
-- match_status/product_id. public.award_purchase_points() (013/014/016)
-- is updated below to read match_status directly rather than is_golden_light,
-- per the explicit "prefer authoritative product_id" instruction - the
-- floor(eligible_total * 0.2) formula itself is UNCHANGED.
--
-- NOT implemented here (explicitly out of scope for this stage): OCR
-- provider integration, wholesaler/source detection, AI/LLM matching, any
-- change to the points formula, G Level, or rewards logic.

-- ------------------------------------------------------------------------
-- Schema: link columns on receipt_manual_items.
alter table public.receipt_manual_items
  add column if not exists product_id uuid references public.products(id) on delete set null;

alter table public.receipt_manual_items
  add column if not exists match_type text;

alter table public.receipt_manual_items
  add column if not exists match_confidence numeric;

alter table public.receipt_manual_items
  add column if not exists match_status text not null default 'unresolved';

-- Backfill: every existing row (there is no live product data to attach a
-- historical is_golden_light=true row to, so it cannot become 'matched')
-- starts 'unresolved' under the new three-state model, regardless of its old
-- is_golden_light value - an honest "not yet product-matched", not a guess.
-- is_golden_light itself is left untouched by this migration (no UPDATE) -
-- it only becomes a pure function of match_status the next time a report's
-- items are saved through save_manual_receipt_items() (see below).
update public.receipt_manual_items
  set match_status = 'unresolved'
  where match_status is null;

-- Each constraint is dropped-if-exists immediately before being (re)added -
-- the same "drop ... if exists" idempotency convention already used
-- throughout this schema for triggers/policies (e.g. every
-- `drop trigger if exists ...; create trigger ...` pair) - so this
-- migration is safe to run again after a prior attempt partially applied
-- (CREATE/ALTER TABLE ADD CONSTRAINT is not itself re-runnable the way
-- ADD COLUMN IF NOT EXISTS is, since Postgres has no
-- ADD CONSTRAINT IF NOT EXISTS).
alter table public.receipt_manual_items
  drop constraint if exists receipt_manual_items_match_status_check;
alter table public.receipt_manual_items
  add constraint receipt_manual_items_match_status_check
  check (match_status in ('unresolved', 'matched', 'not_golden_light'));

alter table public.receipt_manual_items
  drop constraint if exists receipt_manual_items_match_confidence_range;
alter table public.receipt_manual_items
  add constraint receipt_manual_items_match_confidence_range
  check (match_confidence is null or (match_confidence >= 0 and match_confidence <= 1));

alter table public.receipt_manual_items
  drop constraint if exists receipt_manual_items_matched_requires_product;
alter table public.receipt_manual_items
  add constraint receipt_manual_items_matched_requires_product
  check (match_status <> 'matched' or product_id is not null);

alter table public.receipt_manual_items
  drop constraint if exists receipt_manual_items_unmatched_requires_no_product;
alter table public.receipt_manual_items
  add constraint receipt_manual_items_unmatched_requires_no_product
  check (match_status = 'matched' or product_id is null);

create index if not exists idx_receipt_manual_items_product_id
  on public.receipt_manual_items (product_id);

-- match_type/match_confidence carry the same internal detail as
-- receipt_line_matches.match_method/confidence and are treated the same way:
-- confidence is not secret (kept selectable), but match_type/product_id are
-- only meaningful together with the rest of the admin review UI, which is
-- admin-only already (receipt_manual_items has no customer SELECT policy at
-- all - see 011_receipt_manual_items.sql, unchanged here). No new column-
-- level revoke is needed: the whole table already grants SELECT to
-- `authenticated` with is_golden_light as the sole revoked column (014); the
-- new columns are covered by that same existing grant and carry no more
-- sensitivity than product_id already does on receipt_line_matches (which
-- IS readable by the owning customer). Since receipt_manual_items has no
-- customer-facing read policy whatsoever, this is moot in practice today.

-- ------------------------------------------------------------------------
-- public.get_admin_manual_items(p_report_id): extended to also return the
-- new match columns, plus the matched product's sku/name (a convenience
-- join so the admin UI never has to issue a second query just to render
-- "matched: <sku> - <name>"). Every other behavior (is_admin() gate,
-- ordering) is unchanged from 014_automatic_points_eligibility.sql.
--
-- Postgres cannot CREATE OR REPLACE a function when its RETURNS TABLE
-- column set changes (error 42P13, "cannot change return type of existing
-- function ... Row type defined by OUT parameters is different") - the
-- 014 version returned 10 columns, this version returns 15. The function
-- must be dropped first. This is safe: get_admin_manual_items(uuid) has
-- exactly one signature across this whole schema (grep-confirmed - no
-- other migration defines an overload with different argument types), and
-- nothing else in the database depends on it (no view, trigger, or other
-- function body references it - it is only ever called directly as an
-- RPC from the client), so no CASCADE is needed or used. Its EXECUTE
-- grants are dropped along with the function and explicitly re-granted
-- below exactly as before (revoke from anon/public, grant to
-- authenticated), and the function keeps its SECURITY DEFINER/
-- search_path/is_admin() gate unchanged - dropping and recreating loses
-- nothing security-relevant, since every one of those properties is
-- re-declared in the CREATE OR REPLACE below regardless.
drop function if exists public.get_admin_manual_items(uuid);

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
  product_id uuid,
  match_type text,
  match_confidence numeric,
  match_status text,
  matched_product_sku text,
  matched_product_name text,
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
    item.product_id,
    item.match_type,
    item.match_confidence,
    item.match_status,
    product.sku,
    product.name,
    item.created_at,
    item.updated_at
  from public.receipt_manual_items item
  left join public.products product on product.id = item.product_id
  where item.purchase_report_id = p_report_id
  order by item.line_index asc;
end;
$$;

revoke execute on function public.get_admin_manual_items(uuid) from anon;
revoke execute on function public.get_admin_manual_items(uuid) from public;
grant execute on function public.get_admin_manual_items(uuid) to authenticated;

-- ------------------------------------------------------------------------
-- public.save_manual_receipt_items(p_report_id, p_items): still the ONE
-- writer of receipt_manual_items, still is_admin()-gated, still validates
-- every item before deleting anything, still replaces the FULL set
-- atomically (unchanged from 011/014). Each item object may now also carry:
--   product_id      - uuid string or null/omitted
--   match_type       - text or null/omitted (e.g. 'barcode_exact',
--                       'sku_exact', 'sku_normalized', 'alias_exact',
--                       'description_exact', 'description_fuzzy', 'manual' -
--                       deliberately NOT check-constrained, same reasoning
--                       as receipt_line_matches.match_method: new matching
--                       strategies should never require a migration)
--   match_confidence - numeric 0-1 or null/omitted
--   match_status      - 'unresolved' | 'matched' | 'not_golden_light',
--                       defaults to 'unresolved' when omitted/blank
--
-- Trust boundary: this RPC is reachable only by an is_admin() caller (same
-- as every other admin RPC in this schema - there is no separate Postgres
-- role for admins), and product_id/match_type/match_confidence are always
-- values the SAME backend already computed moments earlier (via the JS
-- matcher reading the read-only product catalog) or the admin's own manual
-- pick - never invented client-side without basis. Regardless, this
-- function independently re-validates: match_status must be one of the
-- three known values; a 'matched' row must reference a real, ACTIVE
-- product (raises 'invalid_product' otherwise) and carry a non-blank
-- match_type (raises 'match_type_required' otherwise); any row NOT
-- 'matched' has product_id/match_type/match_confidence forced to null
-- regardless of what the client sent, so a client cannot desync
-- match_status from product_id even if it tried.
--
-- is_golden_light is no longer read from the client payload at all (the
-- key is accepted but ignored if present, for backward-compatible callers)
-- - it is always computed here as (match_status = 'matched'), eliminating
-- the possibility of the two ever disagreeing.
--
-- ALIAS LEARNING (Part 14/15 of the task spec): when a row is saved with
-- match_type = 'manual' and match_status = 'matched' (i.e. the admin
-- explicitly picked this product, not an automatic exact-tier match), and
-- the receipt's own description text is not already exactly the product's
-- canonical sku/name, a new product_aliases row is inserted linking that
-- description text to the chosen product - `on conflict (normalized_alias)
-- do nothing` relies on the existing global unique constraint
-- (004_create_product_catalog.sql) to make this naturally idempotent (a
-- re-save of the same row never creates a duplicate) and to guarantee it
-- never silently overwrites an alias some OTHER product already claimed.
-- This deliberately runs ONLY for match_type = 'manual' - never for an
-- automatic match (including 'description_fuzzy', which the JS matcher
-- never auto-applies - see productMatching.js), so a fuzzy false positive
-- can never teach the catalog a bad alias on its own.
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
  v_product_id uuid;
  v_match_type text;
  v_match_confidence numeric;
  v_match_status text;
  v_index integer;
  v_saved_count integer := 0;
  v_new_item_id uuid;
  v_needs_alias boolean;
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

    v_match_status := nullif(btrim(v_item->>'match_status'), '');
    v_match_status := coalesce(v_match_status, 'unresolved');
    if v_match_status not in ('unresolved', 'matched', 'not_golden_light') then
      raise exception 'invalid_match_status' using errcode = '22023';
    end if;

    if v_match_status = 'matched' then
      begin
        v_product_id := nullif(v_item->>'product_id', '')::uuid;
      exception when others then
        raise exception 'invalid_product' using errcode = '22023';
      end;

      if v_product_id is null then
        raise exception 'invalid_product' using errcode = '22023';
      end if;

      if not exists (
        select 1 from public.products where id = v_product_id and is_active = true
      ) then
        raise exception 'invalid_product' using errcode = '22023';
      end if;

      v_match_type := nullif(btrim(v_item->>'match_type'), '');
      if v_match_type is null then
        raise exception 'match_type_required' using errcode = '22023';
      end if;
    end if;
  end loop;

  -- Pass 2: every item validated - now atomically replace the set.
  delete from public.receipt_manual_items where purchase_report_id = p_report_id;

  v_index := 0;
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_match_status := coalesce(nullif(btrim(v_item->>'match_status'), ''), 'unresolved');

    if v_match_status = 'matched' then
      v_product_id := nullif(v_item->>'product_id', '')::uuid;
      v_match_type := nullif(btrim(v_item->>'match_type'), '');
      begin
        v_match_confidence := nullif(v_item->>'match_confidence', '')::numeric;
      exception when others then
        v_match_confidence := null;
      end;
    else
      -- Defense in depth: a non-'matched' row can never carry match
      -- linkage fields, regardless of what the client sent.
      v_product_id := null;
      v_match_type := null;
      v_match_confidence := null;
    end if;

    insert into public.receipt_manual_items (
      purchase_report_id,
      line_index,
      description,
      sku,
      quantity,
      unit_price,
      line_total,
      is_golden_light,
      product_id,
      match_type,
      match_confidence,
      match_status,
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
      (v_match_status = 'matched'),
      v_product_id,
      v_match_type,
      v_match_confidence,
      v_match_status,
      auth.uid()
    )
    returning id into v_new_item_id;

    -- Alias learning: explicit admin confirmation only (match_type =
    -- 'manual'), never from an automatic/fuzzy match.
    if v_match_status = 'matched' and v_match_type = 'manual' then
      v_description := btrim(v_item->>'description');

      select not exists (
        select 1 from public.products
        where id = v_product_id
          and (
            lower(btrim(name)) = lower(v_description)
            or lower(btrim(sku)) = lower(v_description)
          )
      )
      into v_needs_alias;

      if v_needs_alias then
        insert into public.product_aliases (product_id, alias, source_name)
        values (v_product_id, v_description, null)
        on conflict (normalized_alias) do nothing;
      end if;
    end if;

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
-- public.award_purchase_points(p_report_id): identical in every other
-- respect to 016_simplify_eligible_amount_calc.sql (still security definer,
-- still is_admin()-gated, still locks the report row, still requires
-- 'approved', still prevents duplicate awards, still floors at 0.2, still
-- atomically writes points_transactions/purchase_reports/profiles, still
-- reads only quantity * unit_price - no line_total). The ONLY change is the
-- eligibility filter: `item.match_status = 'matched'` instead of
-- `item.is_golden_light = true` - the authoritative, product-linked signal
-- instead of the now-derived boolean. Since is_golden_light is always set
-- equal to (match_status = 'matched') by save_manual_receipt_items() above,
-- this changes no observable behavior for any row saved through the normal
-- flow - it only removes the redundant second source of truth, per the
-- explicit "prefer authoritative product_id ... avoid duplicating match
-- state" instruction. The floor(eligible_total * 0.2) formula is UNCHANGED.
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
    and item.match_status = 'matched';

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
-- Untouched by this migration (confirmed by inspection before writing it):
--   - public.finalize_purchase_report() (015) - calls
--     save_manual_receipt_items() and award_purchase_points() by name with
--     the same signatures; both are extended above via CREATE OR REPLACE,
--     so finalize_purchase_report() itself needs no change at all.
--   - public.review_purchase_report() (010) - rejection path, never touches
--     receipt_manual_items or points.
--   - public.recalculate_membership_level() / G Level (017) - untouched.
--   - receipt_line_matches / receipt_ocr_* (005/007) - untouched; this
--     migration is entirely about receipt_manual_items.
--   - public.products / public.product_aliases columns and grants (004,
--     018) - untouched, except for the new product_aliases INSERT that now
--     happens transitively through save_manual_receipt_items() above (still
--     only reachable via that is_admin()-gated SECURITY DEFINER function -
--     `authenticated` still has no direct INSERT grant on product_aliases).