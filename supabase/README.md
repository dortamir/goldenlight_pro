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

## Product catalog table

The public.products table stores the official Golden Light catalog entries.
Each product has a stable sku, a display name, an optional description, and a category/brand label.

### What the catalog stores
- sku
- name
- description
- brand
- category
- is_active

The product catalog is intended for future OCR and receipt matching workflows.
It is kept separate from point calculations so points rules can be introduced later without changing the catalog schema.

## Product aliases table

The public.product_aliases table stores alternate spellings and shorthand variants that may appear on invoices or receipts.
Examples include different separator styles or variants such as GL10452 or SPOT GL 7W.

Aliases are stored together with a deterministic normalized_alias value that is set automatically by the database trigger. This keeps normalization consistent and prevents formatting-only variants from drifting out of sync.

For the current deterministic model, aliases that normalize to the same value should generally be stored once. For example, GL-10452, GL 10452, GL/10452, and GL_10452 should all resolve to the same normalized value, so inserting multiple formatting variants as separate rows would conflict by design.

## Read-only access for mobile clients

Authenticated mobile users may read active products and aliases.
They may not insert, update, or delete catalog rows.
Anonymous users have no access.

## Receipt OCR foundation

The public.receipt_ocr_results and public.receipt_ocr_lines tables store OCR output for a purchase report so that a later processing/matching layer can parse receipt lines, match SKUs/product names against the product catalog, and flag uncertain cases for needs_review.

This is a data foundation only. No OCR provider has been chosen or integrated, no product matching runs against this data yet, and no points logic exists. Those are separate future steps.

### receipt_ocr_results

One row per purchase report (purchase_report_id is unique), holding the OCR run as a whole:

- raw_text: the full OCR text as returned/normalized from the OCR provider.
- provider: a free-text label for which OCR provider produced the result (for example google_vision, azure, aws_textract, manual). No enum is enforced yet, since the provider has not been chosen.
- status: the OCR run lifecycle, one of pending, processing, completed, failed. Defaults to pending.
- error_message: internal processing/error detail for backend debugging. This column is intentionally excluded from the mobile client's read grant and must never be exposed directly to mobile users.
- processed_at: when OCR processing finished for this report.

### receipt_ocr_lines

Zero or more rows per OCR result, one per detected receipt line, for future matching:

- raw_text: the OCR text for that line exactly as detected.
- normalized_text: a lightweight, deterministic normalization of raw_text (trimmed, lowercased, repeated whitespace collapsed) via public.normalize_receipt_line(). This is intentionally different from public.normalize_catalog_text() used by the product catalog: catalog normalization strips separators/whitespace entirely to produce a matching key, while receipt line normalization preserves readable structure. No fuzzy matching is implemented at this stage.
- detected_quantity, detected_unit_price, detected_total: optional numeric values extracted from the line, when available.

product_id and Golden Light match/confidence columns are intentionally not part of this schema yet. Product matching against the catalog is deferred until the real Golden Light product list is available and a matching layer is designed.

### OCR lifecycle

A receipt_ocr_results row is expected to move through pending -> processing -> completed (or failed) as a trusted backend/service-role OCR processing job runs. This migration does not create any trigger that changes purchase_reports.status; status transitions for purchase reports remain the responsibility of the future OCR processing service.

### Access model

OCR data is entirely backend-controlled:

- Row Level Security is enabled on both tables.
- Authenticated mobile users may only SELECT OCR results and OCR lines that belong to their own purchase reports (verified via an EXISTS check back to purchase_reports.user_id = auth.uid(), chained through receipt_ocr_results for OCR lines).
- Mobile clients have no INSERT, UPDATE, or DELETE privileges on either table.
- anon has no access at all.
- OCR rows are written only by trusted backend/service-role logic, not by the app.

## Notes

- Email is still managed by Supabase Auth and is not duplicated in profiles.
- The schema now includes an OCR data foundation (receipt_ocr_results, receipt_ocr_lines) in addition to the catalog foundation, but still does not include product matching, payment totals, point rules, or admin management flows.
