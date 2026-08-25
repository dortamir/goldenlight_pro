-- OCR Integration Stage 1: Azure Document Intelligence ingestion +
-- persistence foundation.
--
-- Extends the existing OCR schema (005_create_receipt_ocr.sql) with the
-- fields needed to preserve Azure's prebuilt-invoice output faithfully:
-- a structured ProductCode alongside the existing quantity/unit price/
-- total, per-field confidence, the complete raw per-line Azure object, and
-- the complete raw analyze-result JSON for the report as a whole.
--
-- This migration does NOT change product matching rules (productMatcher.ts
-- is untouched), does NOT award points, does NOT approve/reject reports,
-- and does NOT touch receipt_manual_items, points_transactions, or any G
-- Level logic. It only extends OCR ingestion/persistence and adds the
-- backend-only plumbing (a concurrency-safe "claim" RPC, and admin-only
-- diagnostic read RPCs) needed to run it safely.

-- ---------------------------------------------------------------------
-- receipt_ocr_results: provider/model metadata + full raw traceability.
alter table public.receipt_ocr_results
  add column if not exists raw_response jsonb,
  add column if not exists model_id text,
  add column if not exists api_version text,
  add column if not exists started_at timestamptz;

-- raw_response: the complete Azure analyze-result JSON (analyzeResult),
-- preserved verbatim. This is what makes debugging missed rows possible
-- later, and it already contains analyzeResult.pages (lines/content/
-- spans) - the raw OCR text/layout evidence a future fallback parser needs
-- to detect an invoice row that Azure's structured Items array omitted
-- (see the task's CASE B). No separate "raw pages" column is added - it
-- would only duplicate what raw_response already holds in full.
--
-- model_id / api_version: which Azure model/API version actually produced
-- this result (e.g. 'prebuilt-invoice' / '2024-11-30'), so a future schema
-- or matching change can tell which rows came from which model version.
--
-- started_at: when this OCR run began (the analyze request was submitted
-- to Azure) - distinct from processed_at, which marks completion (success
-- or failure).
--
-- All four columns are deliberately NOT added to the existing customer
-- column-select grant below - they stay unreadable by any client role via
-- a plain SELECT, exactly like error_message already is. Admin/backend
-- diagnostic access goes through public.get_admin_ocr_result() instead
-- (see below), never a widened table/column grant.

-- ---------------------------------------------------------------------
-- receipt_ocr_lines: structured Azure fields Stage 1 must preserve
-- faithfully. Per the task spec's own example, ProductCode "600302 9" must
-- be stored exactly as Azure returned it - never auto-cleaned to "600302"
-- at this stage.
alter table public.receipt_ocr_lines
  add column if not exists product_code text,
  add column if not exists description_confidence numeric,
  add column if not exists product_code_confidence numeric,
  add column if not exists quantity_confidence numeric,
  add column if not exists unit_price_confidence numeric,
  add column if not exists amount_confidence numeric,
  add column if not exists raw_item jsonb;

-- product_code: Azure Items[i].valueObject.ProductCode content/value,
-- preserved exactly as returned. Never trusted as an authoritative SKU -
-- product matching (a later stage) is responsible for comparing this
-- against the real catalog, not this persistence layer.
--
-- *_confidence: Azure's own per-field confidence (0-1), same convention/
-- range as receipt_line_matches.confidence. Persisted so a low-confidence
-- value can be surfaced later without ever being treated as authoritative
-- here.
--
-- raw_item: the complete Azure Items[i] object for this row (every field's
-- value/content/confidence/boundingRegions/spans), preserved verbatim -
-- the per-line equivalent of receipt_ocr_results.raw_response, for the
-- same debugging/recovery reasons.

alter table public.receipt_ocr_lines
  drop constraint if exists receipt_ocr_lines_description_confidence_range,
  drop constraint if exists receipt_ocr_lines_product_code_confidence_range,
  drop constraint if exists receipt_ocr_lines_quantity_confidence_range,
  drop constraint if exists receipt_ocr_lines_unit_price_confidence_range,
  drop constraint if exists receipt_ocr_lines_amount_confidence_range,
  add constraint receipt_ocr_lines_description_confidence_range
    check (description_confidence is null or (description_confidence >= 0 and description_confidence <= 1)),
  add constraint receipt_ocr_lines_product_code_confidence_range
    check (product_code_confidence is null or (product_code_confidence >= 0 and product_code_confidence <= 1)),
  add constraint receipt_ocr_lines_quantity_confidence_range
    check (quantity_confidence is null or (quantity_confidence >= 0 and quantity_confidence <= 1)),
  add constraint receipt_ocr_lines_unit_price_confidence_range
    check (unit_price_confidence is null or (unit_price_confidence >= 0 and unit_price_confidence <= 1)),
  add constraint receipt_ocr_lines_amount_confidence_range
    check (amount_confidence is null or (amount_confidence >= 0 and amount_confidence <= 1));

-- receipt_ocr_lines currently has a WHOLE-TABLE select grant (no column
-- list - see 005_create_receipt_ocr.sql), which means a plain `alter table
-- add column` would otherwise make every new column above immediately
-- readable by a customer selecting their own OCR lines. Carve the new
-- sensitive/internal columns back out, the same "grant broadly, then
-- revoke the specific sensitive columns" pattern already used for
-- is_golden_light/created_by/reviewed_by/error_message elsewhere in this
-- schema - product_code/confidence/raw_item are internal diagnostic
-- evidence, not customer-facing content, and raw_item in particular may
-- carry bounding-box/layout internals that should never reach a client.
revoke select (
  product_code,
  description_confidence,
  product_code_confidence,
  quantity_confidence,
  unit_price_confidence,
  amount_confidence,
  raw_item
) on table public.receipt_ocr_lines from authenticated;

-- ---------------------------------------------------------------------
-- public.claim_ocr_processing(p_report_id, p_force_retry): the single,
-- concurrency-safe entry point for starting or retrying an OCR run.
--
-- Locks the purchase_reports row first (`for update`), which serializes
-- any two invocations for the SAME report - the second call blocks until
-- the first's transaction commits, then re-reads the now-current
-- receipt_ocr_results status rather than racing it. This is the same
-- row-lock technique already used by public.finalize_purchase_report() and
-- public.award_purchase_points() for their own concurrency guarantees.
--
-- Default behavior (p_force_retry = false):
--   - no existing receipt_ocr_results row, or status = 'failed' -> may
--     proceed (a fresh run, or a retry of a genuine failure).
--   - status = 'processing' -> rejected ('already_processing') - a second
--     concurrent/rapid call for the same report never starts a second
--     Azure analysis.
--   - status = 'completed' -> rejected ('already_completed') - prevents an
--     accidental duplicate (costed) Azure call for an already-finished
--     report.
--
-- p_force_retry = true is the explicit, deliberate retry path (e.g. a
-- future admin "retry OCR" action - no such UI exists yet, this is
-- backend plumbing only) that may override ANY current status, including
-- a stuck 'processing' row left behind by a crashed invocation.
--
-- Callable only by the trusted service-role connection (see the revoke
-- below, which excludes authenticated/anon entirely) - OCR processing is
-- never triggered by a direct client RPC call, only via the
-- process-receipt Edge Function's own server-side service-role client.
-- This is what satisfies "must not allow an arbitrary user to OCR another
-- customer's receipt": ownership/authorization is checked in the Edge
-- Function (index.ts) before this is ever called, exactly like every other
-- privileged write in that function already works.
create or replace function public.claim_ocr_processing(
  p_report_id uuid,
  p_force_retry boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_report_exists boolean;
  v_ocr_result_id uuid;
  v_current_status text;
begin
  select exists (
    select 1 from public.purchase_reports where id = p_report_id for update
  ) into v_report_exists;

  if not v_report_exists then
    raise exception 'report_not_found' using errcode = 'P0002';
  end if;

  select id, status into v_ocr_result_id, v_current_status
  from public.receipt_ocr_results
  where purchase_report_id = p_report_id
  for update;

  if v_ocr_result_id is not null and not p_force_retry then
    if v_current_status = 'processing' then
      raise exception 'already_processing' using errcode = '55000';
    end if;
    if v_current_status = 'completed' then
      raise exception 'already_completed' using errcode = '55000';
    end if;
  end if;

  if v_ocr_result_id is null then
    insert into public.receipt_ocr_results (purchase_report_id, status, started_at, error_message)
    values (p_report_id, 'processing', now(), null)
    returning id into v_ocr_result_id;
  else
    update public.receipt_ocr_results
    set status = 'processing', started_at = now(), error_message = null
    where id = v_ocr_result_id;
  end if;

  return v_ocr_result_id;
end;
$$;

revoke execute on function public.claim_ocr_processing(uuid, boolean) from anon;
revoke execute on function public.claim_ocr_processing(uuid, boolean) from public;
revoke execute on function public.claim_ocr_processing(uuid, boolean) from authenticated;
-- No grant to authenticated at all, unlike every is_admin()-gated RPC
-- elsewhere in this schema - this function has no caller-identity check of
-- its own because it is never meant to be reachable from the app's own
-- Supabase client (anon/authenticated key) under any circumstance, only
-- from the Edge Function's service-role connection (which bypasses grants
-- entirely, so no explicit grant is needed for it to work).

-- ---------------------------------------------------------------------
-- public.get_admin_ocr_result(p_report_id) / get_admin_ocr_lines(p_report_id):
-- the admin/backend-only diagnostic read path for the columns this
-- migration deliberately excluded from the plain customer/admin-shared
-- SELECT grant (raw_response, model_id, api_version, started_at,
-- error_message, product_code, every *_confidence column, raw_item).
-- Mirrors public.get_admin_manual_items() exactly (same is_admin() gate,
-- same security definer / search_path convention) - this is a read-only
-- data-access primitive, not an admin UI change; no screen calls it yet.
create or replace function public.get_admin_ocr_result(p_report_id uuid)
returns table (
  id uuid,
  purchase_report_id uuid,
  raw_text text,
  provider text,
  status text,
  error_message text,
  model_id text,
  api_version text,
  started_at timestamptz,
  processed_at timestamptz,
  raw_response jsonb,
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
    r.id, r.purchase_report_id, r.raw_text, r.provider, r.status, r.error_message,
    r.model_id, r.api_version, r.started_at, r.processed_at, r.raw_response,
    r.created_at, r.updated_at
  from public.receipt_ocr_results r
  where r.purchase_report_id = p_report_id;
end;
$$;

revoke execute on function public.get_admin_ocr_result(uuid) from anon;
revoke execute on function public.get_admin_ocr_result(uuid) from public;
grant execute on function public.get_admin_ocr_result(uuid) to authenticated;

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
    l.raw_item, l.created_at
  from public.receipt_ocr_lines l
  join public.receipt_ocr_results r on r.id = l.ocr_result_id
  where r.purchase_report_id = p_report_id
  order by l.line_index;
end;
$$;

revoke execute on function public.get_admin_ocr_lines(uuid) from anon;
revoke execute on function public.get_admin_ocr_lines(uuid) from public;
grant execute on function public.get_admin_ocr_lines(uuid) to authenticated;