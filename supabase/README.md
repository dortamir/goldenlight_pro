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

## process-receipt Edge Function

`supabase/functions/process-receipt` is the server-side foundation for OCR processing. It is source-only in this repository - it has not been deployed, and it does not run real OCR yet.

Its source is split across four files:

- `index.ts` - the HTTP handler: auth, ownership verification, orchestration, and response shaping.
- `ocrProvider.ts` - the provider adapter (Azure Document Intelligence integration goes here later).
- `ocrParser.ts` - provider-agnostic normalization/validation of OCR output into a DB-ready shape.
- `ocrPersistence.ts` - writes the parsed result into `receipt_ocr_results`/`receipt_ocr_lines`, retry-safe.

A `tsconfig.json` and `deno.d.ts` also live under `supabase/functions/` purely so an editor's TypeScript checker doesn't report false errors for Deno's runtime globals and its `https://...` URL imports - neither affects the function at runtime; Deno resolves and type-checks all of this for real when the function actually runs.

### What it does today

Given `{ "purchaseReportId": "<uuid>" }`, the function:

1. Resolves the caller's identity from their Supabase session (the `Authorization` header), never from the request body. An unauthenticated request gets a 401.
2. Loads the matching `public.purchase_reports` row with a service-role client and checks `user_id` against the authenticated caller. If the report doesn't exist or belongs to someone else, the response is identical either way (a generic not-found), so a caller can never tell the two cases apart.
3. Upserts exactly one `public.receipt_ocr_results` row for that report (`purchase_report_id` is unique, so this is safe to call repeatedly - no duplicate rows are ever created) and sets `status = 'processing'`.
4. Moves `purchase_reports.status` from `submitted` to `processing`. No other purchase_reports column is touched - `points_awarded` and every profile field (`points_balance`, `membership_level`, `approved_purchases_count`) are never written by this function, because no points or matching logic exists yet.
5. Downloads the real receipt file from the private `receipts` bucket using `purchase_reports.receipt_path` as loaded from the database - never a path sent by the client, and never via a public URL.
6. Calls the internal OCR provider adapter (`ocrProvider.ts`). Until real provider credentials are configured, this adapter always reports itself as unavailable rather than inventing OCR output.
7. If the provider had succeeded, its output would be normalized/validated (`ocrParser.ts`) and persisted (`ocrPersistence.ts`) here - not reachable today, see below.
8. On any failure (download failure, provider unavailable, or - once reachable - an empty/unusable result or a persistence error), the function records that safely: `receipt_ocr_results.status = 'failed'` with an `error_message`, and `purchase_reports.status = 'needs_review'` (never `approved`, never fake success).

### Authenticated ownership verification

The function uses two different Supabase clients for two different jobs:

- A short-lived client built with the caller's own `Authorization` header and the anon key, used only to call `auth.getUser()` and resolve who is actually calling. It is discarded immediately after and never used to read/write data.
- A service-role client, used for every privileged read/write (loading the report, writing OCR rows, updating status, downloading the private file). Because this client bypasses RLS, the function itself is responsible for re-checking that `purchase_reports.user_id` matches the authenticated caller before doing anything with that report - this is done explicitly rather than relying on RLS.

### Private receipt access

The receipts bucket stays private. The function only ever downloads the exact object at the `receipt_path` already stored on the purchase report row - it never calls `getPublicUrl`, never accepts a path from the request, and never generates or returns a signed URL to the caller.

### Provider adapter contract

Every OCR provider adapter (`ocrProvider.ts` today, and any future one) must resolve to a `NormalizedOcrResult` on success - a plain, vendor-neutral shape with no Azure-specific (or any other vendor's) fields:

```ts
interface NormalizedOcrLine {
  text: string;
  quantity?: number | null;
  unitPrice?: number | null;
  total?: number | null;
}

interface NormalizedOcrResult {
  rawText: string;
  lines: NormalizedOcrLine[];
}
```

`index.ts` only ever talks to this contract, never to a vendor SDK/API directly - a provider swap or addition later stays isolated inside `ocrProvider.ts`, which is responsible for translating that vendor's real response shape into this one.

### Line parsing behavior (`ocrParser.ts`)

`parseOcrResult()` converts a provider's `NormalizedOcrResult` into the DB-ready shape actually written to `receipt_ocr_lines`:

- Each line's text is trimmed and has repeated internal whitespace collapsed - Hebrew, English, digits, and punctuation are all preserved as-is. This is intentionally lighter-touch than `public.normalize_catalog_text()` (used for product/alias matching): no separators are stripped and nothing is lowercased.
- Empty/whitespace-only lines are dropped entirely rather than persisted as blank rows.
- `line_index` is assigned sequentially starting at `0` over the remaining lines, in order - a provider-supplied index (if any) is never trusted or preserved, so there are never gaps.
- `quantity`/`unitPrice`/`total` are only kept if they are an actual finite, non-negative number (`normalizeNonNegativeNumber()`); `NaN`, `Infinity`, negative values, missing values, or non-numeric values (e.g. a string) all become `null`. Nothing is ever guessed from surrounding text.
- `isEmptyOcrResult()` flags a result that has no raw text or no lines left after cleanup, so `index.ts` can treat a "technically successful but useless" provider response as a failure (`error_message: 'empty_ocr_result'`) instead of persisting a meaningless `completed` result.

`normalized_text` on `receipt_ocr_lines` is never computed here - the `receipt_ocr_lines_set_normalized_text` trigger (migration `005_create_receipt_ocr.sql`) derives it from `raw_text` automatically on insert.

A dev-only test file, `ocrParser.test.ts`, exercises this logic with Deno's built-in test runner (`deno test supabase/functions/process-receipt/ocrParser.test.ts` - no test framework installed). It covers: whitespace cleanup while preserving Hebrew/English, dropping empty lines without leaving index gaps, preserving already-clean mixed-language text, accepting a valid quantity, and rejecting `NaN`/negative/`Infinity`/non-numeric values as `null`.

### Retry-safe persistence (`ocrPersistence.ts`)

`persistOcrResult()` writes a completed OCR result and replaces its lines:

1. Upserts `receipt_ocr_results` on the unique `purchase_report_id` column (`raw_text`, `provider`, `status: 'completed'`, `processed_at`, `error_message: null`) - safe to call again for the same report; it updates the same row rather than creating a duplicate.
2. Deletes any existing `receipt_ocr_lines` for that `ocr_result_id`, then inserts the freshly parsed set. This is what makes retries safe: re-running OCR for the same purchase report can never append duplicate lines or leave stale lines from an earlier attempt behind. This delete is only reachable through the service-role client - the mobile client has no delete (or insert/update) privilege on `receipt_ocr_lines` at all.

**Non-atomic delete+insert - a real, documented limitation.** Supabase client calls are each their own request, not one Postgres transaction. The delete and the subsequent insert are two separate statements, so if this function crashes or the insert fails after the delete already succeeded, the report is briefly (or persistently, if nothing retries it) left with zero lines. `persistOcrResult()` throws in that case so `index.ts` marks the OCR result `failed` rather than silently leaving inconsistent state, but the underlying gap is real. This foundation does not attempt to paper over it with client-side tricks. If it becomes a real risk once a provider is connected, the correct fix is a single Postgres function (an RPC called via `supabase.rpc(...)`) that performs the delete+insert inside one explicit transaction - that would require a new migration and should be reviewed on its own rather than added speculatively here.

### `completed` OCR vs. purchase report `needs_review`

These describe two different things and must not be conflated:

- `receipt_ocr_results.status = 'completed'` means OCR itself succeeded - real text and lines were extracted and persisted.
- `purchase_reports.status` moves to `'needs_review'` immediately afterward regardless, because product matching and approval are separate, unimplemented stages. OCR completing successfully is *not* the same as a purchase being approved, and this function never sets `purchase_reports.status = 'approved'` under any circumstance.

### Response semantics

- Bad request / auth / not-found / server misconfiguration: standard HTTP error status (400/401/404/500) with a generic message, no internal detail.
- OCR did not succeed (provider unavailable, download failure, empty result, or a persistence error): HTTP 200 with `{ "ok": false, "purchaseReportId": "...", "status": "needs_review", "error": "OCR processing failed" }` - the request itself was handled correctly, but `ok: false` makes clear OCR did not succeed. No internal error detail (provider error text, exception messages, etc.) is ever included.
- Real future success (once a provider is connected): HTTP 200 with `{ "ok": true, "purchaseReportId": "...", "status": "needs_review" }` - OCR succeeded, but the report still needs product matching/review before any approval.

### Future Azure secret names

Not required yet, and not present anywhere in this repository. When Azure Document Intelligence is connected, `ocrProvider.ts` will read these from the Edge Function's own environment (Supabase project secrets, set with `supabase secrets set` - never as literal values in source control):

- `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT`
- `AZURE_DOCUMENT_INTELLIGENCE_KEY`

The function also expects `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` to be available in the Edge Function runtime, which Supabase provides automatically for deployed functions.

### Why provider credentials never belong in the Expo app

`EXPO_PUBLIC_*` environment variables are bundled into the client and are visible to anyone who inspects the app - that's fine for the anon key (which is designed to be public and is constrained entirely by RLS), but never acceptable for a service-role key or a third-party OCR API key, both of which grant broad, unscoped access. Those secrets exist only inside the Edge Function's server-side environment, which the Expo app never has access to.

### Why product matching/points remain separate

This function's job ends at "real text, safely persisted, report flagged for review." It deliberately does not read `public.products`/`public.product_aliases`, does not attempt to match any `receipt_ocr_lines` row to a catalog entry, and does not compute or award points - those require their own design (matching strategy, confidence handling, points rules) and review, and are not implemented anywhere in this codebase yet. Keeping them out of this function means OCR persistence can be verified and trusted on its own before anything downstream depends on it.

### What's still separate/future

Points calculation and any admin approval flow remain unimplemented. A product matching *foundation* now exists (see below) but is not wired into this function's live flow yet. This function is also not called automatically from `PurchaseScreen` yet - the mobile client is not wired up to invoke it. Those are later stages, each to be reviewed on their own.

## Product matching foundation

`public.receipt_line_matches` (added in `007_create_product_matching.sql`, now applied) and `supabase/functions/process-receipt/productMatcher.ts` / `productMatchPersistence.ts` together classify each OCR receipt line as matched to a real Golden Light product, unmatched, or flagged for manual review. The matcher is now wired into the live `process-receipt` flow (see "Integrated into the live function" below), but no real catalog data has been imported yet, so every real invocation today still resolves every line to `unmatched` - and the function is not deployed.

### `receipt_line_matches` purpose

One row per `receipt_ocr_lines` row (`ocr_line_id` is unique - one *current* matching result per OCR line, safe to re-run and overwrite via upsert). Stores:

- `product_id` - the matched `public.products` row, or `null` when unmatched/no candidate.
- `match_status` - `unmatched` (default), `matched`, or `needs_review`.
- `match_method` - which strategy produced a match (`exact_sku`, `normalized_sku`, `alias`, `name`, and reserved for later: `similarity`, `manual`). Intentionally not a hard-constrained enum in the database, since new strategies are expected over time.
- `confidence` - `null`, or a number in `[0, 1]`. This foundation only ever produces `1.0` for a match (deterministic exact matches) or `null` (no match) - no nuanced confidence scoring exists yet.
- `matched_text` - the specific SKU/alias/name text that caused the match, for auditability.
- `review_note` - internal backend/admin-only note. **Never readable by the mobile client** - excluded from the column-level `SELECT` grant in the migration, the same pattern already used for `receipt_ocr_results.error_message`.

Two database constraints keep `product_id` consistent with `match_status`: it must be set whenever `match_status = 'matched'`, and it must be `null` whenever `match_status = 'unmatched'`. `needs_review` is deliberately left unconstrained on `product_id` so a `needs_review` row can optionally carry a tentative candidate later without a schema change.

### Mobile access

Read-only, and only for the caller's own data: RLS walks `receipt_line_matches.ocr_line_id -> receipt_ocr_lines.ocr_result_id -> receipt_ocr_results.purchase_report_id -> purchase_reports.user_id = auth.uid()`. There are no `INSERT`/`UPDATE`/`DELETE` grants for `authenticated` at all - matching is entirely backend-controlled, written only through the service-role client. `confidence` is included in the client-readable columns (it isn't a secret), but the mobile UI does not display it yet.

