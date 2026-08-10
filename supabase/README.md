# Supabase profiles setup

This folder contains the initial database foundation for the GOLDEN+ user profile layer.

## What the profiles table stores

The public.profiles table stores the profile data for each Supabase Auth user.
It is linked one-to-one to auth.users by the user id.

### User-editable fields
- full_name
- phone
- profession

### Backend-controlled fields
- points_balance
- membership_level
- approved_purchases_count

These values are protected by constraints and RLS so they are not directly editable from the mobile app.

## Why RLS is enabled

Row Level Security is enabled so users can only read and update their own profile row.
This keeps profile data isolated per account and prevents cross-user access.

## How to run the migration manually

1. Open the Supabase SQL Editor.
2. Paste the contents of supabase/migrations/001_create_profiles.sql.
3. Run the migration.
4. Confirm that the public.profiles table, trigger, and RLS policies were created.

## Notes

- Email is still managed by Supabase Auth and is not duplicated in profiles.
- The schema is intentionally limited to profile foundation only.
