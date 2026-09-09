-- Final GOLDEN+ membership-tier rules: replaces the old 4-level, 12-invoice
-- G Level ladder (017_g_level_progression.sql: BRONZE/SILVER/GOLD/TITANIUM
-- at 0/12/24/36 approved reports, flat 20% points rate for everyone at
-- award_purchase_points()) with the final 5-level, 15-invoice ladder and a
-- tier-dependent reward rate:
--
--   BRONZE    0-14   20% points rate (unchanged from today)
--   SILVER   15-29   25%
--   GOLD     30-44   30%
--   PLATINUM 45-59   35%
--   DIAMOND  60+     40%  (current maximum - no level exists above it)
--
-- CRITICAL PRICING RULE: an invoice is always priced using the tier the
-- customer held BEFORE that invoice counted - never the tier it creates.
-- Invoice #15 (the customer's 15th ever-approved invoice) is priced at the
-- BRONZE rate; only once it is successfully finalized does the customer
-- become SILVER, so invoice #16 is the first one priced at the SILVER rate.
-- Same at every boundary (#30, #45, #60). This migration's redefinition of
-- award_purchase_points() (below) computes this "how many OTHER already-
-- approved invoices does this customer have" count itself, every time, and
-- prices strictly from that - it is never told a tier by the caller.
--
-- Tier is, and remains, LIFETIME progress derived only from the count of
-- the customer's own approved purchase_reports rows - never from
-- profiles.points_balance, which a future gift-redemption feature will
-- reduce independently. Nothing in this migration reads points_balance to
-- determine a tier, and nothing added here can lower approved_purchases_
-- count/membership_level - see the "FUTURE REDEMPTION COMPATIBILITY" note
-- near the bottom of this file for why the existing points_transactions
-- schema already supports a future negative "redeemed" transaction type
-- with zero change needed here.
--
-- This migration does NOT change: the eligible-amount calculation itself
-- (still sum(quantity * unit_price) over match_status = 'matched' manual
-- items - 019_product_matching_manual_items.sql), the unresolved-item rules
-- (024_allow_unresolved_finalize.sql), row-locking/duplicate-award
-- protection (013/014), admin authorization (every function below still
-- checks public.is_admin() first, unconditionally), or finalize_purchase_
-- report()'s/review_purchase_report()'s own signatures - both keep calling
-- recalculate_membership_level()/award_purchase_points() exactly as they
-- already do, so neither function's own body needs to change at all; every
-- new rule lives entirely inside the two functions this migration redefines
-- (both via CREATE OR REPLACE, same name/argument types/return type as
-- today, so their existing grants are preserved automatically and their
-- callers are completely unaffected).

-- ------------------------------------------------------------------------
-- CENTRALIZED TIER MODEL (server-side authority). Two small, pure,
-- internal-only helper functions - the SINGLE place either a qualifying
-- count maps to a tier name, or a tier name maps to its reward rate, is
-- decided anywhere in this schema. Neither is granted to anon/authenticated/
-- public - exactly like recalculate_membership_level() (017), they are only
-- ever reachable via a nested call from another SECURITY DEFINER function
-- already gated by public.is_admin() (or, for the reward rate specifically,
-- from award_purchase_points() below). No client, admin or customer, can
-- call either directly, and neither ever asks the client for a tier or a
-- rate - both are pure functions of a server-computed count.
create or replace function public.membership_tier_for_count(p_qualifying_count integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_qualifying_count >= 60 then 'DIAMOND'
    when p_qualifying_count >= 45 then 'PLATINUM'
    when p_qualifying_count >= 30 then 'GOLD'
    when p_qualifying_count >= 15 then 'SILVER'
    else 'BRONZE'
  end;
$$;

revoke execute on function public.membership_tier_for_count(integer) from anon;
revoke execute on function public.membership_tier_for_count(integer) from authenticated;
revoke execute on function public.membership_tier_for_count(integer) from public;

-- Reward rate is the fraction of an eligible ₪ amount awarded as points
-- (floor(eligible_amount * rate) = points, preserving the existing project
-- convention that 10 points = ₪1 of reward value - unchanged from today's
-- floor(eligible_total * 0.2) for BRONZE). Falls back to BRONZE's 0.20 for
-- any unrecognized tier string - fails safe to the LOWEST rate rather than
-- erroring or over-crediting, though every call site below only ever passes
-- a value that itself came from membership_tier_for_count() above, so this
-- fallback is defense-in-depth, not a reachable path in normal operation.
create or replace function public.membership_tier_reward_rate(p_tier text)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case p_tier
    when 'DIAMOND' then 0.40
    when 'PLATINUM' then 0.35
    when 'GOLD' then 0.30
    when 'SILVER' then 0.25
    else 0.20
  end;
$$;

revoke execute on function public.membership_tier_reward_rate(text) from anon;
revoke execute on function public.membership_tier_reward_rate(text) from authenticated;
revoke execute on function public.membership_tier_reward_rate(text) from public;

-- ------------------------------------------------------------------------
-- LEVEL-UP DETECTION STORAGE. Two new nullable columns on purchase_reports -
-- the smallest schema change that reliably supports "a reload must not
-- repeat an old promotion celebration" (customer-facing requirement),
-- without inventing a second, separate progress-tracking table:
--
--   promoted_to_tier: set (once, by award_purchase_points() below) to the
--   tier name this SPECIFIC invoice's award caused the customer to reach,
--   or left null if this invoice did not cause a promotion. Readable by the
--   report's own owner through the existing whole-table SELECT grant/RLS
--   ownership policy (002_create_purchase_reports.sql) - no new grant
--   needed, exactly like every other non-restricted column already added to
--   this table (e.g. rejection_reason, 010_purchase_report_review.sql).
--
--   promotion_acknowledged_at: null until the customer's own client has
--   actually shown the level-up celebration for THIS report and the
--   customer dismissed it - set exactly once via the new public.
--   acknowledge_tier_promotion() RPC below. A revisit/reload after that
--   always finds a non-null promotion_acknowledged_at and therefore never
--   shows the celebration again for this same report.
alter table public.purchase_reports
  add column if not exists promoted_to_tier text,
  add column if not exists promotion_acknowledged_at timestamptz;

alter table public.purchase_reports
  add constraint purchase_reports_promoted_to_tier_valid
  check (promoted_to_tier is null or promoted_to_tier in ('BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND'));

-- ------------------------------------------------------------------------
-- STAGE 32.1 SECURITY AUDIT (documentation only - no grant/policy change
-- needed; the analysis below is what PROVES that, not a gap being closed).
--
-- purchase_reports has never had a whole-table or column-level INSERT grant
-- for `authenticated` - only a COLUMN-RESTRICTED one:
-- `grant insert (user_id, receipt_path, original_filename) on table
-- public.purchase_reports to authenticated` (002_create_purchase_reports.sql),
-- later extended to also include `id` (027_upload_processing_reliability.sql).
-- Postgres column-level INSERT privilege is enforced per-column: an INSERT
-- naming any column NOT in that explicit list - including the two new ones
-- below - is rejected outright (permission denied) before the statement
-- can run at all. A customer's own client code
-- (purchaseReportService.js's createPurchaseReport) never sends
-- promoted_to_tier/promotion_acknowledged_at anyway, but this proves the
-- database itself would refuse such an attempt even if a request were
-- crafted directly against the REST API, bypassing the app entirely.
--   (1) set promoted_to_tier during report creation: IMPOSSIBLE.
--   (3) directly set promotion_acknowledged_at during report creation:
--       IMPOSSIBLE (same reasoning).
--
-- purchase_reports has NO UPDATE grant for `authenticated` at all - neither
-- whole-table nor column-restricted - confirmed unchanged since
-- 010_purchase_report_review.sql's own explicit statement of this ("no
-- INSERT/UPDATE grant on purchase_reports for authenticated at all"). A
-- direct `.update(...)` call for ANY column, old or new, is rejected before
-- RLS is even evaluated (privilege checks happen before policy evaluation).
-- The ONLY writers of either new column are the two SECURITY DEFINER
-- functions below/above, which bypass grants via their own elevated
-- execution context, never a client-held privilege:
--   (2) update promoted_to_tier later: IMPOSSIBLE via any client call - only
--       public.award_purchase_points() (below) can ever write it, and only
--       as a byproduct of a real, authorized points award.
--   (4) fabricate a promotion event: IMPOSSIBLE - the only write path
--       requires is_admin() (award_purchase_points()'s own first check) and
--       a real successful points award (see Part D below) - there is no
--       path for a customer, or an unauthorized caller of any kind, to set
--       this column to any value.
--   (5) acknowledge another user's promotion: see
--       public.acknowledge_tier_promotion() below, whose `and user_id =
--       v_caller_id` clause makes this structurally impossible - the
--       function updates zero rows for a report that isn't the caller's
--       own, never another customer's row.
--
-- No existing broad grant or RLS policy makes either column client-writable
-- - there was nothing to harden at the grant/policy level. STAGE 32.1's
-- actual change here is entirely inside acknowledge_tier_promotion() itself
-- (immediately below), adding an explicit authenticated-caller guard.

-- ------------------------------------------------------------------------
-- public.acknowledge_tier_promotion(p_report_id): the ONLY way promotion_
-- acknowledged_at can be written - a narrow, customer-facing (not admin-
-- only) SECURITY DEFINER RPC, since purchase_reports has no UPDATE grant
-- for `authenticated` at all (see the audit comment above).
--
-- STAGE 32.1: v_caller_id captures auth.uid() explicitly and an unconditional
-- `if v_caller_id is null then raise exception 'not_authenticated'` guard
-- was added up front. Previously, a null auth.uid() (never actually
-- reachable in practice - this function is only ever granted to the
-- `authenticated` role, which Supabase's own PostgREST layer never invokes
-- without a valid, already-verified JWT, so auth.uid() is always non-null
-- for a genuine call) would still have been handled safely (`user_id =
-- null` is never true in SQL, so the UPDATE would simply match zero rows) -
-- but that was an IMPLICIT safety property of NULL comparison semantics
-- rather than an explicit, self-documenting guard. This makes the
-- "must be a real authenticated caller" requirement explicit and auditable
-- rather than incidental.
--
-- Ownership is enforced by the `and user_id = v_caller_id` clause below,
-- not merely by RLS - a customer can only ever acknowledge a promotion on a
-- report that is genuinely their own; calling this for a report id that
-- exists but belongs to someone else, or that has no pending promotion at
-- all, simply updates zero rows (not found, already acknowledged, or not
-- owned by the caller), never another customer's row. Idempotent: calling
-- it twice for the same report is a harmless no-op the second time (the
-- `and promotion_acknowledged_at is null` guard means the second call
-- updates zero rows instead of overwriting an earlier timestamp). Still
-- SECURITY DEFINER, `set search_path = ''`, revoked from anon/public,
-- granted to authenticated only, and returns void - no report data of any
-- kind is ever returned to the caller.
create or replace function public.acknowledge_tier_promotion(p_report_id uuid)
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

  if p_report_id is null then
    raise exception 'report_required' using errcode = '22023';
  end if;

  update public.purchase_reports
  set promotion_acknowledged_at = now()
  where id = p_report_id
    and user_id = v_caller_id
    and promoted_to_tier is not null
    and promotion_acknowledged_at is null;
end;
$$;

revoke execute on function public.acknowledge_tier_promotion(uuid) from anon;
revoke execute on function public.acknowledge_tier_promotion(uuid) from public;
grant execute on function public.acknowledge_tier_promotion(uuid) to authenticated;

-- ------------------------------------------------------------------------
-- public.recalculate_membership_level(p_user_id): identical in shape to
-- 017's version (still a full recount from purchase_reports every time,
-- still internal-only/unreachable by any client, still only ever invoked
-- from inside finalize_purchase_report()/review_purchase_report()'s
-- approved path) - the ONLY change is the threshold table itself, now
-- delegated to membership_tier_for_count() above instead of an inline CASE,
-- so this and award_purchase_points() below can never drift apart on what
-- the tier boundaries actually are.
create or replace function public.recalculate_membership_level(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_approved_count integer;
  v_level text;
begin
  select count(*)
  into v_approved_count
  from public.purchase_reports
  where user_id = p_user_id
    and status = 'approved';

  v_level := public.membership_tier_for_count(v_approved_count);

  update public.profiles
  set approved_purchases_count = v_approved_count,
      membership_level = v_level
  where id = p_user_id;
end;
$$;

revoke execute on function public.recalculate_membership_level(uuid) from anon;
revoke execute on function public.recalculate_membership_level(uuid) from authenticated;
revoke execute on function public.recalculate_membership_level(uuid) from public;

-- ------------------------------------------------------------------------
-- public.award_purchase_points(p_report_id): same name/argument type/
-- return type as 019's version (still `returns integer`), so this is a
-- plain CREATE OR REPLACE - finalize_purchase_report() and review_purchase_
-- report() keep calling it exactly as before with no changes to either
-- function, and their existing grants are untouched by this migration.
--
-- STAGE 32.1 CORRECTION: the ORIGINAL Stage 32 version of this function
-- priced an invoice using "count of every OTHER currently-approved report
-- for this user" - correct for the normal atomic finalize flow (where the
-- report being priced is always the customer's chronologically LATEST
-- approval, since it was JUST approved in this same transaction), but WRONG
-- for the legacy fallback path (a report approved long ago, before the
-- unified finalize_purchase_report() workflow existed, only now receiving
-- its points via the separate "צבירת נקודות" admin action - see
-- adminReportService.js's awardPurchasePoints()). For that legacy case, "every
-- OTHER currently-approved report" can include reports approved AFTER this
-- one - inflating the count and pricing an old invoice at a tier the
-- customer only reached later. That is the exact bug this correction fixes.
--
-- FIX: reviewed_at (010_purchase_report_review.sql) is set, unconditionally,
-- in the SAME update statement that ever flips a report's status to
-- 'approved' - both here (via finalize_purchase_report()) and in
-- review_purchase_report()'s 'approved' path. Every 'approved' report
-- therefore always has a real, non-null, authoritative "when did this
-- become approved" timestamp - true DETERMINISTIC chronology, not an
-- approximation. The pre-finalization qualifying count is now "how many of
-- this customer's OTHER reports were already approved STRICTLY BEFORE this
-- one's own reviewed_at" (`and reviewed_at < v_report.reviewed_at`) -
-- this is well-defined and reachable for every row this function can ever
-- run against, because the 'approved' status check earlier in this same
-- function already guarantees v_report.reviewed_at is non-null by this
-- point. For the NORMAL finalize flow this produces the exact same result
-- as before (every other approved report was, by definition, approved
-- before this brand-new one); for the LEGACY fallback path it now
-- correctly reconstructs the customer's REAL historical rank at the moment
-- this invoice was actually approved, regardless of how many more recent
-- reports have been approved since. Deterministic reconstruction WAS
-- possible from existing data - no "fail safely with an internal error"
-- fallback was needed, and none was added.
--
-- STAGE 32.1 ADDITION - stale-celebration guard: a legacy report awarded
-- long after the fact could still, by this corrected chronological
-- reckoning, appear to "cause" a promotion the customer already passed
-- (e.g. they are DIAMOND today, but this old invoice's own historical rank
-- was #15, chronologically "promoting" them to SILVER). Showing a
-- level-up celebration for a tier the customer has already left behind
-- would be stale and confusing. v_current_approved_count (this customer's
-- CURRENT, real, unconditional approved-report count, from
-- profiles.approved_purchases_count - already kept authoritative by
-- recalculate_membership_level() on every approval event, normal or
-- legacy) is compared against this invoice's own chronological post-count:
-- promoted_to_tier is only ever set when this invoice's post-count is still
-- at or ahead of the customer's current real count - i.e., only when this
-- invoice genuinely represents the customer's most recent (or only)
-- crossing of that boundary. For the normal flow these are always equal
-- (recalculate_membership_level() already ran, in the same transaction,
-- immediately before this function), so this guard is a no-op there; it
-- only ever suppresses a promotion marker for the legacy path, and only
-- when a real, more-recent promotion has already superseded it. This does
-- not change how POINTS are priced (that correction, above, is
-- unconditional) - only whether a celebration marker is set.
--
-- What's new/changed, in order:
--   1-5. Identical to before: is_admin() check, row lock (`for update`,
--      same concurrency guarantee as always), 'approved' status check,
--      duplicate-award check (points_transactions existence + the existing
--      partial unique index, both unchanged).
--   6. CORRECTED - pre-finalization qualifying count, now chronological
--      (reviewed_at-based) - see above.
--   7. v_pre_tier := membership_tier_for_count(pre-count); v_reward_rate :=
--      membership_tier_reward_rate(v_pre_tier) - unchanged mechanism, now
--      fed a correct count. The rate an admin's finalize/award action ends
--      up applying remains 100% server-derived, never supplied by or
--      inferable from the client.
--   8. Eligible-amount calculation: BYTE-IDENTICAL to 019's version. Not
--      touched by this migration.
--   9. v_points := floor(v_eligible_total * v_reward_rate) - rounding
--      behavior (floor(), applied once to the final value, never per-line,
--      never client-side) is UNCHANGED.
--   10. Points ledger insert / purchase_reports.points_awarded update /
--      profiles.points_balance increment: BYTE-IDENTICAL to 019's version.
--   11. CORRECTED - LEVEL-UP DETECTION: v_post_tier derived from
--      (chronological pre-count + 1), gated by the stale-celebration guard
--      described above before promoted_to_tier is actually written.
--      promotion_acknowledged_at is deliberately left null here - only
--      public.acknowledge_tier_promotion() ever sets it.
--
-- TRANSACTIONAL CORRECTNESS (Stage 32.1 Part D verification, not a code
-- change): this entire function is one PL/pgSQL function body, executed as
-- part of whatever single transaction its caller (finalize_purchase_report()
-- or the standalone legacy RPC call) is already running in. There is no
-- explicit COMMIT or subtransaction anywhere in this function, so the
-- points_transactions insert, the points_awarded/points_balance updates,
-- and the promoted_to_tier update either ALL take effect together or - if
-- any exception is raised anywhere in this function, including after the
-- promoted_to_tier update were it ever reached - ALL roll back together.
-- The promoted_to_tier write is also structurally the LAST statement in
-- this function, strictly after every points-award write, so it can never
-- be reached unless those already succeeded. The existing duplicate-award
-- guard (step 5 above, unchanged) means a second call for an
-- already-awarded report raises 'points_already_awarded' immediately,
-- before reaching ANY of this logic - so a duplicate attempt can never
-- create a second promotion event or rewrite an existing one.
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
  v_pre_qualifying_count integer;
  v_pre_tier text;
  v_reward_rate numeric;
  v_post_qualifying_count integer;
  v_post_tier text;
  v_current_approved_count integer;
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

  -- STAGE 32.1: chronological pre-finalization qualifying count - see the
  -- function-level comment above. v_report.status = 'approved' was just
  -- confirmed above, so v_report.reviewed_at is guaranteed non-null here
  -- (both write paths that can ever set status = 'approved' always set
  -- reviewed_at in that same statement).
  select count(*)
  into v_pre_qualifying_count
  from public.purchase_reports
  where user_id = v_report.user_id
    and status = 'approved'
    and id <> p_report_id
    and reviewed_at < v_report.reviewed_at;

  v_pre_tier := public.membership_tier_for_count(v_pre_qualifying_count);
  v_reward_rate := public.membership_tier_reward_rate(v_pre_tier);

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

  v_points := floor(v_eligible_total * v_reward_rate);

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

  -- STAGE 32.1: level-up detection, chronological + stale-celebration
  -- guarded - see the function-level comment above.
  v_post_qualifying_count := v_pre_qualifying_count + 1;
  v_post_tier := public.membership_tier_for_count(v_post_qualifying_count);

  select approved_purchases_count
  into v_current_approved_count
  from public.profiles
  where id = v_report.user_id;

  if v_post_tier <> v_pre_tier
     and v_post_qualifying_count >= coalesce(v_current_approved_count, v_post_qualifying_count) then
    update public.purchase_reports
    set promoted_to_tier = v_post_tier
    where id = p_report_id;
  end if;

  return v_points;
end;
$$;

revoke execute on function public.award_purchase_points(uuid) from anon;
revoke execute on function public.award_purchase_points(uuid) from public;
grant execute on function public.award_purchase_points(uuid) to authenticated;

-- ------------------------------------------------------------------------
-- HISTORICAL USERS: reconciles every existing profile's approved_purchases_
-- count/membership_level against the SAME real, authoritative purchase_
-- reports history it always used - never resets anything, never derives
-- from points_balance. Must run AFTER the old 4-tier CHECK constraint is
-- dropped (immediately below - so a historical user whose real count now
-- computes to PLATINUM/DIAMOND under the new thresholds isn't rejected by
-- the OLD constraint mid-backfill) and BEFORE the new 5-tier constraint is
-- added (further below - so every row already conforms by the time it's
-- enforced). Safe to run more than once (recalculate_membership_level() is
-- idempotent, same as 017's own original backfill).
alter table public.profiles drop constraint if exists profiles_membership_level_valid;

select public.recalculate_membership_level(id) from public.profiles;

alter table public.profiles
  add constraint profiles_membership_level_valid
  check (membership_level in ('BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND'));

-- ------------------------------------------------------------------------
-- FUTURE REDEMPTION COMPATIBILITY (verification only - no schema change).
-- public.points_transactions (013_points_awarding.sql) was ALREADY built to
-- support a future redemption/negative transaction type without any ALTER
-- TABLE: transaction_type is free text, not a locked enum; the
-- `points > 0` / `purchase_report_id is not null` / `eligible_pre_vat_
-- amount is not null` constraints are all explicitly SCOPED to
-- `transaction_type = 'purchase_reward'` only (see that migration's own
-- comment: "so a future migration can introduce new types (including
-- negative-points reversals) without an ALTER TABLE"). A future gift-
-- redemption transaction (e.g. transaction_type = 'gift_redemption',
-- points negative, purchase_report_id null) already satisfies every
-- existing constraint on this table as-is. Nothing in this migration
-- reads profiles.points_balance to compute a tier anywhere - tier is
-- ALWAYS derived from purchase_reports.status = 'approved' row counts via
-- membership_tier_for_count() - so a future redemption reducing
-- points_balance can never reduce approved_purchases_count, never change
-- membership_level, and never downgrade a tier. This stage does not
-- implement gift redemption itself, per the explicit instruction not to.