### Matching strategies and order (`productMatcher.ts`)

`matchOcrLine(line, catalog)` is a pure function (no Supabase/Deno dependency, no React Native coupling) that tries strategies in order, only moving to the next if the previous found nothing:

1. **Exact raw SKU** - the catalog SKU appears verbatim (case-insensitive, same separators as catalogued) somewhere inside the raw OCR line, e.g. `GL-10452` found inside `"GL-10452 ספוט LED 7W 4 יח"`.
2. **Normalized SKU** - catches formatting variants a raw check would miss (`GL 10452`, `GL/10452`, `GL_10452`, ...) by normalizing both the catalog SKU and the line the same way before comparing.
3. **Exact normalized alias** - the line's normalized text exactly **equals** a known `product_aliases` entry, not merely contains it.
4. **Exact normalized product name** - same equality-based conservatism as aliases.

Strategies 1-2 use substring containment because a real receipt line usually carries more than the bare SKU (quantity, price, description). Strategies 3-4 deliberately use exact equality instead: alias/name text is far more likely to coincide with unrelated words inside a longer line (a SKU pattern is distinctive; a product name usually isn't), so this keeps the foundation conservative rather than treating a small common word as a product match - directly per the "do not invent a match" requirement. No fuzzy/similarity matching is implemented; a `SimilarityMatchStrategy` interface exists purely as a documented, unused extension point for later.

Strategy order is also a priority order: `matchOcrLine()` returns as soon as an earlier strategy finds exactly one candidate, so it never reaches a later strategy at all in that case. A line with a single exact SKU match always resolves via `exact_sku`, even if a different, unrelated product's name or alias happens to coincide with the same line text - that coincidence is never even considered (`productMatcher.test.ts` covers this explicitly: an exact SKU match outranks a coincidental name match for a different product).

### SKU normalization must stay aligned with the database

`normalizeCatalogText()` in `productMatcher.ts` mirrors `public.normalize_catalog_text()` (from `004_create_product_catalog.sql`) exactly: lowercase, trim, strip runs of `-`, `_`, `/`, `\`, then strip all remaining whitespace. Hebrew, English, and digits are all preserved. If either implementation changes, the other must change with it, or a SKU/alias could normalize differently in the app than in Postgres and silently stop matching.

### Ambiguity -> `needs_review`, never a guess

At every strategy, if more than one *distinct* product would qualify (e.g. two different SKUs both appear as substrings in the same OCR line, or two active products happen to share the same normalized name), the result is `needs_review` immediately - `matchOcrLine()` never picks one arbitrarily. `productMatcher.test.ts` covers this explicitly for both the SKU and product-name cases.

Every `needs_review` result also carries a short, fixed internal category in `reviewReason` (e.g. `ambiguous_exact_sku`, `ambiguous_normalized_sku`, `ambiguous_alias`, `ambiguous_name`), persisted into `receipt_line_matches.review_note` by `persistLineMatches()`. This is deliberately a short label, never verbose or raw receipt text, and - like the rest of `review_note` - it is internal/admin-only and excluded from the mobile client's column-level `SELECT` grant. `matched`/`unmatched` results always carry `reviewReason: null`.

### Matching is not points/approval

Even a `matched` result with `confidence: 1.0` on every line in a receipt does **not** mean the purchase report gets approved. Nothing in `productMatcher.ts` or `productMatchPersistence.ts` touches `purchase_reports.status`, `points_awarded`, or any `profiles` column (`points_balance`, `membership_level`, `approved_purchases_count`). Product matching is one input a future, separate approval/points stage would use - it is not that stage.

### Empty catalog behavior

Because no real Golden Light product data has been imported yet, `loadActiveProductCatalog()` will currently return zero products. `matchOcrLine()` treats an empty (or all-inactive) catalog as an explicit, safe case - every line resolves to `unmatched` - rather than ever fabricating a match to make something appear to work. This requires no special-casing in `process-receipt/index.ts`: it calls the matcher the same way regardless of catalog size, and an empty catalog simply produces `unmatched` results for every line, which are persisted normally. A catalog-loading *error* (a genuine database failure, not "zero products") is handled separately - see "Integrated into the live function" below.

### Real catalog import still pending

This foundation cannot produce a real `matched` result until actual Golden Light SKUs/names/aliases are imported into `public.products`/`public.product_aliases` (no sample/test data has been inserted into either table). Until then, running the matcher against real receipts would correctly - and expectedly - classify every line as `unmatched`.

### Integrated into the live function

`process-receipt/index.ts` now calls the matcher after OCR is persisted: `persistOcrResult()` (`ocrPersistence.ts`) returns the freshly inserted `receipt_ocr_lines` rows (including the database-computed `normalized_text`, never recomputed by the matcher), which are fed one by one into `matchOcrLine()` against the catalog from `loadActiveProductCatalog()`, and the results are written with `persistLineMatches()`. This stage still isn't reachable in real use today, because it only runs after OCR itself succeeds, and no OCR provider is configured yet.

Matching failures are isolated from OCR: the matching call is wrapped in its own `try/catch` in `index.ts`. Since OCR is already durably persisted by the time matching runs, a matching error (e.g. a catalog query failure) is logged server-side and swallowed rather than failing the whole request - the purchase report still reaches `needs_review` either way, and a future retry of this function re-runs matching from scratch (safe, since `persistLineMatches()` upserts on `ocr_line_id`).

## Admin authorization foundation

`public.admin_users` (added in `008_create_admin_users.sql`) determines who may access the `/admin` area of the app. This is a foundation only - it does not yet back any privileged read/write beyond the admin route guard itself.

### Why a separate table, not a `profiles.is_admin` flag

Authenticated users already hold a column-level UPDATE grant on their own `profiles` row (`full_name`, `phone`, `profession`, `avatar_path`). Putting an admin flag in that same table would mean every future grant/policy change on `profiles` has to remember to keep excluding it, forever. A separate table with no `authenticated` INSERT/UPDATE/DELETE access at all removes that risk structurally - self-promotion to admin is not possible from the mobile/web client no matter what happens to `profiles`' own grants later.

### Schema

- `user_id` - primary key, references `auth.users(id)`, cascades on delete.
- `created_at` - defaults to `now()`.
- `created_by` - optional provenance only (which admin/service action added this row). Nullable, never required, never used for authorization itself.

### RLS behavior

Row Level Security is enabled. There is no INSERT/UPDATE/DELETE policy for any role - under Postgres RLS, the absence of a policy for an operation denies it by default, so admin membership cannot be written through the app's Supabase client under any circumstance. A narrowly-scoped SELECT policy (`auth.uid() = user_id`) lets a signed-in user check only their own membership, which is all the admin route guard needs; nobody can list or infer another user's admin status. Table-level grants mirror this: only `SELECT` is granted to `authenticated`, and `anon` has no access at all.

### Adding the first admin

There is no UI for this yet, and none is created automatically - assigning an admin requires knowing which real Supabase Auth user should have that access, which only you know. In the Supabase SQL Editor, run:

```sql
insert into public.admin_users (user_id)
values ('<the target user''s auth.users id>');
```

Find the target user's id in the Supabase Dashboard under Authentication > Users (or `select id, email from auth.users where email = '...';`).

### Client-side admin check is not a security boundary

`src/services/adminService.js` (`isCurrentUserAdmin()`) and `app/admin/_layout.js` control only whether the admin UI/routes render for the current user in this app. They are not, and must never be treated as, the security boundary for any privileged database write. Every future admin-only mutation (approving a purchase report, awarding points, editing another user's data, ...) must be independently enforced by its own RLS policy or a trusted/service-role backend - never by trusting a client-side `isAdmin` boolean alone, which is trivial to bypass by anyone inspecting or modifying the app.

## Admin read access (dashboard + review queue)

`009_admin_read_access.sql` adds read-only admin visibility across customer purchase-report data, used by the admin dashboard/review queue/report-detail screens (`src/screens/AdminHomeScreen.js`, `src/screens/AdminReportDetailScreen.js`).

### `public.is_admin()`

A `stable`, `security definer` SQL function with `set search_path = ''` (same convention as every other definer/trigger function in this schema). It takes no parameters and returns whether `auth.uid()` (the calling user) has a row in `public.admin_users` - it cannot be used to ask about anyone else. `security definer` makes its result independent of `admin_users`' own RLS/grants, which is the standard, recommended pattern for a role-check helper referenced from other tables' policies. `execute` is granted to `authenticated` only (not `anon`).

### What gained an admin policy

Additive `for select using (public.is_admin())` policies were added to `purchase_reports`, `profiles`, `receipt_ocr_results`, `receipt_ocr_lines`, `receipt_line_matches`, and `storage.objects` (receipts bucket only). Every one of these tables already had its own customer-scoped SELECT policy (`auth.uid() = user_id` or an ownership-chain `exists (...)`); Postgres combines multiple policies for the same command with OR, so a normal user's visibility is unchanged - they still only ever satisfy their own policy, never the admin one, since `is_admin()` evaluates false for them. No existing policy was edited or removed, no table's RLS was disabled, and no column-level grant was widened (the `receipt_ocr_results.error_message` and `receipt_line_matches.review_note` columns remain excluded from the client-readable grant entirely, for every role, including admin, since Postgres column grants are role-level rather than policy/row-specific and this stage does not need them for the admin UI).

### Why an admin needs its own Storage policy

Generating a Storage signed URL for a receipt still goes through Storage's own RLS on `storage.objects`. Without a dedicated admin policy there, `public.is_admin()` on `purchase_reports` alone would let an admin read the report *row*, but `createSignedUrl` for another user's `receipts/<their-id>/...` object would still be denied by the existing customer-only Storage policy. The new `"Admins can view any receipt in storage"` policy closes that gap the same way, scoped to the `receipts` bucket only.

### Client-side services

`src/services/adminReportService.js` holds every admin data read (`getAdminDashboardSummary`, `getAdminReviewQueue`, `getAdminReportDetail`, `getAdminReceiptSignedUrl`) - kept separate from `purchaseReportService.js`, whose functions are written for a customer's own data. These functions have no special client-side privilege: they succeed only because the signed-in caller's session is genuinely an `admin_users` member and the policies above admit the rows/objects. A non-admin session calling the same functions gets the same permission-denied result Postgres would give anyone else.

## Manual review workflow (approve/reject)

`010_purchase_report_review.sql` adds the manual approve/reject decision recorded by an admin, used by `AdminReportDetailScreen`. Scope is strictly the decision itself - it does not touch points, membership, or approved-purchase counts (see "Points remain out of scope" below).

### New columns on `purchase_reports`

- `reviewed_at timestamptz` - when a decision was recorded.
- `reviewed_by uuid references auth.users(id)` - which admin recorded it. **Not selectable by any client role** (see below) - excluded from the mobile/admin app entirely, not just from customers.
- `rejection_reason text` - required, non-empty (after trimming), max 1000 characters whenever `status = 'rejected'`, enforced by two CHECK constraints regardless of write path.

`purchase_reports.admin_note` (already existing since `002_create_purchase_reports.sql`) is intentionally left untouched and unused by this stage - a dedicated `rejection_reason` column was added instead of overloading that free-text field, and admin-notes management remains a separate, future concern.

### Why `reviewed_by` is excluded from every SELECT

`purchase_reports`' SELECT grant is a whole-table grant (`grant select on table public.purchase_reports to authenticated`, from `002_create_purchase_reports.sql`), which automatically covers any new column too - Postgres column grants are role-level, not row/policy-specific. Since customers and admins share the same `authenticated` role, there is no way to grant `reviewed_by` to "admins only" at the column-privilege level without also exposing it to a customer reading their own row. This migration explicitly carves it back out with `revoke select (reviewed_by) on public.purchase_reports from authenticated`, so it is unreadable by anyone through the Supabase client - a deliberate, simple choice over building a role-aware read path this stage doesn't need. `reviewed_at` and `rejection_reason` remain readable (via the existing whole-table grant): neither identifies which admin acted.

### `public.review_purchase_report(p_report_id, p_decision, p_rejection_reason)`

The **only** way `status`/`reviewed_at`/`reviewed_by`/`rejection_reason` can be written - there is still no INSERT/UPDATE grant on `purchase_reports` for `authenticated` at all (only SELECT and a column-restricted INSERT exist), so a direct `.update(...)` call is rejected before this function is even reachable, for any caller including an admin. `security definer` with `set search_path = ''` (same convention as `public.is_admin()`), it:

1. Requires `public.is_admin()` to be true - the FIRST thing it checks, unconditionally. A non-admin caller always fails here before touching any row.
2. Requires `p_decision` to be exactly `'approved'` or `'rejected'`.
3. Loads the target report with `select ... for update` - this row lock is what makes it concurrency-safe: if two admin sessions call this for the same report nearly simultaneously, the second blocks until the first commits, then re-reads the now-updated status and correctly fails with `report_not_reviewable` instead of silently overwriting the first decision.
4. Requires the report's current status to still be `'submitted'` or `'needs_review'` - a report already `'approved'`/`'rejected'`, or still `'processing'`, cannot be finalized again through this function.
5. For a rejection, requires a real trimmed non-empty reason (max 1000 chars); an approval always clears `rejection_reason` to null regardless of any client-supplied value.
6. Sets `reviewed_at = now()` and `reviewed_by = auth.uid()` unconditionally - never accepted as input.

It does not require OCR to exist or have completed - a report with no `receipt_ocr_results` row is exactly as reviewable as one with a completed result. It touches nothing on `public.profiles`, `receipt_ocr_results`, `receipt_ocr_lines`, or `receipt_line_matches`.

`execute` is granted to `authenticated` broadly (there is no separate Postgres role for admins in this schema) - authorization happens inside the function itself (step 1), not via the grant.

### Points remain out of scope

No trigger or function anywhere in this schema modifies `profiles.points_balance`, `profiles.membership_level`, or `profiles.approved_purchases_count` in response to a `purchase_reports` status change (verified by inspecting every migration before writing this one - the only place those columns are set is the row-creation trigger/backfill in `001_create_profiles.sql`, both to their defaults). Approving a report through `review_purchase_report()` records the decision only; points/membership logic is a separate, later stage.

### Customer-facing changes

`purchaseReportService.getPurchaseReportById()` now also selects `rejection_reason` (not `reviewed_by`), and `PurchaseReportDetailsScreen` displays it under the existing "החשבונית לא אושרה" notice when a report is rejected. This relies entirely on the customer's existing own-row RLS policy and the already-existing column grant - no RLS or grant change was needed for this. The existing customer status labels (`אושרה`/`נדחתה`/`נדרשת בדיקה`/`נשלחה לבדיקה`) were already correct and were not changed.

## Manual receipt data entry (OCR failure/missing fallback)

`011_receipt_manual_items.sql` adds `public.receipt_manual_items`, used by `AdminReportDetailScreen` when OCR failed, is missing, or produced no usable lines - an admin can enter the receipt's line items by hand instead of being blocked from reviewing it. This is a data-entry foundation only: no points, product matching, or catalog import happens here.

### Why a separate table, not `receipt_ocr_lines`

`receipt_ocr_lines` represents actual OCR output. Manually-entered data is never written there - mixing the two would make it impossible to later tell which lines came from the OCR provider versus an admin's own reading of the receipt image. `receipt_manual_items` is its own table for exactly that reason, and both can coexist for the same report without either overwriting the other.

### Schema

`purchase_report_id`, `line_index` (server-assigned, never trusted from the client), `description` (required, non-blank, max 500 chars), `sku` (optional, max 100 chars), `quantity` (optional, must be `> 0`), `unit_price`/`line_total` (optional, must be `>= 0`), `created_by` (always the acting admin, never client input), `created_at`/`updated_at`. A `(purchase_report_id, line_index)` uniqueness constraint prevents duplicate indices regardless of write path.

### `public.save_manual_receipt_items(p_report_id, p_items)`

Replaces the **entire** manual-item set for one report in a single atomic operation (one Postgres transaction) - repeated saves/edits never create duplicates. `security definer`, `set search_path = ''`. Requires `public.is_admin()`, requires the target report to exist, validates every item in the JSONB array before deleting anything, then deletes and re-inserts the full set with `line_index` assigned from array order and `created_by = auth.uid()` (both never accepted from the client). `execute` is granted broadly to `authenticated` - authorization happens inside the function, matching `public.review_purchase_report()`'s pattern.

### Admin-only until 012_customer_manual_items_read.sql

Originally `receipt_manual_items` had no customer-facing SELECT policy at all - see the next section for how read access was later extended to the report's owner.

## Customer read access to manual receipt items

`012_customer_manual_items_read.sql` lets a customer read the manual items an admin entered for their **own** purchase report, displayed in `PurchaseReportDetailsScreen` under a "פריטים בחשבונית" section. This is read-only: no INSERT/UPDATE/DELETE access is added for `authenticated` anywhere in this migration.

### The exact rule

```sql
create policy "Customers can view manual items for their own reports"
  on public.receipt_manual_items
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.purchase_reports pr
      where pr.id = receipt_manual_items.purchase_report_id
        and pr.user_id = auth.uid()
    )
  );
