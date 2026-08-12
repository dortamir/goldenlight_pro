-- Create OCR data foundation tables: receipt_ocr_results and receipt_ocr_lines
-- This migration only stores raw/normalized OCR output for later parsing.
-- It intentionally does not implement product matching, confidence scoring,
-- or any purchase_reports status transitions. Those belong to a later
-- matching/processing layer.

create table if not exists public.receipt_ocr_results (
  id uuid primary key default gen_random_uuid(),
  purchase_report_id uuid not null
    constraint receipt_ocr_results_purchase_report_id_unique unique
    references public.purchase_reports(id) on delete cascade,
  raw_text text,
  provider text,
  status text not null default 'pending' constraint receipt_ocr_results_status_check check (
    status in ('pending', 'processing', 'completed', 'failed')
  ),
  error_message text,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.receipt_ocr_lines (
  id uuid primary key default gen_random_uuid(),
  ocr_result_id uuid not null references public.receipt_ocr_results(id) on delete cascade,
  line_index integer not null constraint receipt_ocr_lines_line_index_nonnegative check (line_index >= 0),
  raw_text text not null,
  normalized_text text,
  detected_quantity numeric,
  detected_unit_price numeric,
  detected_total numeric,
  created_at timestamptz not null default now(),
  constraint receipt_ocr_lines_ocr_result_line_unique unique (ocr_result_id, line_index)
);

-- Lightweight, deterministic normalization for OCR line text.
-- Unlike public.normalize_catalog_text (used for product/alias matching),
-- this preserves spacing structure and does not strip separators, since the
-- goal here is a readable, de-duplicated line of receipt text rather than a
-- matching key. No fuzzy matching is implemented.
create or replace function public.normalize_receipt_line(input_text text)
returns text
language sql
set search_path = ''
as $$
  select nullif(
    regexp_replace(lower(trim(coalesce(input_text, ''))), '\s+', ' ', 'g'),
    ''
  );
$$;

create or replace function public.set_receipt_line_normalized_text()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.normalized_text = public.normalize_receipt_line(new.raw_text);
  return new;
end;
$$;

drop trigger if exists receipt_ocr_lines_set_normalized_text on public.receipt_ocr_lines;
create trigger receipt_ocr_lines_set_normalized_text
before insert or update on public.receipt_ocr_lines
for each row
execute function public.set_receipt_line_normalized_text();

-- Reuse the shared public.set_updated_at() trigger function from
-- 001_create_profiles.sql rather than redefining it.
drop trigger if exists receipt_ocr_results_set_updated_at on public.receipt_ocr_results;
create trigger receipt_ocr_results_set_updated_at
before update on public.receipt_ocr_results
for each row
execute function public.set_updated_at();

alter table public.receipt_ocr_results enable row level security;
alter table public.receipt_ocr_lines enable row level security;

-- No additional indexes are added here beyond the ones already implied by
-- the constraints above:
--   * receipt_ocr_results.purchase_report_id is UNIQUE, which already
--     creates a btree index usable for lookups by purchase_report_id.
--   * receipt_ocr_lines has a UNIQUE (ocr_result_id, line_index) constraint,
--     whose btree index already serves lookups filtered by ocr_result_id
--     alone (leftmost column of the composite index).
-- Creating separate single-column indexes for either would be redundant.

revoke all on table public.receipt_ocr_results from anon;
revoke all on table public.receipt_ocr_results from authenticated;
revoke all on table public.receipt_ocr_results from public;

revoke all on table public.receipt_ocr_lines from anon;
revoke all on table public.receipt_ocr_lines from authenticated;
revoke all on table public.receipt_ocr_lines from public;

-- error_message is internal/backend diagnostic detail and must not be
-- readable by mobile clients, so it is deliberately excluded from this
-- column-level select grant.
grant select (
  id,
  purchase_report_id,
  raw_text,
  provider,
  status,
  processed_at,
  created_at,
  updated_at
) on table public.receipt_ocr_results to authenticated;

grant select on table public.receipt_ocr_lines to authenticated;

grant usage on schema public to authenticated;

revoke execute on function public.normalize_receipt_line(text) from anon;
revoke execute on function public.normalize_receipt_line(text) from public;
revoke execute on function public.normalize_receipt_line(text) from authenticated;
revoke execute on function public.set_receipt_line_normalized_text() from anon;
revoke execute on function public.set_receipt_line_normalized_text() from public;
revoke execute on function public.set_receipt_line_normalized_text() from authenticated;

drop policy if exists "Authenticated users can view OCR results for their own purchase reports" on public.receipt_ocr_results;
drop policy if exists "Authenticated users can view OCR lines for their own purchase reports" on public.receipt_ocr_lines;

create policy "Authenticated users can view OCR results for their own purchase reports"
  on public.receipt_ocr_results
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.purchase_reports pr
      where pr.id = receipt_ocr_results.purchase_report_id
        and pr.user_id = auth.uid()
    )
  );

create policy "Authenticated users can view OCR lines for their own purchase reports"
  on public.receipt_ocr_lines
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.receipt_ocr_results ocr
      join public.purchase_reports pr on pr.id = ocr.purchase_report_id
      where ocr.id = receipt_ocr_lines.ocr_result_id
        and pr.user_id = auth.uid()
    )
  );
