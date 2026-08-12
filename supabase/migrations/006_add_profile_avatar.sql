-- Add profile avatar support: avatar_path column, extended column grant,
-- private profile-avatars Storage bucket, and per-user Storage RLS.
-- avatar_path stores only a Storage object path (e.g. "<user-id>/avatar.jpg"),
-- never a signed URL, public URL, or base64 image data.

alter table public.profiles
  add column if not exists avatar_path text;

-- Extend the existing column-level UPDATE grant (see 001_create_profiles.sql)
-- so authenticated users may also update their own avatar_path. This is
-- additive and does not touch the existing full_name/phone/profession grant,
-- and does not grant update access to any backend-controlled column
-- (points_balance, membership_level, approved_purchases_count, id,
-- created_at, updated_at remain ungrantable to authenticated).
grant update (avatar_path) on table public.profiles to authenticated;

-- Create a private Storage bucket for profile avatars.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'profile-avatars',
  'profile-avatars',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set name = excluded.name,
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Authenticated users can upload their own avatar" on storage.objects;
drop policy if exists "Authenticated users can view their own avatar" on storage.objects;
drop policy if exists "Authenticated users can update their own avatar" on storage.objects;
drop policy if exists "Authenticated users can delete their own avatar" on storage.objects;

create policy "Authenticated users can upload their own avatar"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'profile-avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Authenticated users can view their own avatar"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'profile-avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Authenticated users can update their own avatar"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'profile-avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'profile-avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Authenticated users can delete their own avatar"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'profile-avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