```

This is additive alongside the existing admin policy (`"Admins can view manual receipt items"`, `using (public.is_admin())`, from `011_receipt_manual_items.sql`) - Postgres combines multiple SELECT policies for the same table with OR, so a customer still can never satisfy the admin policy, and an admin's existing full read access is completely unaffected. A customer can never list another customer's manual items: the `exists` check only ever matches rows whose `purchase_report_id` resolves to a `purchase_reports` row owned by `auth.uid()`.

### `created_by` stays hidden from customers too

`receipt_manual_items`' SELECT grant (`011_receipt_manual_items.sql`) is a whole-table grant, which would otherwise let a customer reading their own now-visible row also select `created_by` (which admin entered the data). This migration carves that column back out with `revoke select (created_by) on public.receipt_manual_items from authenticated` - the same pattern already used for `purchase_reports.reviewed_by` in `010_purchase_report_review.sql`. The admin's own read query never selected this column either, so nothing about the existing admin manual-entry workflow changes.

### Client read

`purchaseReportService.getReceiptManualItems(purchaseReportId)` selects only `id, description, sku, quantity, unit_price, line_total`, ordered by `line_index` - never `created_by`, never any other internal/admin field. It has no special privilege of its own: it returns exactly whatever rows the caller's own RLS policy admits, nothing more.

## Points awarding foundation

`013_points_awarding.sql` adds `public.points_transactions`, used by `AdminReportDetailScreen` to award points for an already-approved purchase report. This is a foundation only: no OCR integration, no product matching, and no membership/reward-redemption logic exists in this migration.

**Superseded by `014_automatic_points_eligibility.sql`** (see below): the original `public.award_purchase_points(p_report_id, p_eligible_pre_vat_amount)` signature described in this section - where an admin typed the eligible amount - no longer exists. It has been dropped and replaced by `public.award_purchase_points(p_report_id)`, which calculates the eligible amount itself from `receipt_manual_items` rows. The `points_transactions` schema, the partial unique index, and the overall business rule below are unchanged by migration 014 - only how the eligible amount is produced changed.

### Final business rule

Only the admin-confirmed Golden Light product lines count toward points, before VAT - never an OCR total, a manual-items grand total, or the invoice total, since none of those distinguish Golden Light products from anything else on the receipt, and none of them exclude VAT. Reward value is 2% of the eligible pre-VAT total, and every ₪1 of reward value is 10 points, i.e. `points = floor(eligible_pre_vat_total * 0.02 * 10)` = `floor(eligible_pre_vat_total * 0.2)`. This is computed exclusively inside `award_purchase_points()` using Postgres `numeric` arithmetic (never floating point, never computed in JavaScript), always rounds down, and is never trusted from - or exposed as a formula to - the client. The customer only ever sees the resulting integer points value, via the pre-existing `purchase_reports.points_awarded` column and `profiles.points_balance`.

### Why the eligible amount lives only in `points_transactions`, not on `purchase_reports`

Storing it a second time on `purchase_reports` would create two sources of truth for the same fact with no way to guarantee they stay in sync. The `points_transactions` row already satisfies both the audit requirement (the exact amount an admin confirmed, permanently recorded) and the "database calculates points" requirement (the same row also stores the resulting `points`, so the calculation is always reproducible from data that was actually written, not re-derived later from a mutable column).

### `points_transactions` schema

Append-only ledger: `user_id`, `purchase_report_id`, `transaction_type` (free text, not hard-enum-constrained, so a future reversal/adjustment type can be added without an `ALTER TABLE`; this migration only ever inserts `'purchase_reward'`), `points`, `eligible_pre_vat_amount`, `created_by` (the acting admin), `created_at`. CHECK constraints scoped specifically to `transaction_type = 'purchase_reward'` require `points > 0`, a non-null `purchase_report_id`, and a non-null `eligible_pre_vat_amount`; a separate constraint requires `eligible_pre_vat_amount` to be non-negative whenever present.

### One award per report, enforced at the database level

A partial unique index, `on points_transactions (purchase_report_id) where transaction_type = 'purchase_reward'`, guarantees a report can never receive more than one purchase-reward ledger row - independent of, and in addition to, the RPC's own `exists()` check. This is the same "partial unique index for an at-most-one-per-case rule" technique already used for `receipt_manual_items (purchase_report_id, line_index)`.

### `points_transactions` access model

Row Level Security is enabled on `points_transactions`. Only a `for select using (public.is_admin())` policy exists - no customer-facing SELECT policy is added yet, since no transaction-history UI exists yet and the customer already sees the resulting `points_awarded`/`points_balance` values through existing, unmodified tables. There is no INSERT/UPDATE/DELETE grant or policy for `authenticated` at all; the only writer is `award_purchase_points()` via `security definer`.

### Not yet confirmed applied to the live database

Unlike migrations 008-012 (confirmed applied via live anon-key REST probing during earlier stages), `013_points_awarding.sql` and `014_automatic_points_eligibility.sql` have only been verified via mocked Playwright network responses against the real `AdminReportDetailScreen`/`adminReportService.js` code, not against the actual Supabase project. Both must be run, in order, in the Supabase SQL Editor before real end-to-end testing (or real point awards) is possible.

## Automatic points eligibility from receipt line items

`014_automatic_points_eligibility.sql` removes the admin-typed eligible amount entirely. Points are now calculated only from `receipt_manual_items` rows the admin has already entered, specifically the ones marked as a real Golden Light product. The admin never types a total anywhere in this flow - not the eligible amount, not the points.

### Why a manual `is_golden_light` flag, not real product matching

Real Golden Light catalog matching does not exist yet (see "Product matching foundation" above - it currently resolves every line to `unmatched` because no catalog data has been imported). Until it does, an admin must explicitly confirm which manually-entered lines are real Golden Light products, the same "nothing is trusted/derived automatically" posture already used for every other manual-entry field. This is explicitly a temporary substitute: a future migration can derive eligibility from real `receipt_line_matches` rows instead once product matching exists, without changing `award_purchase_points()`'s external contract (still just `p_report_id`) - only its internal eligible-total query would need to change.

### Schema change to `receipt_manual_items`

Adds `is_golden_light boolean not null default false`. A freshly-entered row is never eligible until an admin explicitly checks it.

Unlike every other manual-item column, `is_golden_light` is hidden from *every* client role's plain `SELECT` (`revoke select (is_golden_light) on public.receipt_manual_items from authenticated`) - the same defense-in-depth carve-out already used for `created_by`/`reviewed_by`, necessary because column grants are role-level and customers/admins share the `authenticated` role. Unlike `created_by`/`reviewed_by` though, the admin genuinely needs to read this value (to render/preload the "מוצר Golden Light" checkbox), so a new function fills that gap:

### `public.get_admin_manual_items(p_report_id)`

The admin's only read path for `receipt_manual_items` as of this migration, replacing the previous plain `.from('receipt_manual_items').select(...)` call in `adminReportService.js`. `security definer`, `set search_path = ''`, requires `public.is_admin()` - a non-admin caller gets `not_admin` and no rows at all. Returns every column, including `is_golden_light`. The customer-facing read path (`purchaseReportService.getReceiptManualItems`) is untouched - it never selected `is_golden_light` and still doesn't.

### `public.save_manual_receipt_items(p_report_id, p_items)` - extended

Unchanged in every other respect from migration 011 (still `is_admin()`-gated, still validates every item before deleting anything, still replaces the full set atomically). Each item in `p_items` may now also carry `"is_golden_light": true/false`, validated as a real boolean and defaulting to `false` when omitted - `invalid_is_golden_light` is raised for anything else.

### How the line amount is calculated

For each `is_golden_light = true` row: prefer `line_total` if present; otherwise `quantity * unit_price` if BOTH are present; otherwise the row contributes nothing. Both existing CHECK constraints (`quantity > 0`, `unit_price >= 0`, `line_total >= 0`, and rejecting `NaN`) already guarantee no negative or `NaN` value can reach this calculation. VAT and the invoice grand total are never read anywhere in this function.

### How the eligible total and points are calculated

```sql
select coalesce(sum(
  coalesce(
    item.line_total,
    case
      when item.quantity is not null and item.unit_price is not null
        then item.quantity * item.unit_price
      else null
    end
  )
), 0)
into v_eligible_total
from public.receipt_manual_items item
where item.purchase_report_id = p_report_id
  and item.is_golden_light = true;
