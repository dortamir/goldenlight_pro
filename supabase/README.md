# Supabase setup

This folder contains the database foundation for the GOLDEN+ profile layer and the upcoming purchase-report workflow.

## Profiles table

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

## Purchase reports table

The public.purchase_reports table stores receipt submissions for authenticated users.
It is intended to hold intake information for the future purchase-review workflow.

### User-controlled fields
- user_id
- receipt_path
- original_filename

### Backend/admin-controlled fields
- status
- points_awarded
- admin_note

The mobile client may only create a purchase report with the default submitted state and zero points.
It may not update or delete reports directly.

## Status lifecycle

A report begins as submitted and may later move through processing, needs_review, approved, or rejected by trusted backend/admin logic.

## Private receipts bucket

The receipts storage bucket is private and is intended for receipt images and PDFs only.
Receipt files are stored using a private path structure rooted under the authenticated user's id.

### Storage path convention

Receipt files should be uploaded to paths shaped like:

<authenticated-user-id>/<purchase-report-id>/<filename>

Example:

550e8400-e29b-41d4-a716-446655440000/87b774db-1234-5678-9999-abcdef123456/receipt.jpg

This makes it possible for Storage RLS to verify that the owner of the top-level folder matches the authenticated user.

## RLS behavior

Row Level Security is enabled on public.purchase_reports so users can only select their own reports and insert reports that are tied to their own auth.uid().
The client is not granted update or delete privileges on the table.

## Why receipt URLs are not public

Receipt files are intentionally private.
The app should later access them through authenticated Storage requests or signed URLs rather than storing public URLs in the database.

## How to run the migrations manually

1. Open the Supabase SQL Editor.
2. Paste the contents of supabase/migrations/001_create_profiles.sql.
3. Paste the contents of supabase/migrations/002_create_purchase_reports.sql.
4. Run the migrations.
5. Confirm that the tables, triggers, RLS policies, and storage policies were created.

## Notes

- Email is still managed by Supabase Auth and is not duplicated in profiles.
- The schema is intentionally limited to the receipt foundation and does not yet include OCR, payment totals, or point-award automation.
