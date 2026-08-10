-- Create purchase reports table for receipt submissions

create table if not exists public.purchase_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  receipt_path text not null,
  original_filename text,
  status text not null default 'submitted' constraint purchase_reports_status_check check (
    status in ('submitted', 'processing', 'needs_review', 'approved', 'rejected')
  ),
  points_awarded integer not null default 0 constraint purchase_reports_points_awarded_nonnegative check (points_awarded >= 0),
  admin_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.purchase_reports enable row level security;

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

drop trigger if exists purchase_reports_set_updated_at on public.purchase_reports;
create trigger purchase_reports_set_updated_at
before update on public.purchase_reports
for each row
execute function public.set_updated_at();

create index if not exists idx_purchase_reports_status
  on public.purchase_reports (status);

create index if not exists idx_purchase_reports_user_id_created_at
  on public.purchase_reports (user_id, created_at desc);

revoke all on table public.purchase_reports from anon;
revoke all on table public.purchase_reports from authenticated;
revoke all on table public.purchase_reports from public;

grant select on table public.purchase_reports to authenticated;
grant insert (user_id, receipt_path, original_filename) on table public.purchase_reports to authenticated;
grant usage on schema public to authenticated;

drop policy if exists "Authenticated users can view their own purchase reports" on public.purchase_reports;
drop policy if exists "Authenticated users can insert their own purchase reports" on public.purchase_reports;

create policy "Authenticated users can view their own purchase reports"
  on public.purchase_reports
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Authenticated users can insert their own purchase reports"
  on public.purchase_reports
  for insert
  to authenticated
  with check (
    auth.uid() = user_id
    and status = 'submitted'
    and points_awarded = 0
    and admin_note is null
  );

-- Create a private receipts bucket for uploaded files
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'receipts',
  'receipts',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do update
set name = excluded.name,
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Authenticated users can upload receipts to their own folder" on storage.objects;
drop policy if exists "Authenticated users can view receipts in their own folder" on storage.objects;

create policy "Authenticated users can upload receipts to their own folder"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Authenticated users can view receipts in their own folder"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