```

Postgres `sum()` already ignores `null`s, so a `is_golden_light = true` row that can produce neither a `line_total` nor a `quantity * unit_price` amount contributes exactly `0` to the total, matching the "row contributes 0" rule, without any special-case branch. `points := floor(v_eligible_total * 0.2)`, identical NUMERIC-arithmetic floor behavior as migration 013.

### `public.award_purchase_points(p_report_id)` - signature change

Migration 013's `award_purchase_points(uuid, numeric)` is dropped (`drop function if exists ... ;`) rather than left behind as a second, competing way to award points - there is exactly one award RPC in the schema at any time. The new `award_purchase_points(uuid)` accepts only the report id; there is no `p_eligible_pre_vat_amount`, `p_points`, or `p_points_awarded` parameter anywhere in its signature. Every number it uses is loaded from database rows:

1. Requires `public.is_admin()`.
2. Locks the target `purchase_reports` row with `for update` (same concurrency-safety technique as migration 013).
3. Requires `status = 'approved'`.
4. Refuses (`points_already_awarded`) if a `purchase_reward` row already exists for the report - still also independently enforced by the migration-013 partial unique index, untouched here.
5. Computes the eligible total and points exactly as described above.
6. Requires the eligible total to be `> 0` - `no_eligible_amount` otherwise, so the UI can show "לא קיים סכום מזכה עבור החשבונית" instead of attempting a meaningless award.
7. Requires the resulting points to be `> 0` - `no_points_to_award` otherwise.
8. Inserts exactly one `points_transactions` row (storing the DB-computed eligible total for audit, never a client-supplied value), updates `purchase_reports.points_awarded`, and increments `profiles.points_balance` - all three writes happen inside this one function call/transaction, same as migration 013.

### Admin UI

**Superseded by `015_finalize_purchase_report.sql`** (see below): the separate "צבירת נקודות" section and its standalone "הענקת נקודות" button described in this section are no longer part of the normal admin review flow. For a reviewable report (`submitted`/`needs_review`), approving and awarding points now happen together via a single "אישור וסיום טיפול" action. Each manual-item row still has the "מוצר Golden Light" checkbox and the live eligible-total/points preview described here - those did not change, only when/how the admin acts on them did. `award_purchase_points()` itself, and the RPC's own behavior, are unchanged by migration 015; only the admin UI's calling pattern changed. The standalone award button still exists as a fallback for a report that reached `approved` before this workflow existed - see "Unified one-click review workflow" below.

## Unified one-click review workflow

`015_finalize_purchase_report.sql` replaces the fragmented three-step admin flow (save manual items, then approve, then separately award points) with a single atomic action for the normal case: a report still `submitted` or `needs_review`.

### Why one new function, not three separate calls from the client

The client previously made three separate RPC calls in sequence (`save_manual_receipt_items`, `review_purchase_report`, `award_purchase_points`), which meant a real, reachable state existed where items were saved but the report wasn't approved, or the report was approved but points were never awarded (simply because the admin navigated away, or a network call failed, between steps). A single new function, `public.finalize_purchase_report(p_report_id, p_items)`, removes that gap entirely by performing all of the writes inside one Postgres transaction - the whole call either fully succeeds or fully rolls back, with no reachable partial state.

### Reusing existing infrastructure

Per an explicit "do not blindly duplicate architecture" instruction, `finalize_purchase_report()` does not reimplement item validation, replacement, or points calculation - it calls the existing, already-hardened functions directly:

```sql
perform public.save_manual_receipt_items(p_report_id, p_items);

