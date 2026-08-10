-- Create profiles table for Supabase Auth users

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  phone text not null,
  profession text,
  points_balance integer not null default 0 constraint profiles_points_balance_nonnegative check (points_balance >= 0),
  membership_level text not null default 'BRONZE',
  approved_purchases_count integer not null default 0 constraint profiles_approved_purchases_count_nonnegative check (approved_purchases_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace trigger profiles_set_updated_at
before update on public.profiles
for each row
execute function public.set_updated_at();

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
begin
  v_full_name := coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'), ''), 'User');
  v_phone := coalesce(trim(new.raw_user_meta_data->>'phone'), '');
  v_profession := nullif(trim(new.raw_user_meta_data->>'profession'), '');

  insert into public.profiles (
    id,
    full_name,
    phone,
    profession,
    points_balance,
    membership_level,
    approved_purchases_count
  )
  values (
    new.id,
    v_full_name,
    v_phone,
    v_profession,
    0,
    'BRONZE',
    0
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

create or replace trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_user();

insert into public.profiles (id, full_name, phone, profession, points_balance, membership_level, approved_purchases_count)
select
  au.id,
  coalesce(
    nullif(trim(au.raw_user_meta_data->>'full_name'), ''),
    'User'
  ),
  coalesce(trim(au.raw_user_meta_data->>'phone'), ''),
  nullif(trim(au.raw_user_meta_data->>'profession'), ''),
  0,
  'BRONZE',
  0
from auth.users au
left join public.profiles p on p.id = au.id
where p.id is null
on conflict (id) do nothing;

create policy "Users can view their own profile"
  on public.profiles
  for select
  using (auth.uid() = id);

create policy "Users can update their own profile"
  on public.profiles
  for update
  using (auth.uid() = id)
  with check (
    auth.uid() = id
    and full_name is not null
    and phone is not null
  );

revoke all on table public.profiles from anon;
revoke all on table public.profiles from authenticated;
revoke all on table public.profiles from public;

grant select on table public.profiles to authenticated;
grant update (full_name, phone, profession) on table public.profiles to authenticated;
grant usage on schema public to authenticated;

alter table public.profiles alter column points_balance set default 0;
alter table public.profiles alter column membership_level set default 'BRONZE';
alter table public.profiles alter column approved_purchases_count set default 0;
