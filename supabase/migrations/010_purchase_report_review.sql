-- Admin Stage 3: manual approve/reject review workflow for purchase_reports.
--
-- Scope is strictly the review DECISION itself - status, who reviewed it,
-- when, and (for a rejection) why. This migration deliberately does NOT
-- touch points_balance, membership_level, approved_purchases_count, or
-- anything else on public.profiles - no trigger, no function anywhere in
-- this schema modifies those columns in response to a status change (see
-- 001_create_profiles.sql: they are set directly by the row-creation
-- trigger/backfill only). Points/membership updates are a separate, later
-- stage.
--
-- purchase_reports.status already allows 'approved' and 'rejected' (see the
-- purchase_reports_status_check constraint in 002_create_purchase_reports.sql)
-- - no new status value is introduced here.
--
-- purchase_reports.admin_note already exists (002_create_purchase_reports.sql)
-- but is intentionally left untouched/unused by this migration - Stage 3
-- asks for a dedicated, purpose-built rejection_reason column instead of
-- overloading that free-text field, and admin-notes management itself is
-- explicitly out of scope for this stage.

-- ------------------------------------------------------------------------
-- Review audit columns.
alter table public.purchase_reports
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid references auth.users(id),
  add column if not exists rejection_reason text;

-- A rejected report must always carry a real, non-empty reason - enforced
-- at the database level regardless of write path, not only inside the RPC
-- below. btrim() rejects whitespace-only text the same way the RPC does.
alter table public.purchase_reports
  add constraint purchase_reports_rejection_reason_required_when_rejected
  check (
    status <> 'rejected'
    or (rejection_reason is not null and length(btrim(rejection_reason)) > 0)
  );

-- Reasonable cap so this can never carry an arbitrarily huge payload.
alter table public.purchase_reports
  add constraint purchase_reports_rejection_reason_max_length
  check (rejection_reason is null or length(rejection_reason) <= 1000);

-- reviewed_by is deliberately excluded from client-side SELECT entirely -
-- see below. purchase_reports' existing SELECT grant is a whole-table grant
-- (`grant select on table public.purchase_reports to authenticated`, from
-- 002_create_purchase_reports.sql), which automatically covers newly added
-- columns too; without this explicit column-level revoke, a customer
-- reading their OWN report (already permitted by their own RLS policy)
-- would also be able to select reviewed_by, exposing which specific admin
-- account reviewed it. Postgres supports carving a single column back out
-- of a broader whole-table grant this way. reviewed_at and rejection_reason
-- are intentionally left readable (via the existing whole-table grant) -
-- neither identifies which admin acted, and the customer needs to read
-- their own rejection_reason (see the customer-facing screen change).
revoke select (reviewed_by) on public.purchase_reports from authenticated;

-- ------------------------------------------------------------------------
-- public.review_purchase_report(): the ONLY way status/reviewed_at/
-- reviewed_by/rejection_reason can ever be written. There is still no
-- INSERT/UPDATE grant on purchase_reports for `authenticated` at all (see
-- 002_create_purchase_reports.sql - only SELECT and a column-restricted
-- INSERT exist), so a direct `.from('purchase_reports').update(...)` call
-- from any client, admin or not, is rejected before this function is even
-- reachable. This function is SECURITY DEFINER specifically so it can
-- perform the actual UPDATE (bypassing the absence of a client UPDATE
-- grant/policy) after enforcing every rule itself:
--
--   1. Caller must be a real admin_users member (public.is_admin()) -
--      checked first, unconditionally.
--   2. p_decision must be exactly 'approved' or 'rejected'.
--   3. The target report must exist and is locked with `for update`, which
--      is what makes this concurrency-safe: if two admin sessions call this
--      for the same report at nearly the same moment, the second call
--      blocks until the first transaction commits, then re-reads the
--      now-updated status and correctly hits the "not reviewable anymore"
--      exception below instead of silently overwriting the first decision.
--   4. The report's CURRENT status must still be 'submitted' or
--      'needs_review' - an already-approved/rejected report (or one still
--      'processing') cannot be finalized again through this function.
--   5. A rejection requires a real, trimmed, non-empty reason (max 1000
--      chars) - an approval always clears rejection_reason to null,
--      regardless of whatever the client happened to pass.
--   6. reviewed_at is always now() and reviewed_by is always auth.uid() -
--      never accepted as input from the client.
--
-- This function does not read or write anything on public.profiles, does
-- not touch receipt_ocr_results/receipt_ocr_lines/receipt_line_matches,
-- and does not require OCR to exist or have completed - a report with no
-- OCR row at all is just as reviewable as one with a completed OCR result.
--
-- `set search_path = ''` matches every other SECURITY DEFINER/trigger
-- function in this schema (see public.is_admin() in
-- 009_admin_read_access.sql) - every reference below is fully schema-
-- qualified as a result.
create or replace function public.review_purchase_report(
  p_report_id uuid,
  p_decision text,
  p_rejection_reason text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_trimmed_reason text;
begin
  if not public.is_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;

  if p_decision not in ('approved', 'rejected') then
    raise exception 'invalid_decision' using errcode = '22023';
  end if;

  select status into v_status
  from public.purchase_reports
  where id = p_report_id
  for update;

  if not found then
    raise exception 'report_not_found' using errcode = 'P0002';
  end if;

  if v_status not in ('submitted', 'needs_review') then
    raise exception 'report_not_reviewable' using errcode = '40001';
  end if;

  if p_decision = 'rejected' then
    v_trimmed_reason := nullif(btrim(p_rejection_reason), '');

    if v_trimmed_reason is null then
      raise exception 'rejection_reason_required' using errcode = '22023';
    end if;

    if length(v_trimmed_reason) > 1000 then
      raise exception 'rejection_reason_too_long' using errcode = '22023';
    end if;
  else
    v_trimmed_reason := null;
  end if;

  update public.purchase_reports
  set
    status = p_decision,
    reviewed_at = now(),
    reviewed_by = auth.uid(),
    rejection_reason = v_trimmed_reason
  where id = p_report_id;

  return p_decision;
end;
$$;

revoke execute on function public.review_purchase_report(uuid, text, text) from anon;
revoke execute on function public.review_purchase_report(uuid, text, text) from public;
-- Granted broadly to `authenticated` on purpose: there is no separate
-- Postgres role for admins in this schema, so authorization happens INSIDE
-- the function (step 1 above), not via the grant. A non-admin calling this
-- always fails at that first check, before touching any row.
grant execute on function public.review_purchase_report(uuid, text, text) to authenticated;