update public.purchase_reports
set status = 'approved', reviewed_at = now(), reviewed_by = auth.uid(), rejection_reason = null
where id = p_report_id;

v_points := public.award_purchase_points(p_report_id);
```

`save_manual_receipt_items()` (011, extended 014) validates and atomically replaces the manual item set, including `is_golden_light`. `award_purchase_points()` (013, replaced 014), called only after the status update above, re-verifies `is_admin()` and `status = 'approved'` (both already true), sums the just-saved `is_golden_light` rows, computes `floor(eligible_total * 0.2)`, and raises `no_eligible_amount`/`no_points_to_award` rather than ever awarding zero points. Because this all happens inside one function call, an exception raised by either called function aborts and rolls back everything before it too - there is no way for items to end up saved without the report being approved, or approved without points being awarded.

### `public.finalize_purchase_report(p_report_id, p_items)`

`security definer`, `set search_path = ''`, same convention as every other definer function in this schema. The client sends **only** the report id and the final item list - never points, an eligible total, `reviewed_by`, or `reviewed_at`.

1. Requires `public.is_admin()`.
2. Locks the target `purchase_reports` row with `for update` immediately - the concurrency boundary for the whole operation: a second near-simultaneous finalize call for the same report blocks here until the first commits, then re-reads the now-`'approved'` status and correctly fails with `report_not_reviewable` rather than finalizing twice.
3. Requires the report to exist and its status to be exactly `'submitted'` or `'needs_review'` - `report_not_reviewable` otherwise.
4. Delegates to `save_manual_receipt_items()`, then sets `status = 'approved'`/`reviewed_at`/`reviewed_by`/`rejection_reason = null`, then delegates to `award_purchase_points()`, as shown above.

`execute` is granted broadly to `authenticated` (no separate Postgres role for admins); authorization happens inside the function itself (step 1). A normal customer session can call this RPC, but always fails at step 1 - it never reaches any row.

### Which existing RPCs remain, and why

- `public.review_purchase_report()` (010) - **unchanged, still the only way to reject a report.** Its `'approved'` decision path also still exists at the database level (not dropped - nothing about it is unsafe), but the admin UI no longer calls it for approval; only its `'rejected'` path is exercised by the current app.
- `public.save_manual_receipt_items()` (011/014) - unchanged, still directly used by `finalize_purchase_report()` internally AND by the admin UI's separate "עריכת טיפול" post-approval correction flow (see below).
- `public.award_purchase_points()` (014) - unchanged, still directly used by `finalize_purchase_report()` internally AND kept reachable on its own as a fallback for a report that reached `'approved'` before this workflow existed and was never separately awarded.

Nothing is dropped by this migration.

### Rejection stays separate and simple

"דחיית חשבונית" continues to call `review_purchase_report(p_report_id, 'rejected', p_rejection_reason)` directly - it never touches `receipt_manual_items` or points, and the admin UI does not require the manual-item rows to be valid before allowing a rejection (a report can be rejected even with an empty/incomplete draft, since rejecting never reads or saves them).

### Admin UI: one review form, one final action

For a reviewable report, `AdminReportDetailScreen`'s "פרטי החשבונית" section is now always directly editable (no separate "start editing"/"save" step) - the manual-item rows, "מוצר Golden Light" checkboxes, and the live eligible-total/points preview are the same UI described in the previous section, just always active rather than gated behind an edit toggle. Below them, "פעולות בדיקה" shows exactly two actions: "אישור וסיום טיפול" (primary, calls `finalizePurchaseReport()` -> `finalize_purchase_report`) and "דחיית חשבונית" (secondary, unchanged). There is no separate save button, approve button, or award-points button in this normal flow.

"אישור וסיום טיפול" is disabled, with an inline explanation, unless the current draft would pass every rule the database itself enforces: at least one valid line, no invalid numeric values, no `is_golden_light` row missing enough price information to produce an amount, and a resulting eligible total/points both `> 0`. This client-side gate (`getFinalizeBlockingReason()`) is a UX convenience only - `finalize_purchase_report()` re-validates everything itself regardless.

A confirmation modal ("אישור וסיום טיפול" / "סכום מזכה לפני מע״מ: ₪X" / "נקודות שיתווספו: Y" / "ביטול" / "אישור וסיום") precedes the actual call, using the same client-computed preview values (which, for a draft that already passed the gate above, match what the database will independently compute).

After a successful finalize: the report reloads as `approved`, the editable form is replaced by a read-only display of the saved rows (with a "עריכת טיפול" link), a "פרטי הענקת הנקודות" box shows the awarded points and eligible amount for audit, and "פעולות בדיקה" shows the finalized decision box instead of any action buttons. The report also naturally leaves the active review queue (`getAdminReviewQueue()`/dashboard count are unchanged by this migration and were never touched by it) while remaining visible in "כל החשבוניות".

### Post-approval correction ("עריכת טיפול") - deliberately does not touch points

An approved report shows a "עריכת טיפול" link/button that reopens the exact same editable row UI, but saving from this mode calls `saveAdminManualItems()` -> `save_manual_receipt_items()` directly - never `finalize_purchase_report()` and never `award_purchase_points()`. This is a deliberate, structural safety property, not just a UI convention: `save_manual_receipt_items()` only ever writes to `receipt_manual_items` and has no code path that touches `points_transactions`, `purchase_reports.points_awarded`, or `profiles.points_balance`. A visible notice ("עריכה זו מעדכנת את פרטי החשבונית בלבד ואינה משפיעה על הנקודות שכבר הוענקו") makes this explicit to the admin. Already-awarded points are never recalculated or overwritten by editing here.

This intentionally leaves a real limitation: if an admin corrects the Golden Light lines after points were already awarded based on the old data, the awarded points do **not** change to match. Correcting an already-awarded points total would require a proper adjustment/reversal ledger entry (a new `points_transactions` row of a different `transaction_type`, e.g. a future `'purchase_reward_adjustment'`), which does not exist yet and is explicitly out of scope for this migration - the original `purchase_reward` row is never updated or deleted in place, preserving `points_transactions` as an honest, append-only audit trail. This is a deliberate scope boundary, not an oversight.

### Duplicate/concurrent finalization

Prevented at two independent layers, both already established: the `for update` row lock inside `finalize_purchase_report()` (a second concurrent call blocks until the first commits, then observes `status = 'approved'` and fails with `report_not_reviewable`), and the migration-013 partial unique index on `points_transactions` (an extra, independent guarantee against a duplicate `purchase_reward` row even if the status check were ever bypassed).

## Simplified admin manual-entry fields

`016_simplify_eligible_amount_calc.sql` removes `sku` and `line_total` from the admin manual-review form entirely. Each row now shows only description, quantity, unit price, and the "מוצר Golden Light" checkbox - the admin never types a SKU or a line total anymore.

### Schema is untouched

`receipt_manual_items.sku` and `receipt_manual_items.line_total` are **not** dropped, and no existing row's data is modified by this migration. Both columns remain available for a future OCR/matching stage that might genuinely detect a SKU or a printed line total - this migration only changes what the current *admin manual-entry form* collects and what `award_purchase_points()` reads when computing eligibility, not the schema.

### Calculation change: `quantity * unit_price` only, no `line_total` fallback

Previously (migration 014), a row's eligible amount preferred `line_total` when present, falling back to `quantity * unit_price`. Since the admin form no longer collects `line_total` at all, every row it saves has `line_total = null`, and the old fallback formula would already have resolved to `quantity * unit_price` in practice - but `award_purchase_points()` was updated anyway to read `case when quantity is not null and unit_price is not null then quantity * unit_price else null end` directly, so the database-authoritative calculation is explicit and correct rather than depending on an incidental "line_total happens to always be null" side effect. A row missing quantity or unit price - regardless of any `line_total` it might still carry from before this change - contributes `0`.

### Validation

For a `submitted`/`needs_review` report, "אישור וסיום טיפול" stays disabled (with an inline explanation) unless every row marked `is_golden_light` has both a valid quantity (`> 0`) and a valid unit price (`>= 0`) - enforced client-side by `getFinalizeBlockingReason()` for immediate feedback, and independently by `award_purchase_points()`'s own `no_eligible_amount`/`no_points_to_award` checks, which still refuse to award zero points.

### Admin UI

`AdminReportDetailScreen`'s `MANUAL_COLUMNS` dropped the `sku`/`line_total` entries; the remaining description/quantity/unit-price columns were widened to fill the reclaimed space, in both the wide desktop table and the narrow stacked mobile layout, for the editable form and the read-only saved-items view alike. `buildManualItemsPayload()` now always sends `sku: null, line_total: null` for every row - the RPC payload shape is unchanged, only what the client populates changed.

### Customer visibility

No change needed: `PurchaseReportDetailsScreen`'s `ManualItemRow` already renders `quantity`/`unit_price`/`line_total`/`sku` independently, each only when non-null. Since the admin form now always saves `sku`/`line_total` as `null`, the customer simply stops seeing those two fields for any newly-finalized row, with no code change to the customer screen.

## G Level (automatic membership progression)

`017_g_level_progression.sql` makes `public.profiles.approved_purchases_count`/`.membership_level` (both existing since `001_create_profiles.sql`, but never updated by anything until now) automatically correct, and renames the fourth/top tier from the unreachable `PLATINUM` placeholder to the official `TITANIUM`.

### Source of truth: a recount, never an increment

`public.recalculate_membership_level(p_user_id)` is the only thing that ever writes these two columns. It does not increment a counter - every call recomputes `approved_purchases_count` from scratch via `select count(*) from purchase_reports where user_id = p_user_id and status = 'approved'`, then derives `membership_level` from that fresh count. This makes it idempotent and self-healing: calling it any number of times for the same user always converges on the same correct values, so there is no stored "already counted" flag that could drift, double-count the same report, or go stale after a report is edited post-approval.

### Thresholds

```
Bronze:   0-11 approved reports
Silver:   12-23
Gold:     24-35
Titanium: 36+   (current maximum - no level above this)
```

Only `status = 'approved'` counts - `submitted`/`processing`/`needs_review`/`rejected` never contribute, matching `REVIEW_QUEUE_STATUSES`/the review workflow exactly.

### Where it's called

`recalculate_membership_level()` is an internal-only helper - `revoke execute ... from anon/authenticated/public`, no direct grant at all. It is only reachable as a nested call from inside another `security definer` function already gated by `public.is_admin()`:

- `public.finalize_purchase_report()` (015/016) - the normal one-click review action. The call happens immediately after the `update ... set status = 'approved'`, inside the same transaction as the manual-items save and the points award, so a failure anywhere in that call (invalid item, no eligible amount, ...) rolls back the level recalculation along with everything else - there is no path where a report ends up approved but the level wasn't recalculated, or vice versa.
- `public.review_purchase_report()` (010) - its `'approved'` decision path isn't used by the current admin UI (`finalize_purchase_report()` is), but still exists at the database level, so it gets the same call for consistency. Its `'rejected'` path is completely unchanged.

Neither the admin nor the customer ever selects a level directly - both `finalize_purchase_report()` and `review_purchase_report()` already require nothing but a report id (and, for finalize, the item list); the client never sends `approved_purchases_count` or `membership_level`.

### Backfill

The migration ends with `select public.recalculate_membership_level(id) from public.profiles;`, synchronizing every existing profile's level against real historical approved reports immediately - no manual per-user fix-up needed after running this migration.

### Security

No grant changes were needed or made. `public.profiles`' update grant (`001_create_profiles.sql`) has always been `grant update (full_name, phone, profession) on table public.profiles to authenticated` - already excluding `approved_purchases_count`/`membership_level`/`points_balance` entirely. A direct `.from('profiles').update({ membership_level: ... })` call from any client is rejected by Postgres before it could reach a row, regardless of who's calling. A new `check (membership_level in ('BRONZE', 'SILVER', 'GOLD', 'TITANIUM'))` constraint (added after the backfill, so it can never fail against stale data) is the first validation ever placed on this column's actual value set.

## Product catalog foundation (Stage 1)

`018_product_catalog_foundation.sql` extends the existing (previously empty) `public.products`/`public.product_aliases` tables from `004_create_product_catalog.sql` with the columns needed to import the real Golden Light catalog. `supabase/scripts/import-product-catalog.mjs` is the separate, repeatable tool that actually loads product rows - schema and data are deliberately kept apart (see "Migration vs. import" below).

### Why the existing columns keep their names

`sku` already is the official item-code business identifier (`not null unique`) and `name` already is the required product description - both are read directly by the deterministic matching pipeline (`productMatcher.ts`'s `CatalogProduct` type, `productMatchPersistence.ts`'s select list). Renaming either to literally match this stage's `item_code`/`description` wording would ripple a purely cosmetic change through matching code with zero functional benefit, so neither is renamed. Two genuinely new columns were added instead:

- `barcode text` - nullable (real source rows have none - GSWITCH 40071/40072/40073), indexed but **not** uniquely constrained (a real duplicate barcode, `753287487971`, is shared by two distinct GSWITCH products - `412525` and `412575` - and must not block import).
- `product_family text not null` - free text, not an enum. Today's real values are `GBOX`/`GSWITCH`/`GTECH`, but nothing in the schema limits it to only those three - a future family is just another value, no migration needed.

No `normalized_item_code`/`normalized_description` columns were added: the matcher already normalizes `sku`/`name` in memory at match time via `normalizeCatalogText()` (mirroring `public.normalize_catalog_text()` exactly) and never reads a stored normalized column - adding one now would be unused, unmaintained dead weight.

`product_aliases` gained two new nullable columns, `alias_sku` and `source_name`, for future alias types (e.g. a wholesaler-specific SKU, or which source contributed an alias) - purely additive, nothing reads them yet, and no alias rows are inserted by this stage. `alias`/`normalized_alias` are unchanged (`alias` stays `not null` - see the migration's own comment for why making it nullable safely requires also revisiting the `normalized_alias` unique constraint, deferred to a real matching-behavior stage).

### Access model - unchanged

No grant or policy was added, dropped, or modified. `authenticated` still has SELECT only (active products / aliases of an active product, from `004_create_product_catalog.sql`); there is still no INSERT/UPDATE/DELETE grant for `authenticated` on either table. Catalog writes are reachable only through a trusted service-role connection - see the import script below - never through the app's own Supabase client, and the service-role key is never bundled into the app.

### `receipt_line_matches` compatibility

`receipt_line_matches.product_id references public.products(id)` is untouched - this migration only adds columns to `products`, `id` and every other pre-existing column are unmodified, so the existing foreign key and every existing row/policy referencing it keep working exactly as before.

### Import tool: `supabase/scripts/import-product-catalog.mjs`

A standalone Node script (its own `package.json`, its own `node_modules`, gitignored) - never part of the Expo app's dependency tree or bundle. Usage:

```sh
cd supabase/scripts
npm install
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node import-product-catalog.mjs GBOX=path/to/GBOX.xlsx GSWITCH=path/to/GSWITCH.xlsx GTECH=path/to/GTECH.xlsx
```

Each `FAMILY=path` argument is explicit - the family is never guessed from a filename, so a differently-named file for an existing (or brand new) family works without any code change. Columns are read by **position** (item_code, description, barcode), not by header text - GTECH's real third column is barcode-shaped (13-digit numbers matching GBOX/GSWITCH's real barcodes) even though its header literally says "מחיר יציאה" ("exit price"); this script deliberately imports it as `barcode`, documented here rather than assumed silently. No pricing data or architecture is read, stored, or introduced anywhere by this script or this stage - points continue to come only from the real receipt amount an admin confirms, per the existing points-awarding flow.

Every row is upserted on `sku` (`onConflict: 'sku'`): an existing item_code has its description/barcode/product_family/is_active refreshed to the new file's values; a new item_code is inserted. `is_active` is always set `true` by this script - marking a discontinued product inactive is a deliberate admin decision the importer never makes on its own (no admin catalog-management UI exists yet - explicitly a later stage).

**Nothing is ever silently dropped.** A row missing `item_code` or `description` is excluded from the import but always printed in the report; a duplicate `item_code` within the same import batch keeps only its last occurrence (a real `sku unique` constraint requires exactly one row) but every occurrence is still reported as a conflict; a duplicate `barcode` never blocks anything (barcode isn't uniquely constrained) but is still reported. Missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY (or an explicit `--dry-run` flag) runs the exact same parsing/validation/report with no database connection at all - the safe way to preview a new or updated source file before actually importing it.

### Real source-data findings (verified by actually running the script)

211 total rows (GBOX 28 + GSWITCH 138 + GTECH 45), 0 malformed rows, 0 cross-family or within-family duplicate item_codes. 3 missing barcodes (GSWITCH `40071`/`40072`/`40073`). 1 duplicate barcode (`753287487971`, GSWITCH `412525` and `412575` - kept as-is on both rows, reported, not guessed at or resolved).

### Migration vs. import

Schema (columns, indexes, constraints, grants) lives in a migration, exactly like every other change in this file. The 211 actual product rows do **not** live in a migration - they are imported via the repeatable script above, run manually with real credentials whenever the source files are added or updated. This keeps a future catalog update (a new Excel file, corrected data, a brand new family) a matter of re-running the script, never a new migration.

## Product matching foundation (Stage 2: manual receipt items)

`019_product_matching_manual_items.sql` links `receipt_manual_items` rows to real `public.products` rows, so the admin review flow can rely on an authoritative product match instead of only the manual `is_golden_light` flag added in `014_automatic_points_eligibility.sql`.

### One matcher, two runtimes, not two matchers

The actual matching cascade already existed for OCR lines in `supabase/functions/process-receipt/productMatcher.ts` (barcode/SKU exact -> normalized SKU -> alias exact -> name exact), but that file is a Deno Edge Function module (`https://esm.sh/...` imports) that cannot be imported into the Expo/Metro bundle. `src/services/productMatching.js` is a plain-JS port of the **exact same priority order and normalization rules**, extended with the two strategies `productMatcher.ts` explicitly reserved but never implemented: barcode-exact (its `CatalogProduct` type predates the `barcode` column added in Stage 1) and a real description-similarity/fuzzy strategy (its documented-but-unimplemented `SimilarityMatchStrategy`). Both files must stay in normalization-sync with `public.normalize_catalog_text()`, exactly like before. If a genuine shared-package extraction is ever justified it should replace both copies at once - not attempted here, to avoid touching the still-undeployed OCR pipeline.

