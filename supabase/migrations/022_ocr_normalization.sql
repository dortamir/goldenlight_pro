-- OCR Integration Stage 2: Golden Light invoice normalization + row
-- recovery.
--
-- Extends receipt_ocr_lines (021_ocr_azure_document_intelligence.sql) with
-- a second, clearly-separate set of fields: normalized/derived evidence,
-- never overwriting or replacing the original Azure fields Stage 1 already
-- persists (raw_text, raw_item, product_code, detected_quantity,
-- detected_unit_price, detected_total, and every *_confidence column all
-- remain completely untouched by this migration).
--
-- This migration does NOT change product matching rules
-- (productMatcher.ts's matching strategies are untouched), does NOT touch
-- receipt_line_matches/receipt_manual_items/points_transactions, does NOT
-- award points, does NOT approve/reject reports, and does NOT change G
-- Level. A normalized row is not an approved product and not
-- points-eligible - nothing here sets product_id, match_status, or
-- is_golden_light anywhere.

-- ---------------------------------------------------------------------
-- receipt_ocr_lines: normalized/derived fields, additive only.
alter table public.receipt_ocr_lines
  add column if not exists normalized_product_code text,
  add column if not exists normalized_quantity numeric,
  add column if not exists normalized_unit_price numeric,
  add column if not exists normalized_total numeric,
  add column if not exists normalization_status text,
  add column if not exists normalization_notes jsonb,
  add column if not exists source_ocr_line_id uuid references public.receipt_ocr_lines(id) on delete cascade,
  add column if not exists is_recovered_row boolean not null default false;

-- normalized_product_code: the ProductCode value AFTER validating its
-- candidate tokens against the real, active public.products.sku catalog
-- (see ocrNormalization.ts's resolveProductCode()) - e.g. "600302 9"'s
-- normalized_product_code becomes "600302" once that token (and only that
-- token) is confirmed as a real active SKU. The original product_code
-- column (021) is never modified - "600302 9" stays exactly that.
--
-- normalized_quantity/unit_price/total: quantity is the only field Stage 2
-- ever corrects (see the task's own "Quantity column confusion" - Azure
-- sometimes selects the wrong numeric token as Quantity), derived from
-- Amount/UnitPrice consistency plus a matching raw numeric token as
-- evidence (see ocrNormalization.ts's reconcileQuantity()). unit_price/
-- total are carried through unchanged (no correction logic exists for
-- them in this stage) purely so every normalized_* column is populated
-- together and consistently once a row has been normalized at all. The
-- original detected_quantity/detected_unit_price/detected_total columns
-- (005/021) are never modified.
--
-- normalization_status: a small, explicit top-level state - constrained
-- below to exactly the five states this stage needs: 'clean' (no
-- correction/ambiguity found), 'corrected' (quantity and/or product_code
-- needed evidence-based cleanup), 'ambiguous' (more than one plausible
-- candidate exists and none was silently chosen), 'merged_recovered' (this
-- row was recovered from a single Azure item that evidence showed
-- actually represented more than one invoice row), 'needs_review'
-- (inconsistent numerics, an unresolvable product code, or a merged item
-- that could not be safely split). NULL means "not yet normalized" (e.g.
-- an OCR line persisted before this stage existed, or before the
-- normalization step has run for this report).
--
-- normalization_notes: full traceability for every derived value - never
-- just the final number/status. Holds the finer-grained sub-classification
-- (per-field status, candidate tokens considered, the implied-quantity
-- calculation, matched SKU/barcode ids, merge-detection details) behind
-- normalization_status's small top-level summary. See ocrNormalization.ts
-- for the exact shape - deliberately not constrained by a schema/check
-- here, the same "no enum needed yet" reasoning already used for
-- receipt_line_matches.match_method.
--
-- source_ocr_line_id / is_recovered_row: support merged-item row recovery.
-- A recovered row (is_recovered_row = true) is a NEW, synthetic
-- receipt_ocr_lines row Stage 2 itself inserts when strong evidence shows
-- one Azure item actually represented multiple invoice rows - it has no
-- direct Azure Items[i] counterpart of its own, so raw_item/product_code/
-- detected_* on a recovered row are null (there is no per-row Azure
-- evidence to preserve for a row Azure never separated itself - only the
-- ORIGINAL parent item's raw_item carries the real Azure evidence, still
-- fully intact). source_ocr_line_id points back to that original parent
-- row. on delete cascade: if the parent row is ever deleted (e.g. the
-- normal delete-all-lines-for-this-ocr-result-id replace on a re-run - see
-- ocrPersistence.ts), any rows recovered from it are removed with it
-- rather than becoming orphaned children pointing at a deleted parent.
-- normalization_status values: 'clean' | 'corrected' | 'ambiguous' |
-- 'merged_recovered' | 'needs_review' | null (not yet normalized).
alter table public.receipt_ocr_lines
  drop constraint if exists receipt_ocr_lines_normalization_status_check,
  add constraint receipt_ocr_lines_normalization_status_check
    check (
      normalization_status is null
      or normalization_status in ('clean', 'corrected', 'ambiguous', 'merged_recovered', 'needs_review')
    );

-- A recovered row is always the product of a real parent row - enforced at
-- the database level, not just by ocrNormalization.ts's own logic.
alter table public.receipt_ocr_lines
  drop constraint if exists receipt_ocr_lines_recovered_requires_source,
  add constraint receipt_ocr_lines_recovered_requires_source
    check (not is_recovered_row or source_ocr_line_id is not null);

-- A row cannot reference itself as its own source.
alter table public.receipt_ocr_lines
  drop constraint if exists receipt_ocr_lines_source_not_self,
  add constraint receipt_ocr_lines_source_not_self
    check (source_ocr_line_id is null or source_ocr_line_id <> id);

create index if not exists idx_receipt_ocr_lines_source_ocr_line_id
  on public.receipt_ocr_lines (source_ocr_line_id)
  where source_ocr_line_id is not null;

-- receipt_ocr_lines currently has a WHOLE-TABLE select grant (no column
-- list - see 005_create_receipt_ocr.sql), which means a plain `alter table
-- add column` would otherwise make every one of these new columns
-- immediately readable by a customer selecting their own OCR lines,
-- exactly the same risk already documented and handled in
-- 021_ocr_azure_document_intelligence.sql. Stage 2's derived fields are
-- internal review evidence, not finished/confirmed customer-facing
-- content (a "corrected" quantity is still just an unconfirmed candidate,
-- not a fact the customer should see presented as such) - carve them back
-- out the same way, and route the one legitimate diagnostic need (admin
-- review of normalization results) through get_admin_ocr_lines() instead
-- (021 - extended below to return the new columns too), never a widened
-- table/column grant.
revoke select (
  normalized_product_code,
  normalized_quantity,
  normalized_unit_price,
  normalized_total,
  normalization_status,
  normalization_notes,
  source_ocr_line_id,
  is_recovered_row
) on table public.receipt_ocr_lines from authenticated;

-- ---------------------------------------------------------------------
-- public.get_admin_ocr_lines(p_report_id): extended to also return the
-- Stage 2 normalization columns, so an admin/backend reader gets the full
-- picture (original Azure evidence + normalized/derived evidence +
-- traceability notes) from the one existing function rather than a second
-- near-duplicate one. Same is_admin() gate, same security definer/
-- search_path convention, unchanged from 021 otherwise.
--
-- CREATE OR REPLACE cannot change a RETURNS TABLE function's column set -
-- Postgres error 42P13 ("cannot change return type of existing function
-- ... Row type defined by OUT parameters is different"), the exact same
-- class of error already fixed once before for
-- get_admin_manual_items(uuid) in 019_product_matching_manual_items.sql.
-- 021's version of this function returns 16 columns; this stage adds 8
-- more (normalized_product_code, normalized_quantity,
-- normalized_unit_price, normalized_total, normalization_status,
-- normalization_notes, source_ocr_line_id, is_recovered_row), so the OUT
-- parameter list itself is changing and an explicit DROP is required
-- first. `if exists` makes this safe to run whether this is the first
-- attempt at 022 or a rerun after a previous attempt failed at exactly
-- this statement (021's original 16-column version would still be live in
-- that case) - either way, the DROP is a safe no-op or a real drop, and
-- the CREATE immediately below always leaves exactly one, correct,
-- 24-column version in place. No CASCADE is used or needed: nothing else
-- in the schema references this function by name (confirmed via
-- repo-wide search), so there is nothing for a CASCADE to take down.
drop function if exists public.get_admin_ocr_lines(uuid);

create or replace function public.get_admin_ocr_lines(p_report_id uuid)
returns table (
  id uuid,
  ocr_result_id uuid,
  line_index integer,
  raw_text text,
  normalized_text text,
  detected_quantity numeric,
  detected_unit_price numeric,
  detected_total numeric,
  product_code text,
  description_confidence numeric,
  product_code_confidence numeric,
  quantity_confidence numeric,
  unit_price_confidence numeric,
  amount_confidence numeric,
  raw_item jsonb,
  normalized_product_code text,
  normalized_quantity numeric,
  normalized_unit_price numeric,
  normalized_total numeric,
  normalization_status text,
  normalization_notes jsonb,
  source_ocr_line_id uuid,
  is_recovered_row boolean,
  created_at timestamptz
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
    l.id, l.ocr_result_id, l.line_index, l.raw_text, l.normalized_text,
    l.detected_quantity, l.detected_unit_price, l.detected_total,
    l.product_code, l.description_confidence, l.product_code_confidence,
    l.quantity_confidence, l.unit_price_confidence, l.amount_confidence,
    l.raw_item,
    l.normalized_product_code, l.normalized_quantity, l.normalized_unit_price,
    l.normalized_total, l.normalization_status, l.normalization_notes,
    l.source_ocr_line_id, l.is_recovered_row,
    l.created_at
  from public.receipt_ocr_lines l
  join public.receipt_ocr_results r on r.id = l.ocr_result_id
  where r.purchase_report_id = p_report_id
  order by l.line_index;
end;
$$;

-- service_role does NOT automatically have EXECUTE on functions in this
-- project - verified live: get_admin_ocr_result(uuid),
-- get_admin_ocr_lines(uuid), claim_ocr_processing(uuid, boolean), and
-- normalize_receipt_line(text) all returned false for service_role's
-- EXECUTE privilege until it was granted manually. The DROP FUNCTION
-- above removes the function object entirely, including any privilege
-- grants that were manually added to the previous (021) version - so
-- service_role's EXECUTE must be re-granted explicitly here, or
-- process-receipt's service-role client would lose the ability to call
-- this function the moment 022 is applied.
revoke execute on function public.get_admin_ocr_lines(uuid) from anon;
revoke execute on function public.get_admin_ocr_lines(uuid) from public;
grant execute on function public.get_admin_ocr_lines(uuid) to authenticated;
grant execute on function public.get_admin_ocr_lines(uuid) to service_role;