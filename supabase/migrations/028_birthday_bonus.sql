-- Stage 26: birthday profile field + annual 1,000-point birthday bonus.
--
-- Two independent additions, both following existing established patterns
-- exactly (see 001_create_profiles.sql and 013_points_awarding.sql):
--
--   1. public.profiles.date_of_birth - a plain nullable DATE, required at
--      the APPLICATION level for new registrations (handle_new_user() below
--      still never rejects a signup over it - see that function's own
--      comment) but not enforced NOT NULL at the schema level, so existing
--      customers with no birthday on file are unaffected. A dedicated
--      BEFORE UPDATE trigger allows the value to be set exactly ONCE (NULL
--      -> a real date) and rejects any further change at the database
--      level - the customer CANNOT repeatedly edit their birthday to farm
--      more than one bonus per year, independent of anything the client UI
--      does or doesn't allow.
--
--   2. public.claim_my_birthday_bonus() - a SECURITY DEFINER RPC the
--      authenticated customer calls on themselves (auth.uid(), never a
--      client-supplied user id). Exactly mirrors
--      public.award_purchase_points()'s established shape: locks the
--      target profiles row with `for update`, computes everything
--      server-side, and inserts exactly one 'birthday_bonus'
--      points_transactions row + increments profiles.points_balance inside
--      one atomic function call. A new nullable points_transactions.
--      reward_year column plus a partial unique index scoped to
--      transaction_type = 'birthday_bonus' - the exact same technique
--      idx_points_transactions_one_purchase_reward_per_report already uses
--      for purchase reports - guarantees at most one birthday bonus per
--      (user_id, reward_year) at the schema level, as a second, independent
--      guarantee alongside the row lock.

-- ------------------------------------------------------------------------
-- Part 1: profiles.date_of_birth

alter table public.profiles
  add column if not exists date_of_birth date;

-- STAGE 26.2: uses the same Israel business-date convention as
-- claim_my_birthday_bonus() below - (now() at time zone
-- 'Asia/Jerusalem')::date - rather than the bare `current_date` an earlier
-- draft of this migration used. `current_date` resolves against the
-- database session's TimeZone GUC (Supabase's default is UTC; no migration
-- in this project ever changes it), which is 2-3 hours behind Israel's own
-- calendar date depending on DST. Since Israel's date rolls over before
-- UTC's does, a `date_of_birth` equal to "today" in Israel local time could
-- be one day ahead of a UTC `current_date` and get wrongly rejected as
-- future for that daily window - or the reverse could wrongly accept a
-- technically-future value. Anchoring this constraint to the exact same
-- expression the RPC uses for eligibility removes that inconsistency
-- entirely; both now agree on what "today" means.
--
-- A plain table CHECK constraint (unlike an index predicate or a
-- GENERATED ALWAYS AS column) has no IMMUTABLE-function requirement in
-- PostgreSQL - only STABLE/VOLATILE functions referencing other rows/
-- tables are disallowed, which this expression does not do. `now()`/
-- `current_date` and timezone conversions are STABLE (constant within one
-- statement), so this evaluates cleanly and predictably against the row
-- being written, exactly like the `current_date` version it replaces -
-- this is standard, widely-used PostgreSQL practice (e.g. `check (order_date
-- <= current_date)` is a common pattern), not something Postgres rejects.
-- A trigger-based equivalent was considered and is unnecessary here: this
-- CHECK re-evaluates "today" fresh on every INSERT/UPDATE, which is exactly
-- the desired behavior (validate against the current Israel date at write
-- time; never retroactively re-validate an already-stored value against a
-- later "today" - dates cannot become more future as time passes, so a
-- once-valid date_of_birth can never later fail this same check on an
-- unrelated profile update).
alter table public.profiles
  add constraint profiles_date_of_birth_not_future check (
    date_of_birth is null
    or date_of_birth <= (now() at time zone 'Asia/Jerusalem')::date
  );

-- Allows date_of_birth to be set exactly once (NULL -> a real date).
-- Any further change - by the owning customer via the column-level UPDATE
-- grant below, or by anything else - is rejected at the database level.
-- This is the actual anti-abuse control (see claim_my_birthday_bonus()'s
-- own uniqueness guarantee below for why this matters): without it, a
-- customer could change their stored birthday to "today" every year and
-- claim a fresh bonus indefinitely.
create or replace function public.prevent_date_of_birth_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.date_of_birth is not null and new.date_of_birth is distinct from old.date_of_birth then
    raise exception 'date_of_birth_locked' using errcode = '42501';
  end if;

  return new;