### Why matching runs client-side, not via a new RPC

`public.products`/`public.product_aliases` already grant plain SELECT to `authenticated` for active rows (`004_create_product_catalog.sql`). `loadCatalogForMatching()` (`adminReportService.js`) reads the ~211-row active catalog **once per review session** using the admin's own session - no service-role key, no new grant, no new RPC. Every row's auto-suggestion and manual search then run in memory (`matchManualItem`/`getProductSuggestions` in `productMatching.js` - see "Product matching UX" below) - zero N+1 queries regardless of how many lines a receipt has. The only genuinely privileged operation is **writing** a match or a learned alias, and that still goes through the one existing, already `is_admin()`-gated write path: `public.save_manual_receipt_items()`.

### Matching strategies and confidence (starting heuristics, not fixed business rules)

1. `barcode_exact` (1.00) - the admin's optional "קוד/ברקוד" input for a row equals a product's barcode.
2. `sku_exact` (0.99) - same input equals a product's `sku`.
3. `sku_normalized` (0.97) - `normalizeCatalogText()`-equal (catches `411-001`/`411 001`/`411/001` variants; deliberately does **not** match a superstring like `GL411001` - that's what aliases are for).
4. `alias_exact` (0.98) - the line's description normalizes (via `normalizeCatalogText()`, the same normalization the database trigger uses for `product_aliases.normalized_alias`) to a known alias.
5. `description_exact` (0.95) - a gentler `normalizeDescriptionText()` (collapses whitespace/punctuation but preserves Hebrew/English words and numeric tokens - unlike `normalizeCatalogText`, it does not strip all whitespace) applied to both sides.
6. `description_fuzzy` - a character-bigram Sorensen-Dice similarity score (deterministic, explainable, no AI/ML dependency), always returned as `needs_review` candidates and **never auto-applied**, capped below every exact tier's confidence (`FUZZY_MAX_CONFIDENCE`).

At every exact tier, more than one distinct product qualifying resolves to `needs_review` with every tied candidate listed - the matcher never guesses. All thresholds/confidence values live as named constants at the top of `productMatching.js` for easy future tuning.

### Three match states, not two

`receipt_manual_items` gained `product_id`, `match_type`, `match_confidence`, and `match_status` (`'unresolved' | 'matched' | 'not_golden_light'`, default `'unresolved'`), with the same "`matched` requires `product_id` / non-`matched` forbids `product_id`" CHECK-constraint pair already proven on `receipt_line_matches`. `'unresolved'` (nothing decided yet) is never conflated with `'not_golden_light'` (an explicit admin decision) - the admin's product-match modal (`AdminReportDetailScreen.js`) has a dedicated "לא מוצר Golden Light" action, separate from simply leaving a row untouched.

### `is_golden_light` is now a pure mirror, not a second source of truth

`save_manual_receipt_items()` no longer reads `is_golden_light` from the client payload at all - it is always computed server-side as `(match_status = 'matched')`. `public.award_purchase_points()` was updated to filter on `match_status = 'matched'` instead of `is_golden_light = true` - since the two can never disagree, this changes no observable behavior for normal saves, it only removes the redundant second source of truth. The `floor(eligible_total * 0.2)` formula itself is unchanged.

### Alias learning: explicit confirmation only

When a row is saved with `match_type = 'manual'` (the admin picked among several candidates or via free-text search - never an automatically-resolved unambiguous exact-tier match, and never a fuzzy suggestion picked without deliberate action) and the description isn't already the product's own canonical name/SKU, `save_manual_receipt_items()` inserts a new `product_aliases` row (`on conflict (normalized_alias) do nothing`, relying on the existing global unique constraint to stay idempotent across re-saves and to never steal an alias another product already owns). A confirmed high-confidence auto-suggestion (e.g. `sku_exact`) keeps its own real `match_type` and does **not** create an alias - it would be redundant, since the SKU already finds the product on its own.

### Admin UI: one status cell, one shared modal

The wide-table/narrow-stacked "מוצר Golden Light" checkbox column was replaced with a compact, tappable status cell (unresolved / matched + product sku-name / not Golden Light) that opens one shared "בחירת מוצר Golden Light" modal per row. The modal shows: an optional code/barcode input, the live auto-suggestion (or ambiguous/fuzzy candidates) computed from the once-loaded catalog, a free-text catalog search (never dumps all ~211 products into one list), and an explicit "לא מוצר Golden Light" action. Selecting a product only updates the in-progress row draft - it is persisted the same way every other row edit already was, through `buildManualItemsPayload()` and the existing finalize/save RPC call.

### What stayed untouched

`finalize_purchase_report()` (015) calls `save_manual_receipt_items()`/`award_purchase_points()` by name/signature and needed no change. `review_purchase_report()` (010, rejection), G Level (017), `receipt_line_matches`/`receipt_ocr_*` (005/007), and `productMatcher.ts`/`productMatchPersistence.ts` (the still-undeployed OCR pipeline) are all unmodified. No OCR provider integration, wholesaler/source detection, AI/LLM matching, or points-formula/G-Level/rewards change was made.

## Product matching UX: catalog lookup lives entirely inside the "מוצר Golden Light" control (Stage 3)

020_manual_item_alias_source_text.sql (function-only, no schema change) plus a client-side rework of AdminReportDetailScreen.js/productMatching.js: the admin manual-item row keeps its original FOUR visible columns - תיאור מוצר / כמות / מחיר ליחידה / מוצר Golden Light - with no separate SKU or barcode field anywhere in the row. Every catalog lookup, by SKU, barcode, or description/name, happens inside the product-match modal opened from the "מוצר Golden Light" cell, through ONE search box.

### One search box, one ranking function

`getProductSuggestions(query, catalog, limit)` (productMatching.js) is the single ranked-suggestion function behind the modal's one search input. Priority order: exact barcode -> exact SKU -> normalized SKU -> known alias -> exact normalized name -> partial SKU/barcode prefix -> partial SKU/barcode/name substring -> fuzzy name similarity (last-resort fallback, mirroring matchManualItem()'s own strategy order). It only ever returns a ranked list - nothing is auto-selected by this function itself at any tier, including an exact barcode match; ambiguity (e.g. the real duplicate barcode `753287487971`) surfaces multiple ranked candidates instead of guessing. Opening the modal (`openMatchModal()`) seeds the search box with the row's current description, so a row that already has text shows relevant suggestions immediately without retyping - the admin can freely replace that seeded text with a SKU or barcode instead, since the same box searches all three.

