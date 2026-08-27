-- Stage 11: upload/processing reliability hardening.
--
-- Two independent, narrowly-scoped fixes found while auditing the customer
-- receipt upload -> OCR processing lifecycle end to end. Neither changes
-- OCR/normalization/matching/points/finalize business logic, RLS row-level
-- semantics, or admin behavior. No table grant is broadened.

-- ---------------------------------------------------------------------
-- FIX 1: public.claim_ocr_processing() - self-healing for a genuinely
-- stuck 'processing' row.
--
-- CONTEXT: process-receipt/index.ts already handles every OCR/persistence
-- failure it can actually catch (Azure error, empty result, persist
-- failure, download failure) by moving the report to 'needs_review' via
-- markOcrFailed() - confirmed by full inspection, not assumed. The one
-- scenario nothing in that function's own try/catch can ever handle is the
-- Edge Function's OWN process being killed mid-flight (a platform-level
-- execution timeout, the Deno runtime crashing, or the connection being
-- severed outside any caught exception) - in that case, the last thing
-- durably committed is receipt_ocr_results.status = 'processing' (set by
-- this very function), with nothing left to ever move it forward.
-- claim_ocr_processing()'s own default (non-forceRetry) rule already
-- rejects any 'processing' row unconditionally, which means such a report
-- would stay stuck forever, with no automated or client-triggerable
-- recovery - forceRetry is deliberately unexposed to any client today (by
-- design, see 021_ocr_azure_document_intelligence.sql's own comment: "no
-- UI calls this with true yet").
--
-- This is NOT a hypothetical: ocrProvider.ts's own Azure polling is
-- bounded (POLL_INTERVAL_MS=2000 * MAX_POLL_ATTEMPTS=45 ~= 90s, each
-- request additionally capped at REQUEST_TIMEOUT_MS=20s), so a real,
-- legitimate in-flight run should never still be 'processing' much beyond
-- roughly two minutes. A 'processing' row whose started_at is older than a
-- generous, safely-larger 5-minute threshold is therefore a reliable
-- signal of a genuinely abandoned run, not a false positive against a
-- real one.
--
-- FIX: a 'processing' row older than 5 minutes is now treated the same as
-- a 'failed' row for claiming purposes - i.e. reclaimable under the
-- existing DEFAULT (p_force_retry = false) path, with no change to
-- forceRetry's own behavior (still overrides ANY status unconditionally,
-- exactly as before). This makes the system self-healing the moment
-- anything calls process-receipt again for that report (a future retry
-- action, a support-driven re-invocation, or - already possible today,
-- unchanged by this migration - a customer/admin simply asking for it to
-- be looked at again) - it no longer requires forceRetry to recover from a
-- crash. A genuinely still-in-flight run (started_at within the last 5
-- minutes) is completely unaffected and continues to be correctly
-- rejected with 'already_processing', exactly as before.
--
-- ALSO added here (not in 021 originally): an explicit rejection when the
-- purchase report itself is already 'approved'/'rejected' - defense in
-- depth alongside the same check now added to process-receipt/index.ts
-- (Stage 11's own audit requirement: "retry must never alter an approved/
-- rejected report" or "create duplicate OCR/match data" for one). This is
-- the single, authoritative, service-role-only entry point every OCR
-- run/retry passes through, so enforcing it HERE - not only in the calling
-- Edge Function - means the guarantee holds even if this RPC is ever
-- called from a different or future caller, unconditionally, including
-- when forceRetry = true (a finalized report can never be reprocessed by
-- any means, unlike a stuck 'processing' row, which forceRetry may still
-- override).
--
-- Everything else in this function - the OCR-result row lock, the
-- 'already_completed' rule, the insert-vs-update branch, the return shape
-- - is byte-for-byte unchanged from 021_ocr_azure_document_intelligence.sql.
-- 021 is not edited; this is a new CREATE OR REPLACE.
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
  v_report_status text;
  v_ocr_result_id uuid;
  v_current_status text;
  v_started_at timestamptz;
  v_is_stale boolean;
begin
  select status into v_report_status
  from public.purchase_reports where id = p_report_id for update;

  if not found then
    raise exception 'report_not_found' using errcode = 'P0002';
  end if;

  if v_report_status in ('approved', 'rejected') then
    raise exception 'report_already_finalized' using errcode = '40001';
  end if;

  select id, status, started_at into v_ocr_result_id, v_current_status, v_started_at
  from public.receipt_ocr_results
  where purchase_report_id = p_report_id
  for update;

  v_is_stale := v_current_status = 'processing' and v_started_at is not null
    and v_started_at < (now() - interval '5 minutes');

  if v_ocr_result_id is not null and not p_force_retry and not v_is_stale then
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

-- No grant/revoke changes needed - claim_ocr_processing's existing
-- privilege shape (service-role-only, no grant to authenticated/anon at
-- all) is completely unchanged by this CREATE OR REPLACE, same as every
-- other in-place function update in this schema's history.

-- ---------------------------------------------------------------------
-- FIX 2: formally re-declare the customer's INSERT grant on
-- purchase_reports.id - a migration/live-database drift found while
-- auditing, not a live behavior change.
--
-- purchaseReportService.js's createPurchaseReport() has always explicitly
-- supplied `id` in its insert (a client-generated UUID, needed so the
-- Storage path chosen before the row exists - see uploadReceipt() -
-- matches the row once it's created). Column-level INSERT privilege is
-- required for any column given an explicit value, regardless of whether
-- it also has a DEFAULT - confirmed live, before writing this migration,
-- that authenticated already actually has this grant today (`id` appears
-- in information_schema.role_column_grants for purchase_reports/
-- authenticated/INSERT). It is NOT part of 002_create_purchase_reports.sql's
-- own `grant insert (user_id, receipt_path, original_filename) ...`
-- statement, and no later migration file grants it either (grepped every
-- migration before writing this) - it exists live only because of an
-- undocumented, out-of-band grant issued directly against the database at
-- some point outside the migration history.
--
-- This matters for reliability, not security (a customer choosing their
-- own new report's arbitrary UUID primary key is harmless - the insert
-- policy still requires auth.uid() = user_id, and a colliding id would
-- simply fail the primary key constraint): a fresh environment rebuilt
-- from this migration history alone (a new project, CI, disaster
-- recovery) would be missing this grant and the customer upload flow
-- would break on its very first insert, even though production currently
-- works. This statement is a no-op against the current live database
-- (idempotent - `grant` is safe to repeat) and simply makes the migration
-- history accurately reproduce the database's real, already-working
-- state.
grant insert (id) on table public.purchase_reports to authenticated;