end;
$$;

create or replace trigger profiles_prevent_date_of_birth_change
before update on public.profiles
for each row
execute function public.prevent_date_of_birth_change();

-- Additive - existing "grant update (full_name, phone, profession) ..." from
-- 001_create_profiles.sql is untouched; this simply extends the same
-- authenticated role's column-level UPDATE grant to also cover
-- date_of_birth. Whole-row RLS (profiles_set_updated_at's own "Users can
-- update their own profile" policy) still applies unchanged.
grant update (date_of_birth) on table public.profiles to authenticated;

-- handle_new_user(): unchanged behavior for full_name/phone/profession,
-- extended to also parse date_of_birth from the same signUp() metadata
-- payload the client already sends full_name/phone/profession through (see
-- src/context/AuthContext.js's signUp()). Wrapped in its own
-- BEGIN...EXCEPTION block and defensively re-checked against the exact same
-- Israel business-date expression as profiles_date_of_birth_not_future
-- above and claim_my_birthday_bonus() below - (now() at time zone
-- 'Asia/Jerusalem')::date, not current_date - a malformed or future value
-- in the metadata is silently dropped to NULL rather than ever raising,
-- exactly like this function's existing lenient handling of every other
-- field: this trigger fires on every auth.users insert, and it must never
-- fail a signup over profile data. Using the SAME comparison basis as the
-- table's own CHECK constraint is not just for consistency - it is what
-- guarantees this pre-check can never let a value through that the
-- INSERT below would then have the CHECK constraint reject: if the two
-- expressions disagreed (e.g. this used UTC while the CHECK used Israel
-- time), a date that looked "not future" here but was technically future
-- per the CHECK would make the INSERT raise a constraint-violation
-- exception, which - unlike the deliberate NULL-fallback this function
-- uses everywhere else - is NOT caught, and would fail the entire signup.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_full_name text;
  v_phone text;
  v_profession text;
  v_date_of_birth date;
begin
  v_full_name := coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'), ''), 'User');
  v_phone := coalesce(trim(new.raw_user_meta_data->>'phone'), '');
  v_profession := nullif(trim(new.raw_user_meta_data->>'profession'), '');

  begin
    v_date_of_birth := nullif(trim(new.raw_user_meta_data->>'date_of_birth'), '')::date;
  exception when others then
    v_date_of_birth := null;
  end;

  if v_date_of_birth is not null and v_date_of_birth > (now() at time zone 'Asia/Jerusalem')::date then
    v_date_of_birth := null;
  end if;

  insert into public.profiles (
    id,
    full_name,
    phone,
    profession,
    points_balance,
    membership_level,
    approved_purchases_count,
    date_of_birth
  )
  values (
    new.id,
    v_full_name,
    v_phone,
    v_profession,
    0,
    'BRONZE',
    0,
    v_date_of_birth
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

-- ------------------------------------------------------------------------
-- Part 2: annual birthday bonus

-- Nullable - only ever populated on 'birthday_bonus' rows (see the check
-- constraint below); every existing row/type is unaffected.
alter table public.points_transactions add column if not exists reward_year integer;

alter table public.points_transactions
  add constraint points_transactions_birthday_bonus_requires_year check (
    transaction_type <> 'birthday_bonus' or reward_year is not null
  );

-- Keep this literal in sync with BIRTHDAY_BONUS_POINTS below (the RPC is the
-- only thing that ever inserts a 'birthday_bonus' row, so the two can never
-- drift in practice, but the constraint is a genuine second guarantee, not
-- just documentation).
alter table public.points_transactions
  add constraint points_transactions_birthday_bonus_points_value check (
    transaction_type <> 'birthday_bonus' or points = 1000
  );

-- At most one birthday bonus per (user_id, reward_year) - the schema-level
-- half of the anti-duplicate guarantee, alongside claim_my_birthday_bonus()'s
-- own `for update` row lock below. Same partial-unique-index technique as
-- idx_points_transactions_one_purchase_reward_per_report above.
create unique index if not exists idx_points_transactions_one_birthday_bonus_per_year
  on public.points_transactions (user_id, reward_year)
  where transaction_type = 'birthday_bonus';

-- public.claim_my_birthday_bonus(): the customer's own self-service,
-- idempotent-per-day eligibility check + award. Safe to call every time an
-- authenticated session starts (see src/context/AuthContext.js) - on every
-- non-birthday day, or a birthday already claimed this year, it is a
-- read-only no-op that simply returns the current balance.
--
--   1. Resolves the caller strictly from auth.uid() - never a parameter,
--      so the client cannot claim a bonus for anyone else.
--   2. Locks the caller's own profiles row with `for update` (same
--      concurrency technique as award_purchase_points()) - two
--      near-simultaneous calls from the same session (e.g. a duplicate
--      effect firing) serialize on this lock, and the second one correctly
--      finds the already-inserted ledger row and returns awarded = false.
--   3. If date_of_birth is NULL (existing customer who hasn't set one, or
--      a brand-new one mid-registration), returns awarded = false with no
--      further work - never invents a birthday.
--   4. "Today" is the Israel-local calendar date -
--      (now() at time zone 'Asia/Jerusalem')::date - not UTC-midnight and
--      not whatever timezone the calling device happens to be in. Postgres
--      resolves 'Asia/Jerusalem' through the IANA tz database, so this
--      stays correct across Israel's own DST transitions automatically.
--   5. Feb 29 birthdays: in a leap reward_year the qualifying day is Feb
--      29; in a non-leap reward_year it's Feb 28. Every other birthday
--      compares month+day directly.
--   6. If today is not the birthday, or a 'birthday_bonus' row for this
--      (user_id, reward_year) already exists, returns awarded = false with
--      no write at all - safe to call repeatedly within the same day/year.
--   7. Otherwise inserts exactly one ledger row and increments
--      profiles.points_balance by BIRTHDAY_BONUS_POINTS (a DB-side
--      increment, never a client-supplied balance) inside this same
--      atomic call, and returns awarded = true with the new balance.
create or replace function public.claim_my_birthday_bonus()
returns table (awarded boolean, points_balance integer, bonus_points integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles;
  v_today date;
  v_dob date;
  v_is_birthday boolean := false;
  v_reward_year integer;
  v_points constant integer := 1000; -- BIRTHDAY_BONUS_POINTS
  v_new_balance integer;
  v_is_leap_year boolean;
begin
  if v_user_id is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  select * into v_profile from public.profiles where id = v_user_id for update;

  if not found then
    raise exception 'profile_not_found' using errcode = 'P0002';
  end if;

  v_dob := v_profile.date_of_birth;

  if v_dob is null then
    return query select false, v_profile.points_balance, 0;
    return;
  end if;

  v_today := (now() at time zone 'Asia/Jerusalem')::date;
  v_reward_year := extract(year from v_today)::integer;

  if extract(month from v_dob)::int = 2 and extract(day from v_dob)::int = 29 then
    v_is_leap_year := (v_reward_year % 4 = 0 and (v_reward_year % 100 <> 0 or v_reward_year % 400 = 0));

    if v_is_leap_year then
      v_is_birthday := extract(month from v_today)::int = 2 and extract(day from v_today)::int = 29;
    else
      v_is_birthday := extract(month from v_today)::int = 2 and extract(day from v_today)::int = 28;
    end if;
  else
    v_is_birthday := extract(month from v_today)::int = extract(month from v_dob)::int
      and extract(day from v_today)::int = extract(day from v_dob)::int;
  end if;

  if not v_is_birthday then
    return query select false, v_profile.points_balance, 0;
    return;
  end if;

  if exists (
    select 1 from public.points_transactions
    where user_id = v_user_id
      and transaction_type = 'birthday_bonus'
      and reward_year = v_reward_year
  ) then
    return query select false, v_profile.points_balance, 0;
    return;
  end if;

  insert into public.points_transactions (
    user_id, transaction_type, points, reward_year, created_by
  ) values (
    v_user_id, 'birthday_bonus', v_points, v_reward_year, v_user_id
  );

  update public.profiles
  set points_balance = points_balance + v_points
  where id = v_user_id
  returning points_balance into v_new_balance;

  return query select true, v_new_balance, v_points;
end;
$$;

revoke execute on function public.claim_my_birthday_bonus() from anon;
revoke execute on function public.claim_my_birthday_bonus() from public;
-- Granted broadly to `authenticated`, same reasoning as every other RPC in
-- this schema - the function only ever operates on auth.uid()'s own row, so
-- there is no per-caller authorization decision left to make outside it.
grant execute on function public.claim_my_birthday_bonus() to authenticated;