### Selection is authoritative and always synchronizes description + SKU

`applyProductToRow()` is the ONE place a selected search result is ever applied. It always overwrites both `description` and `sku` to the selected product's own canonical values (never a "description = product A, sku = product B" mismatch) and sets `product_id`/`match_status: 'matched'`/`match_type: 'manual'` (every selection from the modal's search results is an explicit admin pick).

### Stale matches are cleared, not silently kept

`updateManualRow()` checks, on every description keystroke, whether an already-'matched' row's description still equals its `matched_product_name` - if the admin edits it away from the matched product, the match is cleared back to 'unresolved' (product_id/match_type/match_confidence/matched_product_* all reset) in the same update, so a row can never keep a stale `product_id` that no longer corresponds to its visible description. `sku` is never independently edited by the admin anymore (there is no SKU input in the row), so it can never drift on its own - it is only ever set by applyProductToRow(), always in lockstep with description/product_id.

### Alias learning still works even though description is now overwritten

Because `applyProductToRow()` always overwrites `description` to the canonical name, the admin's original receipt wording (e.g. "מפסק 1M לבן" for official product "מפסק יחיד 1 מודול לבן", typed into the modal's search box before selecting) would otherwise be lost before `save_manual_receipt_items()`'s alias-learning check ever sees it. `applyProductToRow()` captures the row's PRE-selection description into `alias_candidate_text` whenever it genuinely differs from the product's own name/sku, `buildManualItemsPayload()` sends it as `alias_source_text`, and 020_manual_item_alias_source_text.sql's `save_manual_receipt_items()` uses it - instead of the now-canonical `description` - to learn the alias, falling back to `description` when absent (fully backward compatible). No schema change; only that one function body was replaced.

