-- Matching UX Stage 3 (small follow-up): preserves the existing
-- product_aliases learning mechanism (019_product_matching_manual_items.sql)
-- now that the admin UI (AdminReportDetailScreen.js's applyProductToRow,
-- and the new inline description/SKU suggestion dropdowns backed by
-- src/services/productMatching.js's getProductSuggestions()) always
-- overwrites receipt_manual_items.description with the SELECTED product's
-- own canonical name the moment a suggestion is picked - so that
-- description and sku never end up desynchronized from the same
-- product_id ("description = product A, sku = product B" can no longer
-- happen).
--
-- PROBLEM this fixes: alias learning (019) reads `description` at save
-- time and only creates an alias when it differs from the matched
-- product's own name/sku. Once the UI always overwrites `description` to
-- the canonical name BEFORE saving, `description` would always already
-- equal the canonical name by the time save_manual_receipt_items() runs -
-- so a genuinely different receipt wording (e.g. the admin typed "מפסק 1M
-- לבן" and selected official product "מפסק יחיד 1 מודול לבן") would never
-- be learned as an alias again, silently breaking the existing mechanism.
--
-- FIX: an OPTIONAL new "alias_source_text" key per item - the admin's
-- original wording as it stood immediately BEFORE a selected suggestion
-- overwrote `description` (captured client-side, never server-derived).
-- When present and non-blank, alias learning uses it INSTEAD of
-- `description`; when absent, it falls back to `description` exactly as
-- 019 already did - fully backward compatible with any caller that
-- doesn't send it. This is the ONLY behavioral change in this migration.
--
-- NO SCHEMA CHANGE: no new column, no new table, no change to
-- public.products/public.product_aliases or their grants/RLS. Only
-- save_manual_receipt_items()'s function body changes. Its RETURNS INTEGER
-- shape is identical to 019's version, so CREATE OR REPLACE FUNCTION works
-- directly here - no DROP FUNCTION is needed (unlike
-- get_admin_manual_items() in 019, whose RETURNS TABLE shape genuinely
-- changed). Every other rule (is_admin() gate, full-set validate-then-
-- replace, product_id/match_type/match_confidence forced null for a non-
-- 'matched' row, is_golden_light always computed as
-- (match_status = 'matched')) is unchanged from 019.
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
  v_alias_source_text text;
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
    -- 'manual'), never from an automatic/fuzzy match. Uses
    -- alias_source_text (the admin's pre-selection wording) when the
    -- client sent one - falls back to `description` itself otherwise,
    -- identical to 019's original behavior.
    if v_match_status = 'matched' and v_match_type = 'manual' then
      v_description := btrim(v_item->>'description');
      v_alias_source_text := coalesce(nullif(btrim(v_item->>'alias_source_text'), ''), v_description);

      select not exists (
        select 1 from public.products
        where id = v_product_id
          and (
            lower(btrim(name)) = lower(v_alias_source_text)
            or lower(btrim(sku)) = lower(v_alias_source_text)
          )
      )
      into v_needs_alias;

      if v_needs_alias then
        insert into public.product_aliases (product_id, alias, source_name)
        values (v_product_id, v_alias_source_text, null)
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
-- Untouched by this migration: public.get_admin_manual_items() (019),
-- public.award_purchase_points() (019), public.finalize_purchase_report()
-- (015), public.review_purchase_report() (010), G Level (017),
-- receipt_line_matches/receipt_ocr_* (005/007), public.products/
-- public.product_aliases schema and grants (004, 018) - this migration
-- touches nothing beyond save_manual_receipt_items()'s function body.