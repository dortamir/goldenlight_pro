-- Create product matching foundation: public.receipt_line_matches.
-- Stores the matching outcome for ONE OCR receipt line: matched to a real
-- Golden Light product, unmatched, or flagged for manual review. This is a
-- foundation only - no points/approval logic is implemented or implied by
-- this table, and no real product catalog data exists yet.

create table if not exists public.receipt_line_matches (
  id uuid primary key default gen_random_uuid(),
  ocr_line_id uuid not null
    constraint receipt_line_matches_ocr_line_id_unique unique
    references public.receipt_ocr_lines(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  match_status text not null default 'unmatched' constraint receipt_line_matches_status_check check (
    match_status in ('unmatched', 'matched', 'needs_review')
  ),
  -- Conceptual future values: exact_sku, normalized_sku, alias, name,
  -- similarity, manual. Deliberately not constrained by a check yet, since
  -- additional matching strategies are expected to be introduced over time
  -- and this should not require a migration each time one is added.
  match_method text,
  confidence numeric constraint receipt_line_matches_confidence_range check (
    confidence is null or (confidence >= 0 and confidence <= 1)
  ),
  matched_text text,
  -- Internal backend/admin note. Never exposed to mobile clients - see the
  -- column-level grant below, which deliberately omits this column.
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A "matched" result must reference a real product, and an "unmatched"
  -- result must NOT reference one - both are enforced below. "needs_review"
  -- is deliberately left unconstrained on product_id: it may have no
  -- candidate yet, or may later carry a tentative candidate product -
  -- forcing either case would block legitimate future manual-review
  -- workflows.
  constraint receipt_line_matches_matched_requires_product check (
    match_status <> 'matched' or product_id is not null
  ),
  constraint receipt_line_matches_unmatched_requires_no_product check (
    match_status <> 'unmatched' or product_id is null
  )
);

-- Reuse the shared public.set_updated_at() trigger function from
-- 001_create_profiles.sql rather than redefining it.
drop trigger if exists receipt_line_matches_set_updated_at on public.receipt_line_matches;
create trigger receipt_line_matches_set_updated_at
before update on public.receipt_line_matches
for each row
execute function public.set_updated_at();

alter table public.receipt_line_matches enable row level security;

-- ocr_line_id is already UNIQUE, which creates its own index usable for
-- lookups by ocr_line_id. product_id has no other index yet, and future
-- admin/matching workflows will plausibly need "which receipt lines matched
-- to product X" - add that one. match_status is intentionally not indexed:
-- this table stays one row per OCR line (small), and no query pattern needs
-- it yet - avoid over-indexing ahead of an actual need.
create index if not exists idx_receipt_line_matches_product_id
  on public.receipt_line_matches (product_id);

revoke all on table public.receipt_line_matches from anon;
revoke all on table public.receipt_line_matches from authenticated;
revoke all on table public.receipt_line_matches from public;

-- review_note is internal/backend-only diagnostic detail and is
-- deliberately excluded from this column-level select grant - the mobile
-- client must never be able to read it. confidence is included: it is not
-- a secret, but the mobile UI does not display it yet.
grant select (
  id,
  ocr_line_id,
  product_id,
  match_status,
  match_method,
  confidence,
  matched_text,
  created_at,
  updated_at
) on table public.receipt_line_matches to authenticated;

grant usage on schema public to authenticated;

-- No insert/update/delete grants are given to authenticated at all -
-- matching is entirely backend-controlled, written only by trusted
-- service-role logic.

drop policy if exists "Authenticated users can view match results for their own purchase reports" on public.receipt_line_matches;

create policy "Authenticated users can view match results for their own purchase reports"
  on public.receipt_line_matches
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.receipt_ocr_lines line
      join public.receipt_ocr_results ocr on ocr.id = line.ocr_result_id
      join public.purchase_reports pr on pr.id = ocr.purchase_report_id
      where line.id = receipt_line_matches.ocr_line_id
        and pr.user_id = auth.uid()
    )
  );