### What stayed untouched (this stage)

The product catalog schema, the `floor(eligible_total * 0.2)` points formula, G Level, `finalize_purchase_report()`/`review_purchase_report()`, the OCR pipeline, the customer-facing UI, and every RLS policy/grant are all unmodified. The matching confidence VALUES (barcode 1.00 / sku 0.99 / normalized sku 0.97 / alias 0.98 / description-exact 0.95 / fuzzy capped below all of those) are unchanged - only the UI-layer suggestion/ranking logic (a display concern) was added.

## Notes

- Email is still managed by Supabase Auth and is not duplicated in profiles.
- The schema now includes an OCR data foundation (receipt_ocr_results, receipt_ocr_lines), a product matching foundation (receipt_line_matches), a real product catalog foundation (products.barcode/product_family, product_aliases.alias_sku/source_name, supabase/scripts/import-product-catalog.mjs), deterministic manual-item product matching with a unified inline suggestion UX (receipt_manual_items.product_id/match_type/match_confidence/match_status, src/services/productMatching.js's getProductSuggestions()/matchManualItem() - see "Product matching foundation (Stage 2)" and "Product matching UX (Stage 3)" above), a points-awarding foundation (points_transactions, finalize_purchase_report - eligibility reads match_status, not is_golden_light directly, though the two can never disagree), and automatic G Level progression (recalculate_membership_level), but still does not include reward redemption, point reversal/adjustment, OCR provider integration, or wholesaler/source detection.
- The normal admin review flow is now a single unified action ("אישור וסיום טיפול" - see "Unified one-click review workflow" above); the older separate save/approve/award-points steps described earlier in this document no longer reflect the app's actual UI, though every RPC they relied on still exists in the database exactly as documented (nothing was dropped).
- The admin manual-entry form no longer collects `sku`/`line_total` (see "Simplified admin manual-entry fields" above); both columns remain in `receipt_manual_items` for any historical row and for possible future OCR use, but eligibility is now calculated purely from `quantity * unit_price`.
- The process-receipt Edge Function (supabase/functions/process-receipt) exists as source-controlled code only. It has not been deployed and is not yet called from the app.
- Migration 007_create_product_matching.sql has been run; `public.receipt_line_matches` exists. The real Golden Light catalog has not been imported into the live database yet (see "Product catalog foundation (Stage 1)" above - the migration and import script exist, but neither has been run against the live project), so live matching still currently resolves every line to `unmatched`.
- Deterministic product matching (`productMatcher.ts`/`productMatchPersistence.ts`) is now called from `process-receipt/index.ts` after OCR persistence. This does not change today's observed behavior, since the function's success path is still unreachable without a configured OCR provider - see "Product matching foundation" above for the full integration and failure-isolation details.
