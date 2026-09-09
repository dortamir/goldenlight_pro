-- Fixes PostgreSQL error 42702 ("column reference \"points_balance\" is
-- ambiguous"), reported live: the birthday-claim RPC executes with a valid
-- session (Stage 32.5.1's session-guard fix confirmed working) but the
-- underlying function itself errors before it can ever insert the
-- points_transactions row or increment the balance.
--
-- ROOT CAUSE: public.claim_my_birthday_bonus() (028_birthday_bonus.sql) is
-- declared `returns table (awarded boolean, points_balance integer,
-- bonus_points integer)`. For a `returns table (...)` plpgsql function,
-- each declared output column name is implicitly visible as a variable
-- throughout the function body - exactly like a DECLARE'd variable - for
-- the entire duration of the function, not just inside the final `return
-- query` statements. `public.profiles` also has a real column literally
-- named `points_balance`. The function's own award step:
--
--   update public.profiles
--   set points_balance = points_balance + v_points
--   where id = v_user_id
--   returning points_balance into v_new_balance;
--
-- - contains two BARE references to `points_balance` (the right-hand side
-- of the SET expression, and the RETURNING clause) that sit inside an
-- embedded SQL command run from plpgsql. Postgres has two equally valid
-- candidates for each: the OUT parameter/implicit variable `points_balance`
-- and the table column `public.profiles.points_balance` - and refuses to
-- guess, raising 42702. (The `set points_balance = ...` target on the LEFT
-- of `=` is NOT ambiguous - per standard UPDATE syntax, a SET target is
-- always resolved as a column of the table being updated, never as a
-- plpgsql variable - so only the right-hand side and the RETURNING clause
-- are affected.)
--
-- This is why the bug was invisible in every earlier stage's testing until
-- now: it only executes on a REAL, physically-reached birthday - every
-- prior test day, `claim_my_birthday_bonus()` returned early at the
-- `if not v_is_birthday then return query select false, ...; end if;`
-- guard, long before ever reaching this UPDATE statement.
--
-- FIX: qualify the target table with an explicit alias (`p`) and use that
-- alias for every reference that could otherwise collide with the OUT
-- parameter of the same name - `p.points_balance` can only ever mean the
-- table column, never the implicit output variable. `where id = v_user_id`
-- is similarly re-qualified as `where p.id = v_user_id` purely for
-- consistency/clarity with the alias now in scope on this statement -
-- `id` has no OUT-parameter or DECLARE'd variable of the same name
-- anywhere in this function, so it was never actually ambiguous, but
-- leaving it unqualified while its sibling column is alias-qualified on
-- the same statement would be inconsistent and harder to audit at a
-- glance. Nothing else in this function changes.
--
-- STATIC REVIEW FOR OTHER OUT-COLUMN / TABLE-COLUMN COLLISIONS (performed
-- before writing this migration, not assumed):
--   - `awarded`: never referenced as a bare identifier anywhere in the
--     function body outside the `return query select true/false, ...`
--     statements themselves (where it is a literal boolean, not a column
--     reference) - no table in this schema has a column named `awarded` -
--     no collision.
--   - `bonus_points`: same - no table anywhere in this schema (including
--     points_transactions, whose points column is named `points`, not
--     `bonus_points`) has a column of this name - no collision.
--   - `points_balance`: the only real collision, fixed above. Every OTHER
--     reference to it in this function is `v_profile.points_balance`
--     (three occurrences, inside the three early `return query select
--     false, v_profile.points_balance, 0;` branches) - already
--     dot-qualified against the `v_profile public.profiles` record
--     variable, so already fully unambiguous and requires no change.
--
-- Every other property of this function is preserved byte-for-byte from
-- 028: the 1,000-point amount (v_points constant integer := 1000),
-- identity exclusively from auth.uid(), the Israel-local
-- ((now() at time zone 'Asia/Jerusalem')::date) date basis, the Feb 29
-- leap-year handling, the `for update` row lock, the once-per-year
-- `exists(...)` duplicate check (independent of and in addition to the
-- unchanged idx_points_transactions_one_birthday_bonus_per_year partial
-- unique index from 028, which this migration does not touch), the
-- points_transactions insert, the profiles.points_balance increment
-- itself (still exactly `+ v_points`, just correctly qualified), the
-- exact return shape (awarded, points_balance, bonus_points), and the
-- SECURITY DEFINER / set search_path = '' security posture. No
-- signature/return-type change (still () -> table (boolean, integer,
-- integer)), so CREATE OR REPLACE is sufficient - no DROP FUNCTION
-- needed. The revoke/grant statements below are reissued anyway purely to
-- match this schema's own established convention (every function-defining
-- migration in this project is fully self-contained) - Postgres does not
-- reset a function's grants when its signature is unchanged, so nothing
-- was actually at risk of being lost.
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

  update public.profiles p
  set points_balance = p.points_balance + v_points
  where p.id = v_user_id
  returning p.points_balance into v_new_balance;

  return query select true, v_new_balance, v_points;
end;
$$;

revoke execute on function public.claim_my_birthday_bonus() from anon;
revoke execute on function public.claim_my_birthday_bonus() from public;
grant execute on function public.claim_my_birthday_bonus() to authenticated;
