-- Points Stage 1: secure points-awarding foundation for approved Golden
-- Light purchases.
--
-- Final business rule: only the admin-confirmed pre-VAT eligible Golden
-- Light amount counts. Reward value is 2% of that amount; every ₪1 of
-- reward value is 10 points. points = floor(eligible_pre_vat_amount * 0.02
-- * 10), i.e. floor(eligible_pre_vat_amount * 0.2). This is computed ONLY
-- inside public.award_purchase_points() below (NUMERIC arithmetic, never
-- floating point), never trusted from the client, and never exposed to the
-- customer.
--
-- No OCR integration, no product matching, no catalog import, and no
-- automatic derivation of the eligible amount from manual items/OCR lines
-- exists anywhere in this migration - the admin must explicitly enter/
-- confirm the eligible amount for each award, exactly as instructed.

-- ------------------------------------------------------------------------
-- public.points_transactions: an append-only ledger. Only 'purchase_reward'
-- rows are ever inserted by anything in this migration - reversal/
-- adjustment/redemption transaction types are intentionally NOT implemented
-- yet, but the schema below does not hard-lock transaction_type to a fixed
-- enum (same "don't over-constrain ahead of a real need" precedent already
-- used for receipt_line_matches.match_method), so a future migration can
-- introduce new types (including negative-points reversals) without an
-- ALTER TABLE. The points > 0 / eligible-amount-required constraints below
-- are scoped specifically to 'purchase_reward' so they never block a future
-- type that legitimately needs a different shape (e.g. a negative
-- reversal).
create table if not exists public.points_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  purchase_report_id uuid references public.purchase_reports(id) on delete cascade,
  transaction_type text not null constraint points_transactions_transaction_type_not_blank check (length(btrim(transaction_type)) > 0),
  points integer not null,
  eligible_pre_vat_amount numeric,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  constraint points_transactions_purchase_reward_points_positive check (
    transaction_type <> 'purchase_reward' or points > 0
  ),
  constraint points_transactions_purchase_reward_requires_report check (
    transaction_type <> 'purchase_reward' or purchase_report_id is not null
  ),
  constraint points_transactions_purchase_reward_requires_amount check (
    transaction_type <> 'purchase_reward' or eligible_pre_vat_amount is not null
  ),
  constraint points_transactions_eligible_amount_nonnegative check (
    eligible_pre_vat_amount is null or eligible_pre_vat_amount >= 0
  )
);

-- Enforces "a purchase report receives purchase_reward points AT MOST
-- ONCE" at the database level, independent of and in addition to the
-- application-level check inside award_purchase_points() below. A partial
-- unique index (not a plain unique constraint) so it only applies to
-- 'purchase_reward' rows, leaving room for a future transaction_type to
-- reference the same report multiple times (e.g. more than one future
-- correction/reversal row) without conflicting with this rule.
create unique index if not exists idx_points_transactions_one_purchase_reward_per_report
  on public.points_transactions (purchase_report_id)
  where transaction_type = 'purchase_reward';

create index if not exists idx_points_transactions_user_id
  on public.points_transactions (user_id);

alter table public.points_transactions enable row level security;

-- Admin-only for this stage. Customer transaction history is not displayed
-- anywhere yet (the customer only ever sees the resulting
-- purchase_reports.points_awarded value and profiles.points_balance, both
-- already readable via existing, unchanged grants/policies) - per the
-- explicit "grant only the minimum necessary" instruction, no customer
-- SELECT policy is added here. That can be introduced later, independently,
-- once real transaction-history UI exists.
create policy "Admins can view points transactions"
  on public.points_transactions
  for select
  to authenticated
  using (public.is_admin());

revoke all on table public.points_transactions from anon;
revoke all on table public.points_transactions from authenticated;
revoke all on table public.points_transactions from public;

grant select on table public.points_transactions to authenticated;
grant usage on schema public to authenticated;

-- No INSERT/UPDATE/DELETE grant or policy exists for authenticated at all -
-- the only writer is public.award_purchase_points() below, via SECURITY
-- DEFINER. Client UI (admin or customer) can never edit/delete an existing
-- ledger row.

-- ------------------------------------------------------------------------
-- public.award_purchase_points(p_report_id, p_eligible_pre_vat_amount):
-- the ONLY way points_transactions/purchase_reports.points_awarded/
-- profiles.points_balance can be written for a purchase reward. Mirrors
-- the same security shape as public.review_purchase_report() (migration
-- 010) and public.save_manual_receipt_items() (migration 011):
-- SECURITY DEFINER, `set search_path = ''`, public.is_admin() checked
-- first and unconditionally.
--
--   1. Requires public.is_admin() - checked first, before touching any row.
--   2. Requires a non-null, non-negative eligible amount.
--   3. Locks the target purchase_reports row with `for update` - the same
--      technique review_purchase_report() uses for concurrency safety: two
--      near-simultaneous award attempts for the same report serialize on
--      this lock, and the second one (after the first commits) correctly
--      finds the already-inserted points_transactions row and fails with
--      'points_already_awarded' instead of awarding twice. The partial
--      unique index above is a second, independent guarantee of the same
--      rule at the schema level.
--   4. Requires the report to exist and belong to a real user_id (enforced
--      structurally - purchase_reports.user_id is `not null references
--      auth.users(id)`, so any row found here already satisfies this).
--   5. Requires the report's status to be exactly 'approved' - never
--      submitted/processing/needs_review/rejected.
--   6. Computes points = floor(p_eligible_pre_vat_amount * 0.2) using
--      NUMERIC arithmetic (never floating point, never computed in
--      JavaScript) - equivalent to floor(amount * 0.02 * 10) per the
--      business rule. If the result is <= 0, the award is refused rather
--      than creating a meaningless zero-point ledger row.
--   7. Inserts exactly one 'purchase_reward' points_transactions row,
--      updates purchase_reports.points_awarded to the same value, and
--      increments profiles.points_balance by that value with a DB-side
--      `points_balance = points_balance + v_points` (never overwritten
--      with a client-supplied balance) - all three writes happen inside
--      this one function call, so a failure partway through rolls back
--      every one of them together rather than leaving partial state.
--
-- Does not touch profiles.membership_level or
-- profiles.approved_purchases_count - no established rule exists yet for
-- changing either when points are awarded, so neither is modified.
create or replace function public.award_purchase_points(
  p_report_id uuid,
  p_eligible_pre_vat_amount numeric
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_report public.purchase_reports;
  v_points integer;
begin
  if not public.is_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;

  if p_eligible_pre_vat_amount is null or p_eligible_pre_vat_amount < 0 then
    raise exception 'invalid_amount' using errcode = '22023';
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

  v_points := floor(p_eligible_pre_vat_amount * 0.2);

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
    p_eligible_pre_vat_amount,
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

revoke execute on function public.award_purchase_points(uuid, numeric) from anon;
revoke execute on function public.award_purchase_points(uuid, numeric) from public;
-- Granted broadly to `authenticated` on purpose, same reasoning as every
-- other admin RPC in this schema - there is no separate Postgres role for
-- admins; authorization happens inside the function (step 1 above).
grant execute on function public.award_purchase_points(uuid, numeric) to authenticated;
