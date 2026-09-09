-- Stage 32.5: persistent, server-authoritative "pending birthday
-- celebration" state - the exact same architectural pattern as Stage
-- 32/32.4.2's tier-promotion celebration
-- (promoted_to_tier/promotion_acknowledged_at on purchase_reports,
-- get_my_pending_tier_promotion()/acknowledge_tier_promotion()), applied
-- here to the existing, UNCHANGED 1,000-point birthday bonus
-- (028_birthday_bonus.sql).
--
-- PROBLEM THIS FIXES: the current client-side mechanism
-- (src/context/AuthContext.js's claimedBirthdayBonusForUserRef +
-- birthdayBonus state) is PURELY in-memory. public.claim_my_birthday_bonus()
-- itself already awards the 1,000 points atomically and safely (this
-- migration does not touch that function or its logic in any way) - but if
-- the app closes/crashes/backgrounds between that award succeeding and the
-- customer actually seeing the resulting React state, the celebration is
-- lost FOREVER: the only server-side evidence of the award
-- (a 'birthday_bonus' points_transactions row) had no "has this been shown
-- to the customer yet" field for the client to check on a later session -
-- claim_my_birthday_bonus() would just keep returning awarded = false for
-- the rest of that reward_year, since the row already exists.
--
-- FIX: one new nullable column, `acknowledged_at`, on the EXISTING
-- points_transactions ledger - mirrors purchase_reports.
-- promotion_acknowledged_at exactly. A fresh birthday-bonus award leaves it
-- NULL (claim_my_birthday_bonus()'s existing INSERT statement lists no
-- columns beyond user_id/transaction_type/points/reward_year/created_by,
-- so it needs zero changes - the new column simply defaults to NULL on
-- every future insert). Two new customer-facing SECURITY DEFINER RPCs
-- (get_my_pending_birthday_celebration() / acknowledge_my_birthday_
-- celebration(uuid)) let the client detect and clear this state safely,
-- independent of whatever happened to the session that actually triggered
-- the award.
--
-- WHY AN RPC, NOT A PLAIN SELECT (points_transactions already has a
-- whole-table `grant select ... to authenticated`, unlike purchase_reports
-- - see 013_points_awarding.sql): that whole-table grant is irrelevant
-- here because points_transactions' only RLS policy is "Admins can view
-- points transactions" (`using (public.is_admin())`) - there has never
-- been a customer-ownership SELECT policy on this table (013's own
-- comment: "Customer transaction history is not displayed anywhere yet...
-- no customer SELECT policy is added here"). A plain customer session
-- querying this table directly would pass the grant check but then match
-- zero RLS policies and silently get back no rows at all - not an error,
-- just never-working. A SECURITY DEFINER RPC is therefore required, not
-- merely preferred, exactly like get_my_pending_tier_promotion() needed
-- one for its own (different) reason. Consistent with that RPC, this one
-- also derives identity exclusively from auth.uid() and exposes only the
-- four fields needed - never eligible_pre_vat_amount, purchase_report_id,
-- created_by, or any other customer's row.
--
-- WHY THE WRITE (acknowledge) MUST BE AN RPC REGARDLESS: points_transactions
-- is explicitly an append-only ledger with NO UPDATE grant for
-- `authenticated` at all (013's own comment: "No INSERT/UPDATE/DELETE grant
-- or policy exists for authenticated at all - the only writer is
-- award_purchase_points()"). This migration does not add one - the new
-- acknowledge RPC is SECURITY DEFINER precisely so acknowledged_at can be
-- set without ever widening that append-only guarantee for anything else
-- on this table.
--
-- NO CHANGE, anywhere in this migration, to: the 1,000-point amount, birthday
-- eligibility (date_of_birth / leap-year handling), once-per-year
-- protection (idx_points_transactions_one_birthday_bonus_per_year, still
-- the sole schema-level duplicate-award guarantee), or
-- claim_my_birthday_bonus() itself - it is not redefined by this file at
-- all.

-- ------------------------------------------------------------------------
-- acknowledged_at: nullable, scoped by CHECK to 'birthday_bonus' rows only
-- (mirrors points_transactions_birthday_bonus_requires_year's own scoping
-- technique) - every existing/future 'purchase_reward' row is unaffected
-- and can never have this column set (there is no writer that would ever
-- try; the CHECK is a second, schema-level guarantee of that, not just
-- documentation).
alter table public.points_transactions
  add column if not exists acknowledged_at timestamptz;

alter table public.points_transactions
  add constraint points_transactions_acknowledged_at_birthday_only check (
    acknowledged_at is null or transaction_type = 'birthday_bonus'
  );

-- ------------------------------------------------------------------------
-- public.get_my_pending_birthday_celebration(): takes NO parameters -
-- identity comes exclusively from auth.uid(), so a caller can never
-- request another customer's birthday-bonus row. Returns at most one row:
-- transaction_id, bonus_points, reward_year, created_at - no
-- eligible_pre_vat_amount, no purchase_report_id, no created_by, nothing
-- about any other transaction or any other customer. Filters exactly
-- transaction_type = 'birthday_bonus' and acknowledged_at is null, ordered
-- created_at asc with id as a tie-breaker (oldest unacknowledged first,
-- same determinism reasoning as get_my_pending_tier_promotion() - relevant
-- only in the extreme edge case of a customer missing more than one
-- consecutive year's celebration), limit 1. stable (read-only, no side
-- effects).
create or replace function public.get_my_pending_birthday_celebration()
returns table (
  transaction_id uuid,
  bonus_points integer,
  reward_year integer,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_caller_id uuid;
begin
  v_caller_id := auth.uid();

  if v_caller_id is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  return query
    select
      pt.id,
      pt.points,
      pt.reward_year,
      pt.created_at
    from public.points_transactions pt
    where pt.user_id = v_caller_id
      and pt.transaction_type = 'birthday_bonus'
      and pt.acknowledged_at is null
    order by pt.created_at asc, pt.id asc
    limit 1;
end;
$$;

revoke execute on function public.get_my_pending_birthday_celebration() from anon;
revoke execute on function public.get_my_pending_birthday_celebration() from public;
grant execute on function public.get_my_pending_birthday_celebration() to authenticated;

-- ------------------------------------------------------------------------
-- public.acknowledge_my_birthday_celebration(p_transaction_id): mirrors
-- acknowledge_tier_promotion()'s exact shape/guarantees. Ownership enforced
-- via `user_id = v_caller_id` (never trusts p_transaction_id alone) and
-- idempotent via `and acknowledged_at is null` in the UPDATE's WHERE clause
-- - calling this twice for the same transaction, or for a transaction that
-- isn't the caller's own, or that was never a birthday bonus, is a
-- harmless no-op (0 rows updated, no error). Returns void - no row data of
-- any kind is ever returned to the caller.
create or replace function public.acknowledge_my_birthday_celebration(p_transaction_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller_id uuid;
begin
  v_caller_id := auth.uid();

  if v_caller_id is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  if p_transaction_id is null then
    raise exception 'transaction_required' using errcode = '22023';
  end if;

  update public.points_transactions
  set acknowledged_at = now()
  where id = p_transaction_id
    and user_id = v_caller_id
    and transaction_type = 'birthday_bonus'
    and acknowledged_at is null;
end;
$$;

revoke execute on function public.acknowledge_my_birthday_celebration(uuid) from anon;
revoke execute on function public.acknowledge_my_birthday_celebration(uuid) from public;
grant execute on function public.acknowledge_my_birthday_celebration(uuid) to authenticated;
