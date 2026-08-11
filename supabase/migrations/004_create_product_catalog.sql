-- Create product catalog tables for Golden Light products and matching aliases

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  name text not null,
  description text,
  brand text not null default 'Golden Light',
  category text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.product_aliases (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  alias text not null,
  normalized_alias text not null,
  created_at timestamptz not null default now(),
  constraint product_aliases_normalized_alias_unique unique (normalized_alias)
);

create or replace function public.normalize_catalog_text(input_text text)
returns text
language sql
set search_path = ''
as $$
  select regexp_replace(
    regexp_replace(
      lower(trim(coalesce(input_text, ''))),
      '[-_/\\]+',
      '',
      'g'
    ),
    '\s+',
    '',
    'g'
  );
$$;

create or replace function public.set_normalized_alias()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.normalized_alias = public.normalize_catalog_text(new.alias);
  return new;
end;
$$;

drop trigger if exists products_set_updated_at on public.products;
create trigger products_set_updated_at
before update on public.products
for each row
execute function public.set_updated_at();

drop trigger if exists product_aliases_set_normalized_alias on public.product_aliases;
create trigger product_aliases_set_normalized_alias
before insert or update on public.product_aliases
for each row
execute function public.set_normalized_alias();

alter table public.products enable row level security;
alter table public.product_aliases enable row level security;

create index if not exists idx_product_aliases_product_id on public.product_aliases (product_id);

revoke all on table public.products from anon;
revoke all on table public.products from authenticated;
revoke all on table public.products from public;

revoke all on table public.product_aliases from anon;
revoke all on table public.product_aliases from authenticated;
revoke all on table public.product_aliases from public;

grant select on table public.products to authenticated;
grant select on table public.product_aliases to authenticated;

grant usage on schema public to authenticated;
revoke execute on function public.normalize_catalog_text(text) from anon;
revoke execute on function public.normalize_catalog_text(text) from public;
revoke execute on function public.normalize_catalog_text(text) from authenticated;
revoke execute on function public.set_normalized_alias() from anon;
revoke execute on function public.set_normalized_alias() from public;
revoke execute on function public.set_normalized_alias() from authenticated;

drop policy if exists "Authenticated users can read active products" on public.products;
drop policy if exists "Authenticated users can read product aliases" on public.product_aliases;

create policy "Authenticated users can read active products"
  on public.products
  for select
  to authenticated
  using (is_active = true);

create policy "Authenticated users can read product aliases"
  on public.product_aliases
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.products p
      where p.id = product_aliases.product_id
        and p.is_active = true
    )
  );
