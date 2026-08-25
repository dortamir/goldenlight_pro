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

This is a data foundation only - no points logic exists here. **Superseded by "OCR Integration Stage 1: Azure Document Intelligence" below**: a real OCR provider (Azure Document Intelligence, prebuilt-invoice) is now integrated and this schema has been extended with structured fields; product matching still does not run against real OCR data yet (see that section for exactly why).

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

`supabase/functions/process-receipt` is the server-side foundation for OCR processing. It is source-only in this repository - it has not been deployed yet. **The rest of this section describes the ORIGINAL foundation stage, before Azure was integrated - kept for history.** For what this function actually does today (real Azure Document Intelligence integration, the new claim/concurrency model, and why product matching is deliberately still not invoked), see "OCR Integration Stage 1: Azure Document Intelligence" near the end of this document.

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

`public.receipt_line_matches` (added in `007_create_product_matching.sql`, now applied) and `supabase/functions/process-receipt/productMatcher.ts` / `productMatchPersistence.ts` together classify each OCR receipt line as matched to a real Golden Light product, unmatched, or flagged for manual review. **Superseded by "OCR Product Matching Stage 3" near the end of this document**: the matcher is now genuinely wired into the live, deployed `process-receipt` function (using Stage 2's normalized evidence first, falling back to this section's own strategies) - the "not deployed"/"integrated into the live function" wording below describes an earlier, pre-Azure-integration state of this codebase, kept for history.

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

## OCR Integration Stage 1: Azure Document Intelligence

`021_ocr_azure_document_intelligence.sql` plus a rewrite of `supabase/functions/process-receipt/ocrProvider.ts` (and supporting changes to `ocrParser.ts`/`ocrPersistence.ts`/`index.ts`) connect the previously-stubbed `process-receipt` Edge Function to a real OCR provider: Azure Document Intelligence, model `prebuilt-invoice`, API version `2024-11-30`. This stage is **ingestion and persistence only** - it does not approve/reject a report, does not award points, does not change G Level, and does not run product matching against the new data (see "Product matching is deliberately not invoked yet" below).

### Why the schema needed to grow

The original `NormalizedOcrResult` contract (`ocrParser.ts`) only carried `text`/`quantity`/`unitPrice`/`total` - enough for a generic OCR provider, but not enough to preserve what Azure's `prebuilt-invoice` model actually returns for each invoice row: a separate `ProductCode` field, a per-field confidence score, and the complete raw structured object (value/content/confidence/boundingRegions/spans). Real testing against Golden Light invoices surfaced concrete cases this stage must handle faithfully without ever "fixing" them:

- A `ProductCode` value like `"600302 9"` - the real SKU with a stray adjacent row number glued on. Stage 1 stores this **exactly as Azure returned it**. No token-stripping, no cleanup, anywhere in this stage.
- A `Quantity`/`UnitPrice` extracted with low confidence. Stage 1 persists the value **and** its confidence, never filters or hides the row based on a threshold, and never treats a value as authoritative.
- An invoice row visible in the document's raw text but absent from the structured `Items` array. Stage 1 never fabricates a `receipt_ocr_lines` row for it - the row's evidence still exists, in the full raw text/response, for a later fallback parser.

### `receipt_ocr_results` - new columns

`raw_response jsonb`, `model_id text`, `api_version text`, `started_at timestamptz`. `raw_response` is the **complete** Azure `analyzeResult` JSON, stored verbatim - this is both the "traceability" requirement (debug a missed row later without rerunning OCR) and the "raw OCR text/content" requirement (it already contains `analyzeResult.pages[].lines[]` with per-line content/spans, so no second "raw pages" column was added - it would only duplicate what `raw_response` already holds). None of these four columns were added to the existing customer column-select grant - they stay unreadable by any client role via a plain `SELECT`, exactly like `error_message` already is.

### `receipt_ocr_lines` - new columns

`product_code text`, `description_confidence`/`product_code_confidence`/`quantity_confidence`/`unit_price_confidence`/`amount_confidence numeric` (all constrained to `[0, 1]`, same convention as `receipt_line_matches.confidence`), `raw_item jsonb` (the complete Azure `Items[i]` object for that one row, the per-line equivalent of `raw_response`). `receipt_ocr_lines` had a **whole-table** select grant with no column list (`005_create_receipt_ocr.sql`), so a plain `ALTER TABLE ADD COLUMN` would otherwise have made every one of these new columns immediately readable by a customer selecting their own OCR lines. This migration explicitly carves all seven back out (`revoke select (...) ... from authenticated`) - the same pattern already used for `is_golden_light`/`created_by`/`reviewed_by`/`error_message` elsewhere in this schema.

### `public.claim_ocr_processing(p_report_id, p_force_retry)` - concurrency-safe start/retry

The single entry point for starting or retrying an OCR run, replacing the old plain `upsert()` in `index.ts` that had no protection against two near-simultaneous invocations for the same report both proceeding to call Azure. Locks the `purchase_reports` row first (`for update`, the same technique `finalize_purchase_report()`/`award_purchase_points()` already use for their own concurrency guarantees), which serializes any two calls for the same report - the second blocks until the first commits, then re-reads the now-current status instead of racing it.

Default behavior (`p_force_retry = false`): no existing `receipt_ocr_results` row, or `status = 'failed'`, may proceed; `status = 'processing'` is rejected (`already_processing`); `status = 'completed'` is rejected (`already_completed`) - this is what prevents an accidental duplicate (costed) Azure call for an already-finished report. `p_force_retry = true` is the explicit, deliberate retry path the task's cost/duplicate-protection requirement asked for - it may override any current status, including a stuck `processing` row left by a crashed invocation. No UI calls this with `true` yet; it is backend plumbing only (`index.ts` accepts an optional `forceRetry` boolean in its request body and passes it straight through).

Callable only by the trusted service-role connection - `execute` is revoked from `anon`/`public`/`authenticated` entirely, unlike every `is_admin()`-gated RPC elsewhere in this schema. This function has no caller-identity check of its own because it is never meant to be reachable from the app's own Supabase client under any circumstance, only from `process-receipt`'s own server-side service-role client. **Correction (verified live, see OCR Integration Stage 2 below): `service_role` does NOT automatically have EXECUTE on functions in this project** - this migration's original comment claiming it "bypasses grants regardless" was wrong. `get_admin_ocr_result(uuid)`, `get_admin_ocr_lines(uuid)`, `claim_ocr_processing(uuid, boolean)`, and `normalize_receipt_line(text)` all had to be granted to `service_role` manually against the live database, since this migration (021, already applied) never did so explicitly. This migration's source is left as originally applied (already-applied migrations are not edited) - the correction is applied going forward starting with 022.

### `public.get_admin_ocr_result(p_report_id)` / `get_admin_ocr_lines(p_report_id)` - admin diagnostic read

The admin/backend-only read path for every column this migration deliberately excluded from the plain SELECT grant. Mirrors `public.get_admin_manual_items()` exactly (same `is_admin()` gate, same `security definer`/`search_path = ''` convention). This is a read-only data-access primitive, not an admin UI change - no screen calls either function yet, per this stage's explicit "do not redesign Admin UI" scope.

### Authorization: owner or admin, never an arbitrary caller

`index.ts` resolves the caller's identity from their own JWT (`auth.getUser()`, never trusted from the request body), then loads the report with the service-role client and checks `report.user_id === user.id`. If it doesn't match, the function now additionally checks `admin_users` (via the service-role client, bypassing that table's own RLS - exactly what a trusted backend check should do) before falling back to an identical "Report not found" response either way. This satisfies the "owner OR an authorized server/admin path" requirement without changing `admin_users`' own RLS/grants at all.

### Sending the private receipt to Azure

Unchanged from the original foundation: the function downloads the exact object at `purchase_reports.receipt_path` (loaded from the database, never the request) with the service-role client - never a public URL, never a signed URL handed back to any caller. The raw bytes are sent directly as the POST body to Azure; no temporary/permanent public copy of the receipt is ever created.

### The Azure request/poll cycle (`ocrProvider.ts`)

```
POST {endpoint}/documentintelligence/documentModels/prebuilt-invoice:analyze?api-version=2024-11-30
  headers: Ocp-Apim-Subscription-Key: <key>, Content-Type: <the file's real content type>
  body: raw file bytes
```

A successful submission returns `202 Accepted` with an `Operation-Location` header (never the result itself - Azure invoice analysis is asynchronous). That URL is then polled with the same subscription-key header every 2 seconds, up to 45 attempts (~90s total budget) - each individual HTTP call also has its own 20s timeout via `AbortController`. Polling stops as soon as the body's `status` is `succeeded` (returns `analyzeResult`) or `failed` (returns Azure's own `error` object); anything else (`notStarted`/`running`) keeps polling. Exceeding 45 attempts is a `timeout` failure, not an infinite loop. A non-202 submit response, a non-2xx poll response, or a poll body that isn't valid JSON are all distinct, safely-handled failure reasons (`http_error`/`invalid_response`) - never a silent success.

Every error message built from an Azure response (`buildSafeErrorMessage()`) is constructed only from the HTTP status and Azure's own response body (truncated to 500 chars) - the subscription key is never part of any response body Azure could echo back, and the key/Authorization-equivalent header is never included in any logged or persisted string anywhere in this module.

### Extraction is minimal and defensive (`extractInvoiceItems`/`buildNormalizedResult`)

Pure, unit-tested functions (see `ocrProvider.test.ts`) that translate `analyzeResult.documents[0].fields.Items.valueArray[]` into the `NormalizedOcrLine[]` contract: each item's `Description`/`ProductCode`/`Quantity`/`UnitPrice`/`Amount` sub-fields are read via a documented fallback chain (`valueCurrency.amount` → `valueNumber` for numbers; `content` → `valueString` for text), and a numeric field is **only** kept if Azure itself typed it as a number/currency - a string-typed value is never parsed into a number here, the same "never guess" posture `normalizeNonNegativeNumber()` already enforces in `ocrParser.ts`. The complete raw `Items[i]` object is always attached as `rawItem` regardless of what could be extracted from it. `buildNormalizedResult()`'s `rawText` is `analyzeResult.content` - the full document text Azure extracted, independent of which rows made it into the structured table.

`parseOcrResult()` (`ocrParser.ts`) then cleans/validates this the same way it always has: `productCode` gets the identical trim-and-collapse-whitespace treatment as `rawText` (so `"600302 9"` stays `"600302 9"` - the internal single space is original structure, not incidental whitespace), and a new `normalizeConfidence()` keeps only a finite number in `[0, 1]`, discarding (never clamping) anything else.

### Product matching is deliberately not invoked yet

An earlier foundation stage already wired `matchOcrLine()`/`persistLineMatches()` (`productMatcher.ts`/`productMatchPersistence.ts`) to run automatically right after OCR persistence in `index.ts`. **That call site has been removed for this stage** - not because matching's rules changed (`productMatcher.ts`/`productMatchPersistence.ts` are byte-for-byte unmodified), but because OCR Integration Stage 1 is explicitly scoped to "OCR extraction + persistence only," and real OCR output reaching that dormant call for the first time (now that a provider actually succeeds) would mean this stage silently starts real automatic product matching from OCR - which the task this stage implements explicitly forbids. Matching remains unreached for a new, deliberate reason, not the old accidental one (no provider ever succeeding). A later stage is expected to redesign matching to actually use the new structured fields (`product_code`, per-field confidence) instead of only the old plain-text `raw_text`/`normalized_text`, and to re-wire the call deliberately.

### Report status: unchanged lifecycle, just finally reachable

`purchase_reports.status` still moves `submitted → processing → needs_review` regardless of whether OCR succeeds or fails - this was already the intended, documented pipeline (see "`completed` OCR vs. purchase report `needs_review`" above); Stage 1 does not introduce a new status or change this behavior, it just makes the success path reachable for the first time. `receipt_ocr_results.status = 'completed'` still only means OCR itself succeeded, never approval - nothing in this stage sets `purchase_reports.status = 'approved'`, writes `points_awarded`, or touches any `profiles` column.

### Idempotency / duplicate-call protection

Two layers, both new: `claim_ocr_processing()`'s row lock (above) rejects a second concurrent/duplicate call outright before any Azure request is ever sent, and `persistOcrResult()`'s existing delete-then-insert-lines behavior (unchanged from the original foundation) still makes a legitimate retry safe - re-running OCR for the same report can never append duplicate lines or leave stale ones behind.

### Logging

`index.ts` logs only: report id, `{forceRetry}` on start, the provider's failure `reason` category (e.g. `not_configured`, `timeout`) on failure, and line/match counts on success - never the Azure key, never a request header, never the full raw receipt content or the full Azure response body. `ocrProvider.ts`'s own error messages are pre-truncated to 500 characters before they ever reach a log line or `error_message` column.

### What was NOT changed

`productMatcher.ts`, `productMatchPersistence.ts`, `receipt_manual_items`, `save_manual_receipt_items()`, `finalize_purchase_report()`, `award_purchase_points()`, `recalculate_membership_level()`, G Level thresholds, the customer-facing UI, the Admin UI, and every RLS policy/grant that already existed are all unmodified. No points are awarded, no report is approved/rejected, and no G Level changes as a result of anything in this stage.

### Deployment (not performed by this stage)

```sh
supabase functions deploy process-receipt
```

Requires `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT`/`AZURE_DOCUMENT_INTELLIGENCE_KEY` to already exist as Edge Function secrets (per the task, these already do) - `SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY` are provided automatically by Supabase for a deployed function. Invocation is `supabase.functions.invoke('process-receipt', { body: { purchaseReportId, forceRetry? } })` with the caller's own session (owner or admin) - no client code calls this automatically yet; that remains a separate future stage, same as before this one.

### Still requires live verification

This stage was verified via `tsc`, Deno-shape review, and pure-function unit tests against realistic fixture JSON (`ocrParser.test.ts`, `ocrProvider.test.ts`) - none of which touch a network or a real database. Not verified here, and requiring a live Supabase project + real Azure credentials to confirm: the actual Azure HTTP submit/poll cycle end-to-end against a real Golden Light invoice, `claim_ocr_processing()`'s locking behavior under genuine concurrent requests, the migration's `ALTER TABLE`/constraint statements running cleanly against the live database, and the two new admin RPCs' actual output shape against real data.

## OCR Integration Stage 2: Golden Light invoice normalization + row recovery

`022_ocr_normalization.sql` plus a new `supabase/functions/process-receipt/ocrNormalization.ts` turn Stage 1's imperfect Azure structured `Items` into cleaner, more trustworthy OCR evidence - **without ever overwriting the original Azure fields** and **without running product matching**. A normalized row is not an approved product and not points-eligible: nothing in this stage sets `product_id`, `match_status`, `receipt_line_matches`, `receipt_manual_items`, or `is_golden_light`, and `matchOcrLine()`/`persistLineMatches()` are still not invoked (see "Product matching is deliberately not invoked yet" above - unchanged by this stage).

### Root parsing problems this stage addresses

Real, observed Azure `prebuilt-invoice` extraction imperfections against actual Golden Light invoices:

- **ProductCode contamination** - `"600302 9"`, `"500511 6"`, `"500631 6"`: the real catalog SKU plus an adjacent table/index digit Azure folded into the same field.
- **Wrong numeric field selected as Quantity** - e.g. SKU 411005: Azure read `Quantity=13`, but `20 × UnitPrice(10.4) ≈ Amount(208.01)`, and `20` is genuinely present elsewhere in the row's own raw text; SKU 411007 similarly (`Quantity=10.5` should be `50`).
- **Two invoice rows merged into one Azure Item** - one real case had ProductCode `"411208"` + `"414001"` and two Description lines collapsed into a single structured item.

### Files created

- `supabase/migrations/022_ocr_normalization.sql`
- `supabase/functions/process-receipt/ocrNormalization.ts` (pure logic + the one DB-touching function, `normalizeAndPersistOcrLines()`)
- `supabase/functions/process-receipt/ocrNormalization.test.ts`

### Files modified

- `supabase/functions/process-receipt/index.ts` - calls `normalizeAndPersistOcrLines()` right after `persistOcrResult()` succeeds, isolated in its own try/catch (a normalization failure never undoes the already-persisted OCR success).
- `supabase/functions/process-receipt/productMatcher.ts` - `CatalogProduct` gained an optional `barcode?: string | null` field. Not read by `matchOcrLine()` - exists only so `loadActiveProductCatalog()` has one shared catalog shape for both this stage's barcode-evidence check and the (still separately invoked) matcher.
- `supabase/functions/process-receipt/productMatchPersistence.ts` - `loadActiveProductCatalog()`'s `select` now also reads `barcode`. No behavioral change to matching itself.

### Migration 022 details

Additive only - extends `receipt_ocr_lines` (never edits migration 021):

- `normalized_product_code text`, `normalized_quantity numeric`, `normalized_unit_price numeric`, `normalized_total numeric` - derived/validated values, living alongside (never replacing) the original `product_code`/`detected_quantity`/`detected_unit_price`/`detected_total` from Stage 1.
- `normalization_status text`, constrained to `'clean' | 'corrected' | 'ambiguous' | 'merged_recovered' | 'needs_review'` or `null` ("not yet normalized").
- `normalization_notes jsonb` - full per-field traceability (see "Source of truth / traceability" below); not schema-constrained, same "no enum needed yet" reasoning as `receipt_line_matches.match_method`.
- `source_ocr_line_id uuid references receipt_ocr_lines(id) on delete cascade` + `is_recovered_row boolean not null default false` - support merged-item row recovery (below). Two new CHECK constraints enforce a recovered row always has a source, and never references itself.
- The same "whole-table grant would otherwise leak new columns to customers" risk from migration 021 applies again here - all eight new columns are carved back out of the customer/admin-shared `SELECT` grant via `revoke select (...) ... from authenticated`, exactly like Stage 1's own columns.
- `get_admin_ocr_lines()` (021) is extended to also return all eight new columns, rather than adding a second near-duplicate function. `CREATE OR REPLACE` alone cannot change a `RETURNS TABLE` function's column set (Postgres error 42P13, the same class of error already fixed once before for `get_admin_manual_items()` in `019_product_matching_manual_items.sql`) - 022 first does `drop function if exists public.get_admin_ocr_lines(uuid);` (safe whether this is the first run or a retry after a previous failed attempt at exactly this statement), then recreates it with the original 16 columns plus the 8 new ones (24 total), with the exact same `is_admin()`/`security definer`/`search_path` behavior as 021. **Grants are NOT identical to 021, and deliberately so**: `DROP FUNCTION` removes the function object entirely, including the `service_role` `EXECUTE` grant that had been added manually against the live database (021's own source never granted it - see the correction note under "OCR Integration Stage 1" above). 022 re-grants `execute` to both `authenticated` and `service_role` explicitly after recreating the function, so `process-receipt`'s service-role client does not silently lose the ability to call it the moment 022 is applied.

### Normalized fields / data model

One extra set of columns on the SAME `receipt_ocr_lines` row - no second table, no parallel pipeline. A recovered (split) row is a genuinely NEW row (own `id`, own `line_index` continuing after the source report's highest original index) with `is_recovered_row = true` and `source_ocr_line_id` pointing at the original merged Azure item; it carries no `raw_item`/`detected_*` of its own (there is no separate Azure evidence for a row Azure itself never separated - only the parent's `raw_item` holds the real evidence), only `raw_text`/`product_code` copied verbatim from the parent's own Description/ProductCode content, plus `normalized_product_code` and `normalization_status = 'merged_recovered'`.

### ProductCode cleanup algorithm (`resolveProductCode`)

1. Split the raw `product_code` on whitespace/newlines into candidate tokens (`"600302 9"` → `["600302", "9"]`).
2. Normalize each token exactly like `public.normalize_catalog_text()` (via `productMatcher.ts`'s existing `normalizeCatalogText()` - reused, not duplicated) and look it up against every **active** catalog SKU, normalized the same way.
3. Zero real matches → `no_catalog_match`. Exactly one distinct real match → `validated`, `normalized_product_code` = that canonical SKU. More than one **distinct** real match (or a rare catalog-level normalization collision) → `ambiguous`, `normalized_product_code` stays `null` - never silently chosen.

No digit-stripping heuristic exists anywhere - every candidate is checked against the real, live catalog.

### Quantity correction algorithm (`reconcileQuantity`)

Only quantity is ever corrected (unit price/total are carried through unchanged - every real observed case was specifically a wrong Quantity selection, never a wrong UnitPrice/Amount):

1. If quantity, unit price, or amount is missing → `incomplete` (not enough evidence to check at all; the original quantity passes through untouched).
2. If `quantity × unitPrice ≈ amount` (within tolerance) → `consistent`, unchanged.
3. Otherwise, compute `impliedQuantity = amount / unitPrice`. If a raw numeric token found anywhere in the row's own text/content is close enough to `impliedQuantity` → `corrected_from_raw`, `normalized_quantity` = that raw token's exact value (never the possibly rounding-noisy division result itself) with `reason: 'amount_unit_price_consistency'`.
4. If nothing in the raw text corroborates the implied quantity → `inconsistent`, `normalized_quantity` stays `null` - the math alone is never sufficient evidence.

### Numeric consistency / tolerance rule

Two named constants, both absolute (not relative/percentage): `AMOUNT_TOLERANCE = 0.05` (currency units, for the `quantity × unitPrice ≈ amount` check) and `QUANTITY_MATCH_TOLERANCE = 0.05` (for "does a raw token match the implied quantity"). Both are small enough to only absorb genuine rounding noise (real cases: `20 × 10.4 = 208.0` vs. `Amount 208.01`, a `0.01` difference) while still being useless for validating an unrelated pair of numbers.

### Merged-row recovery algorithm (`detectMergedItem`)

Deliberately content/evidence-based, never pixel-coordinate-based (per the task's own warning that photographed invoices are rotated/skewed/shot at different distances):

1. Tokenize the Azure item's own `ProductCode` field content. Keep only tokens that resolve to a **single, unambiguous, active** catalog SKU, deduped by product, in first-appearance order.
2. Fewer than 2 distinct real SKUs → not a merge (this is `resolveProductCode`'s territory instead - a single valid code plus noise).
3. 2+ distinct real SKUs → strong merge evidence. Split the item's `Description` field content on newlines. If the segment count **exactly matches** the SKU count → pair them positionally (SKU 1 ↔ description segment 1, SKU 2 ↔ description segment 2, …) and produce that many recovered row candidates.
4. If the segment count does **not** match → merge is still `detected: true`, but `recoveredRows: null` - evidence of a merge exists, but not enough to safely pair descriptions to codes, so nothing is split. The task's own instruction ("do not guess a pairing") is enforced literally here.

Whenever a merge is detected (split or not), the **parent** row's own `normalized_product_code`/`normalized_quantity`/`normalized_unit_price`/`normalized_total` are always `null` and its status is always `needs_review` - its single set of fields is never presented as authoritative once evidence shows it actually represents more than one product, regardless of whether the split itself succeeded.

### Barcode handling (`resolveBarcodeEvidence`)

Extracts exactly-13-digit tokens from the row's raw text and looks each up against `products.barcode` (active products only). `unique` (exactly one match), `ambiguous` (more than one - the real Stage 1 duplicate-barcode case, `753287487971` shared by GSWITCH `412525`/`412575`, is covered by an explicit test), `no_match`, or `no_evidence`. Strictly evidence-only: an ambiguous or even a unique barcode match is never used to set `normalized_product_code` in this stage - it lives only in `normalization_notes.barcode` for a later matching stage to use.

### Exact behavior for ambiguous evidence

Never resolved automatically, in any of the four places ambiguity can arise: `resolveProductCode` (multiple real SKU tokens), `detectMergedItem`'s pairing step (segment-count mismatch), `resolveBarcodeEvidence` (shared barcode), and `reconcileQuantity` (no raw token corroborates the implied quantity). Every one of these leaves the relevant `normalized_*` field `null` and routes the row to `ambiguous` or `needs_review` (see `normalizeOcrLine()`'s precedence below) - full detail (which tokens/candidates were considered) is always preserved in `normalization_notes`, never discarded.

### `normalizeOcrLine()`'s status precedence

Highest to lowest: a detected merge (regardless of split success) → `needs_review`; an inconsistent quantity or a product code matching no active SKU at all → `needs_review`; an ambiguous product code or barcode → `ambiguous`; a corrected quantity or a product code that needed multi-token cleanup → `corrected`; otherwise → `clean`. Exactly the five states the task suggested - no extra states invented.

### Exact pipeline integration point

`process-receipt/index.ts`, immediately after the existing `persistOcrResult()` call succeeds (still before the still-dormant product-matching call site and the `needs_review` status transition): `await normalizeAndPersistOcrLines(adminClient, ocrResultId)`, wrapped in its own try/catch so a normalization failure is logged and swallowed rather than undoing the already-durable OCR success - the report still reaches `needs_review` either way (lines simply keep `normalization_status = null`, "not yet normalized," if this step fails). Safe logs only: report id, `sourceItemCount`, `normalizedRowCount`, `correctedCount`, `ambiguousCount`, `needsReviewCount`, `mergedRecoveredCount` - never full invoice content.

### Idempotency behavior

`normalizeAndPersistOcrLines()` is only ever called right after `persistOcrResult()`'s own full delete-then-insert of every `receipt_ocr_lines` row for that `ocr_result_id` (Stage 1, unchanged) - which already deletes any previously recovered rows too, since they share the same `ocr_result_id` and that delete has no `is_recovered_row` filter. Every re-run therefore starts from the same fresh Stage 1 evidence and deterministically regenerates the same normalization output; there is never a stale or duplicated recovered row to reconcile.

### Security/RLS impact

No new client write privileges anywhere. Normalization runs entirely server-side inside `process-receipt`, using the same service-role client already authorized by `index.ts`'s existing owner-or-admin check - no service-role key ever reaches client code. The eight new `receipt_ocr_lines` columns are carved out of the customer-readable grant (see migration 022 above); the only read path for them is the existing admin-gated `get_admin_ocr_lines()`, extended, not a new/broadened grant.

### Test results (Cases A-F)

54 tests pass (30 new in `ocrNormalization.test.ts`, plus the pre-existing 17 in `ocrParser.test.ts` and 7 in `ocrProvider.test.ts`, unaffected) - actually **executed** (not just type-checked) by transpiling the pure functions with `@babel/preset-typescript` and running them under Node with a minimal `Deno.test`/`assertEquals` shim, since Deno itself isn't installed in this environment. Every task-specified case is covered directly: **A** (`"600302 9"` → `"600302"`, plus the `"500511 6"`/`"500631 6"` variants), **B** (SKU 411005: `13` → `20`), **C** (SKU 411007: `10.5` → `50`), **D** (two merged SKUs + two description lines → two recovered rows; and the insufficient-evidence fallback → `needs_review`, nothing paired), **E** (the real duplicate barcode → `ambiguous`), **F** (no reconciling combination → `inconsistent`, `null`, original values untouched).

### Stage 2.1 refinement: joined ProductCode tokens + barcode leading-zero normalization + cross-evidence

A second real live case showed Stage 2's single-token ProductCode check was too narrow: Azure split the real 7-digit SKU `6003028` (catalog barcode `602697128922`) across two adjacent tokens, `"600302"` + `"8"` - neither token alone is a real SKU, so the row landed on `needs_review` even though the true product was recoverable. The same row's raw barcode OCR token, `"0602697128922"`, also had one extra leading zero versus the catalog's stored 12-digit value. This refinement (`ocrNormalization.ts` only - **no schema change**, no new migration) addresses both, plus adds a cross-check between the two independent signals.

#### Joined-token ProductCode candidates (`resolveProductCode`)

In addition to checking each individual token, `generateJoinedCandidates()` produces every deterministic **contiguous** concatenation of the tokens in their original order - `["600302", "8"]` → `["6003028"]`; a 3-token code `["a","b","c"]` → `["ab", "bc", "abc"]`. Never a prefix guess, never an arbitrary truncation/append - just literal concatenation of tokens exactly as Azure returned them, each checked against the real catalog the same way a single token already was. A joined candidate is accepted under the **exact same rule** as any other candidate: only if the full pool of candidates (individual tokens + joins together) resolves to exactly one distinct active product; more than one distinct match anywhere in that pool (including a rare catalog-level normalization collision) is `ambiguous`, never silently chosen. The original `product_code` column is never touched - `"600302 8"` stays exactly that.

#### Barcode leading-zero normalization (`resolveBarcodeEvidence`)

`normalizeBarcodeToken()` strips **leading** zeros only (never trailing/internal - a barcode's trailing digits are significant), applied symmetrically to **both** sides of every comparison: the extracted 13-digit raw OCR token and every catalog `barcode` value are both normalized the same way before being indexed/compared, so it doesn't matter which side happens to carry the extra zero. `"0602697128922"` (raw, 13 digits) and `"602697128922"` (catalog, 12 digits) both normalize to `"602697128922"` and match. Extraction itself is unchanged (still exactly-13-digit tokens only); only the comparison step gained normalization. `unique`/`ambiguous`/`no_match`/`no_evidence` semantics are otherwise unchanged from Stage 2 - still evidence only, never authoritative on its own.

#### Cross-evidence (`computeCrossEvidence`)

When a uniquely-resolved ProductCode and a uniquely-matched barcode both exist, they're compared: if they name the **same** product, that's recorded as corroboration (`normalization_notes.crossEvidence.agrees = true`) but does not itself change `normalized_product_code` - `resolveProductCode()` already produced it on its own sufficient evidence. If they name **different** products, neither is ever silently preferred: `normalizeOcrLine()`'s precedence forces `normalization_status = 'needs_review'` and clears `normalized_product_code` to `null`, even though the ProductCode resolution alone would have been confident. This sits in the precedence chain right after the existing "quantity inconsistent / no catalog match" `needs_review` checks and before the `ambiguous` checks.

#### The real row, end to end

`ProductCode: "600302 8"`, `Quantity: 195`, `UnitPrice: 195`, `Amount: 8190`, raw evidence containing `42` and `0602697128922`, catalog SKU `6003028` / barcode `602697128922`: `normalized_product_code = "6003028"` (via the joined candidate), `normalized_quantity = 42` (Stage 2's existing quantity-correction logic, unchanged - re-verified, not re-implemented), barcode evidence `unique` and agreeing with the SKU resolution, and **`normalization_status = 'corrected'`, no longer `needs_review` solely because of ProductCode**. 12 new tests (`ocrNormalization.test.ts`) cover this row plus the conflicting-evidence, no-match, and ambiguous variants; all 66 tests in the suite (12 new + 54 from Stage 1/2) pass.

### What still remains for Stage 3 (Product Matching)

**Superseded by "OCR Product Matching Stage 3" below**: `matchOcrLine()`/`persistLineMatches()` are no longer dormant - matching now runs automatically as part of `process-receipt`, using this stage's normalized evidence first. See that section for exactly how.

### Live deployment steps required

```sh
supabase functions deploy process-receipt
```

Apply `022_ocr_normalization.sql` (SQL Editor or CLI) **after** `021_ocr_azure_document_intelligence.sql` is already live (confirmed applied per your last message). No new secrets are required - this stage reads no new environment variables. Not verified here, requiring a live project to confirm: the migration's `ALTER TABLE`/constraint/`CREATE OR REPLACE FUNCTION` statements running cleanly against the live database, and a real end-to-end run against an actual merged-row/miscounted-quantity invoice (the fixtures here are realistic but synthetic, modeled on the real cases you described, not a captured real Azure response).

## OCR Product Matching Stage 3: wiring OCR lines into the existing matching foundation

Wires the Stage 1 (Azure OCR) and Stage 2/2.1 (normalization) evidence into the deterministic matching foundation that already existed but was dormant (`productMatcher.ts`/`productMatchPersistence.ts`, `receipt_line_matches`). **No new matcher, no new table, and no migration** - this stage extends the existing ones. `receipt_line_matches` already supported everything needed (`match_status`, free-text `match_method`, `confidence`, `matched_text`, `review_note`), confirmed by re-reading its exact constraints before writing any code.

### Files created

- `supabase/functions/process-receipt/productMatchPersistence.test.ts`

### Files modified

- `supabase/functions/process-receipt/productMatcher.ts` - added `matchOcrLineFromEvidence()` (the Stage 3 orchestrator) plus a ported fuzzy-description strategy (`normalizeDescriptionText`/`diceCoefficient`/`FUZZY_SUGGEST_THRESHOLD`/`FUZZY_MAX_CONFIDENCE`, mirrored from `src/services/productMatching.js` - see that file's own "SAME MATCHER AS THE FUTURE OCR PIPELINE, NOT A SECOND ONE" header, an already-established convention in this codebase for keeping the same algorithm in sync across the Deno/RN boundary that can't share code directly). `matchOcrLine()` itself is **byte-for-byte unchanged** and is called internally as the fallback cascade.
- `supabase/functions/process-receipt/productMatchPersistence.ts` - added `matchAndPersistOcrLines()` (load → filter → match → persist, one self-contained function mirroring `ocrNormalization.ts`'s own `normalizeAndPersistOcrLines()`), reusing the existing `loadActiveProductCatalog()`/`persistLineMatches()` without duplicating either.
- `supabase/functions/process-receipt/index.ts` - the dormant matching call site is re-enabled, right after Stage 2 normalization (successful or not).
- `supabase/functions/process-receipt/productMatcher.test.ts` - 18 new tests (Cases A-G + supporting coverage).

### Evidence priority (`matchOcrLineFromEvidence`)

1. A genuine Stage 2 SKU-vs-barcode conflict (`normalization_notes.crossEvidence.conflict`, read directly - never recomputed) → `needs_review` immediately, before anything else is tried.
2. `normalized_product_code`, when present - Stage 2 already validated it against the real active-SKU catalog, so an exact, unique equality lookup here is the strongest possible SKU evidence. Never re-split into multiple candidate tokens again.
3. Falls back to the existing, unchanged `matchOcrLine()` cascade (exact SKU → normalized SKU → alias exact → name exact) against the original `product_code` + line text - `product_code` is folded into the text passed in, since `matchOcrLine()`'s substring-based strategies were designed for a single flat OCR line, before Stage 1/2 separated `product_code` into its own column.
4. If that finds nothing (`unmatched`), a fuzzy description candidate (ported algorithm above) - always `needs_review`, never auto-matched, regardless of score.

Barcode evidence itself is never independently used to drive a match or a `needs_review` - it only ever participates via the pre-computed conflict check in step 1 (Stage 2's own `computeCrossEvidence()`), never recomputed or re-normalized here.

### Match types / states

Uses the existing 3-state model (`matched`/`needs_review`/`unmatched`) unchanged - no new states invented. `match_method` (already free text, no CHECK constraint) gains two new conceptual values: `normalized_sku_exact` and `description_fuzzy`, alongside the existing `exact_sku`/`normalized_sku`/`alias`/`name`. `review_note` gains `conflicting_evidence`, `ambiguous_normalized_sku_exact`, and `fuzzy_candidate`, alongside the existing `ambiguous_*` categories - all short, fixed categories, never raw receipt text, matching the established convention exactly.

### Conflict behavior

A genuine SKU-vs-barcode conflict (both independently unique, pointing at different products) short-circuits to `needs_review` with `product_id = null` **before** the `normalized_sku_exact` strategy even runs - a confident-looking SKU match never silently wins over an independent contradiction. When SKU + barcode agree, that's simply a normal `normalized_sku_exact` match (no separate "corroborated" state) - agreement was never in doubt to begin with.

### Recovered-row behavior

A merged-item **parent** row is never independently matched - `wasMergedParent()` checks `normalization_notes.merge.detected === true` directly (a single, simple, database-verified condition covering both "successfully split" and "detected but couldn't split," since neither leaves the parent's own evidence trustworthy as a single product). Each **recovered child** row is matched exactly like any other line - it has its own `normalized_product_code` (already set by Stage 2) and no `merge` key of its own, so it's never excluded and needs no special-casing beyond simply not being the parent.

### Persistence / idempotency

`matchAndPersistOcrLines()` first **deletes** every existing `receipt_line_matches` row for the current report's OCR lines, then persists the fresh set via the existing `persistLineMatches()` (upsert on `ocr_line_id`) - this closes a staleness gap Stage 3 itself introduces (a line that's matchable on one run could become an excluded merge-parent on a later re-normalization; without the delete, its old match row would otherwise never be cleaned up). A rerun always regenerates deterministically from the current OCR/normalization state.

### Security/RLS impact

None. Matching runs entirely server-side using the same service-role client already authorized by `index.ts`'s existing owner-or-admin check. No new grant, no new customer write privilege, no service-role key anywhere near client code.

### Test results (Cases A-G)

18 new tests, all passing (95/95 total in the suite, actually **executed** via the Babel/Node harness, zero regressions in the pre-existing 77):

- **A**: `normalized_product_code = "6003028"` (the real Stage 2.1 row) → `matched`, `method = normalized_sku_exact`, `confidence = 1.0`.
- **B**: no normalized code, no exact SKU/alias/name match → `unmatched` (the existing model's own "unresolved" concept - not a new state).
- **C**: SKU + agreeing barcode evidence → `matched` (no conflict flag set).
- **D**: SKU vs. conflicting barcode evidence → `needs_review`, `product_id = null`, `review_note = 'conflicting_evidence'`.
- **E**: only a fuzzy description candidate → `needs_review`, `review_note = 'fuzzy_candidate'`, never auto-matched.
- **F**: a merge-detected parent is provably excluded (`wasMergedParent()` tested directly); its two recovered children are matched independently to two distinct real products.
- **G**: no usable evidence at all → `unmatched`.

### Process-receipt integration point

`index.ts`, immediately after the Stage 2 normalization step (inside its own try/catch, so a matching failure never undoes the already-persisted OCR/normalization results) and before the report's `needs_review` status transition. Matching still runs even when normalization itself failed - `matchOcrLineFromEvidence()` simply has weaker evidence available (Stage 1's original `product_code`/`raw_text` only) and degrades gracefully.

### Confirmation

No approval, no points, no G Level: this stage never calls `finalize_purchase_report()`/`review_purchase_report()`/`award_purchase_points()`, never updates `points_balance`/`approved_purchases_count`/`membership_level`, and never writes `receipt_manual_items`/`is_golden_light`. `purchase_reports.status` still only ever moves to `needs_review`, exactly as before.

## OCR Admin Review Integration Stage 4: prefilling the existing manual-entry review form from OCR + matching

Wires Stage 1-3's OCR/normalization/matching evidence into the **existing** admin receipt-review form (`AdminReportDetailScreen.js`'s manual-item rows, `receipt_manual_items`, `get_admin_manual_items`/`save_manual_receipt_items`/`finalize_purchase_report`) as an initial seed only. **No second review form, no new table, no migration** - this stage only changes what the existing editable rows are initially populated with, never how they're saved or approved. Admin review, points, and G Level remain entirely unautomated: this stage never calls `finalize_purchase_report`/`review_purchase_report`/`award_purchase_points`, and never marks a row `not_golden_light` from OCR/matching data alone.

### Files modified

- `src/services/adminReportService.js` - `getAdminReportDetail()` now also loads OCR lines via the existing `get_admin_ocr_lines` RPC (the only way to read Stage 2's `normalized_*`/`normalization_status`/`normalization_notes`/`is_recovered_row` columns, deliberately excluded from the plain column grant) and `receipt_line_matches` (now also selecting `product_id`, already grant-permitted but not previously selected), then enriches matched lines with their product's `sku`/`name` via one additional targeted `products.select(...).in('id', ...)` query scoped only to the distinct matched product IDs for this report (never the full catalog, never per-row). The whole block is wrapped in its own try/catch resolving to empty arrays on failure, matching the existing `manualItems`/`pointsAward` isolation pattern - a failure here can never break the rest of the screen or regress the manual-entry fallback.
- `src/screens/AdminReportDetailScreen.js` - added `buildRowsFromOcrEvidence(ocrLines, lineMatches)` (builds the exact same row shape `buildRowsFromManualItems`/`createEmptyManualRow`/`applyProductToRow` already use - not a second row format) and `getOcrNormalizationHint(status)` (a small, non-alarming caption, never raw confidence/JSON). `loadDetail()` now seeds `manualRows` from `buildRowsFromOcrEvidence` only when `data.manualItems` is empty; both row layouts (wide-table and narrow-stacked) render the hint under a still-untouched OCR row's description. `applyProductToRow`, `updateManualRow`, `buildManualItemsPayload`, `saveAdminManualItems`, `finalizePurchaseReport`, and every other existing row-mutation/save function are unchanged and reused as-is.

### Source priority

1. **`receipt_manual_items` already exist for this report** -> they are loaded via the existing `buildRowsFromManualItems`, unchanged, and are authoritative. OCR/matching data is never consulted and can never overwrite an existing admin edit.
2. **No `receipt_manual_items` yet** -> rows are seeded from OCR + matching evidence via `buildRowsFromOcrEvidence`, which itself falls back to a single blank row when there is no OCR result, no OCR lines, or every line is a merge-parent - so a report with missing/failed OCR behaves exactly as it always has.

Nothing in this stage writes `receipt_manual_items` - that still only happens when the admin saves/finalizes through the existing, unmodified `saveAdminManualItems`/`finalizePurchaseReport` flow, at which point every future load of that report takes branch 1, permanently.

### OCR -> admin-row mapping

One row per matchable `receipt_ocr_lines` row (a merge-detected parent, `normalization_notes.merge.detected === true`, is excluded entirely; its recovered children appear as independent rows, same as Stage 3's own matching exclusion). For each row: `quantity` = `normalized_quantity` if present else `detected_quantity`; `unit_price` = `normalized_unit_price` if present else `detected_unit_price` (e.g. Azure `quantity=195`/`normalized_quantity=42`/`unit_price=195` prefills the row with quantity `42`, never the raw `195`). Only the existing four columns are populated - no SKU/total/confidence columns were added.

**Fix (post-Stage-4):** the row description is built by `getOcrLineDescription(line)`, which prefers the Azure item's own structured `raw_item.valueObject.Description` field (`valueString`, then `content`) over `raw_text`/`normalized_text` - those two columns hold the OCR engine's ENTIRE line-item content (SKU + barcode + quantity + unit price + amount + description all concatenated, per `ocrProvider.ts`'s `extractInvoiceItems()`), never just the product name. `raw_text` is used only as a last-resort fallback for a line whose `raw_item` is missing or shaped unexpectedly. `raw_item` is already returned by `get_admin_ocr_lines()` (021/022) and required no service/RPC change. The `receipt_line_matches.ocr_line_id` <-> `receipt_ocr_lines.id` join keys are also now `String()`-normalized on both sides before comparison - a defensive hardening (no behavior change for well-formed data) added while diagnosing a live report of a confirmed-matched line not rendering as matched; direct RLS simulation against the live database (`supabase db query --linked`, impersonating an admin session) proved the underlying data/grants/policies were already correct end-to-end, so no migration was needed for this fix.

### Matched row behavior

When `receipt_line_matches.match_status === 'matched'` and `product_id` is set, the row is prefilled exactly like `applyProductToRow()` already prefills a manually-searched match: `product_id`, `match_type` (from `match_method`), `match_confidence`, `match_status: 'matched'`, `matched_product_sku`/`matched_product_name`, and - mirroring the pre-existing invariant `updateManualRow()` already enforces (a matched row's `description` always equals `matched_product_name`, or the match is cleared as stale on the next edit) - `description` is set to the product's canonical name, not the raw OCR text. The "מוצר Golden Light" cell shows the green matched state and SKU immediately on open; the admin can still edit or change it before saving, using the same existing search modal.

### Unmatched / needs-review row behavior

Both Stage 3's `unmatched` and `needs_review` outcomes map to the manual-item row state `unresolved` (never `not_golden_light`, which the existing three-state model reserves for an explicit admin decision) - `product_id` stays `null` and no product is preselected. `receipt_line_matches` never persists a candidate list for `needs_review` (Stage 3's own `needsReviewResult()` always sets `productId: null`), so there is no already-persisted candidate to surface; the admin gets the existing manual search/autocomplete experience unchanged, with `description`/`quantity`/`unit_price` already prefilled from OCR.

### Recovered-row behavior

Identical to Stage 3's own exclusion: a merge-detected parent line never appears as its own row; each recovered child (its own real `receipt_ocr_lines` row) appears and matches independently, in line-index order.

### Normalization hint

A `normalization_status === 'corrected'` row shows a small muted caption ("זוהה ותוקן אוטומטית - מומלץ לוודא") under its description; `needs_review`/`ambiguous` shows a similarly muted "נדרשת בדיקה" caption. No raw confidence scores or JSON are ever shown. Every field remains fully visible and editable regardless of the hint.

### Save / finalize / points safety

Unchanged. OCR-prefilled rows are not authoritative until the admin saves through the existing `save_manual_receipt_items`/`finalize_purchase_report` RPCs - the same single save path used for manually-entered rows. No points are awarded, and no report is approved, merely because OCR or product matching found a product; that remains tied entirely to the existing admin finalization action.

### Security/RLS impact

None. All new reads go through RPCs/grants that already existed and were already admin-gated (`get_admin_ocr_lines`, `receipt_line_matches.product_id` per migration 007, `products` per migration 004) - no new grant, no new customer-visible data, no service-role key anywhere near client code. Customer-facing receipt-detail screens are untouched and still never see OCR/normalization/match data.

### Test results (Cases A-G)

9 tests, all passing, run directly against the real extracted `buildRowsFromOcrEvidence`/`getOcrNormalizationHint`/`buildRowsFromManualItems`/`createEmptyManualRow` source (Node harness, mirroring the Babel/Deno testing approach used in every earlier stage of this session):

- **A**: the live example (`normalized_product_code = "6003028"`, `normalized_quantity = 42`, `normalized_unit_price = 195`) -> row prefilled `match_status: 'matched'`, `product_id` set, `description` = "לוח חשמל תחת הטיח 54 מודול GBOX", `quantity: '42'`, `unit_price: '195'`, plus the "corrected" hint text.
- **B**: an unmatched line -> row visible with prefilled quantity/price, `match_status: 'unresolved'`, `product_id: null`.
- **C**: a `needs_review` line -> `match_status: 'unresolved'`, `product_id: null` - no authoritative product preselected.
- **D**: `buildRowsFromManualItems` reflects only the given manual items - confirmed structurally that OCR data plays no part when manual items exist (the real screen never even calls `buildRowsFromOcrEvidence` in that branch).
- **E**: zero OCR lines (and `null`/`null` inputs) fall back to the same single blank row `buildRowsFromManualItems([])` already produces - no regression for missing/failed OCR.
- **F**: a merge-detected parent with two recovered children -> the parent never appears as its own row; both children appear independently, matched to two distinct products.
- **G**: an OCR-prefilled row has the identical key set to a manually-created row (aside from the internal `normalizationStatus` field, never sent to `save_manual_receipt_items`) - confirming there is no second row format for existing edit/save logic to diverge from.

### Confirmation

No migration was needed - `receipt_manual_items.match_type` is already free text and `match_status` already supports `unresolved`/`matched` (never receiving `not_golden_light` from OCR-prefill code). No new RPC, no new table, no customer-visible change.

## Admin Finalization & Points Safety Stage 5: unresolved-item guard + full verification of the existing pipeline

Inspected the entire existing finalization/points pipeline against the LIVE database (via `supabase db query --linked` - live function definitions, grants, RLS policies, constraints, indexes, and triggers, plus isolated `BEGIN ... ROLLBACK` dry runs of every case below against real fixtures) before changing anything. Conclusion: the pipeline was already correct, atomic, and duplicate-safe. **Exactly one real gap was found and closed**: `finalize_purchase_report()` did not require every saved `receipt_manual_items` row to be in a decided state before approving the report. Nothing else changed - no new points logic, no new ledger, no new classification.

### The existing flow (confirmed, unchanged)

`AdminReportDetailScreen.handleFinalize()` -> `adminReportService.finalizePurchaseReport()` -> the single RPC `public.finalize_purchase_report(p_report_id, p_items)` (migration 015), which - all inside one Postgres transaction/function call - locks the report row (`for update`), re-checks it is still `submitted`/`needs_review`, calls `save_manual_receipt_items()` (validates and atomically replaces the report's `receipt_manual_items`, computing `is_golden_light` as a pure mirror of `match_status = 'matched'` per migration 019), sets `status = 'approved'`, calls `recalculate_membership_level()` (re-derives `approved_purchases_count`/`membership_level` from a fresh `COUNT(*) WHERE status = 'approved'` - fully idempotent, never an increment), and finally calls `award_purchase_points()`. There is no separate save-then-approve-then-award sequence anywhere in the client.

### Exact points formula (unchanged, confirmed live)

`award_purchase_points()`: `eligible_total = SUM(quantity * unit_price)` over every `receipt_manual_items` row for the report with `match_status = 'matched'` (never `receipt_ocr_lines`/`receipt_line_matches`/`normalized_*`/OCR confidence, and never `line_total`, which has been permanently `null` since migration 016); `points = floor(eligible_total * 0.2)`. Both values are read from whatever the admin most recently saved via `save_manual_receipt_items()` - there is no other source. No configurable conversion-rate table exists; `0.2` is a literal in the function body.

### Point-eligible items (unchanged, confirmed live)

A row counts toward points if and only if `match_status = 'matched'` (which the `receipt_manual_items_matched_requires_product`/`_unmatched_requires_no_product` CHECK constraints guarantee always has a real `product_id`). `is_golden_light` still exists on the table for display/backward compatibility but has had zero independent effect on eligibility since migration 019 - it is computed, never read, by the points logic. Since every row in `public.products` is a Golden Light catalog product by construction (`products.brand` defaults to `'Golden Light'`), "matched to a catalog product" already *is* "confirmed Golden Light product" - no separate Golden-Light-vs-not classification exists or was added.

### The one gap: unresolved rows could reach 'approved'

Neither the client (`getFinalizeBlockingReason`) nor any RPC required every row to be `matched` or `not_golden_light` before finalizing - only that the eligible total was positive. A half-reviewed report (some rows matched, one still sitting at the default `unresolved`) could be approved and become permanently unreachable for that review, with the unresolved row silently and correctly excluded from points but never actually decided on.

### Fix: migration 023

`023_finalize_requires_resolved_items.sql` - a single, narrowly-scoped `CREATE OR REPLACE FUNCTION public.finalize_purchase_report(...)` (same signature/return type, so no `DROP FUNCTION`/re-grant needed - `EXECUTE` to `authenticated`, gated internally by `is_admin()`, carries over unchanged). Adds one check, after `save_manual_receipt_items()` persists the rows and before the report is approved:

```sql
if exists (
  select 1 from public.receipt_manual_items
  where purchase_report_id = p_report_id and match_status = 'unresolved'
) then
  raise exception 'unresolved_items_remain' using errcode = '40001';
end if;
```

Uses only the existing three-state model (`unresolved`/`matched`/`not_golden_light`, migration 011/019) - no new state, no new column, no new table. A row the admin doesn't want to individually decide on can still be removed entirely via the existing "remove row" action. Mirrored client-side in `getFinalizeBlockingReason()` (disables the finalize button with a specific Hebrew message before the admin even submits) and in `getActionErrorMessage()` (translates the same error code if it reaches the server). `save_manual_receipt_items()` itself is untouched - the check lives only in `finalize_purchase_report()`, so plain saves and post-approval edits are unaffected.

**Verified live** via isolated `BEGIN ... ROLLBACK` transactions against the real database (function replaced, tested, then rolled back - nothing persisted): a report with one `not_golden_light` row and one `unresolved` row raised `unresolved_items_remain` exactly as designed; a fully-resolved report (one `matched` row, admin-saved quantity 40 / unit_price 195) finalized successfully and computed `eligible_pre_vat_amount = 7800`, `points = 1560` - proving points come from the admin-saved value, never a stale OCR one.

### Duplicate-award protection (already complete, confirmed live - no fix needed)

Three independent layers, all verified against the live database:
1. Client `finalizing` React state disables the button during the in-flight request (UX only).
2. `finalize_purchase_report()`/`award_purchase_points()` both `SELECT ... FOR UPDATE` the `purchase_reports` row, serializing any two concurrent calls for the same report; the second call re-reads `status` after acquiring the lock and fails `report_not_reviewable`/`report_not_approved`.
3. `idx_points_transactions_one_purchase_reward_per_report` - a genuine partial `UNIQUE INDEX` on `points_transactions (purchase_report_id) WHERE transaction_type = 'purchase_reward'` - makes a second purchase-reward row for the same report physically impossible at the database level, independent of any application logic. Verified live: a raw, direct second `INSERT` (bypassing the RPC and its own `EXISTS` check entirely) failed with `23505 duplicate key value violates unique constraint`.

Verified live: calling `finalize_purchase_report()` twice in the same session for the same report - the second call fails with `report_not_reviewable` and the whole attempt (including the first, already-successful call) rolls back cleanly when tested inside one transaction.

### Zero-eligible-value behavior (unchanged, confirmed live - reported, not altered)

The existing system does **not** support "approved report + 0 points" - `award_purchase_points()` raises `no_eligible_amount`/`no_points_to_award` when the eligible total is `<= 0` or floors to `0` points, and because the whole `finalize_purchase_report()` call is one transaction, that exception rolls back everything (the manual-items save, the approval, all of it) - the report is left exactly as it was, still reviewable. `getFinalizeBlockingReason()` already pre-empts this client-side with the same `0.2` floor check. This is pre-existing, intentional behavior and was deliberately left unchanged.

### Already-finalized report (unchanged, confirmed via code read)

`loadDetail()` only seeds `manualRows` from OCR/manual items when `REVIEWABLE_STATUSES.includes(status)` (`submitted`/`needs_review`) - an `approved` report never reseeds from OCR. The finalize/reject actions section only renders when `isReviewable`, so neither button exists for an already-approved report. Editing an approved report ("עריכת טיפול") goes through `savePostApprovalEdit()`, which calls `save_manual_receipt_items()` directly - never `finalize_purchase_report()`/`award_purchase_points()` - so a post-approval correction can never re-trigger a second point award.

### Rejection (unchanged, confirmed live)

`review_purchase_report(p_decision = 'rejected', ...)` requires a non-blank reason, sets `status = 'rejected'`, and never touches `receipt_manual_items`, `points_transactions`, `points_balance`, or `approved_purchases_count`/`membership_level` (`recalculate_membership_level()` is only called on the `'approved'` path). Verified live in an isolated transaction: `points_awarded = 0`, `points_tx_count = 0`, profile `points_balance`/`approved_purchases_count` unchanged.

### OCR never triggers finalization (confirmed)

A repo-wide search confirms `finalize_purchase_report`/`award_purchase_points`/`review_purchase_report` are called from nowhere except `adminReportService.js`/`AdminReportDetailScreen.js` - not from `process-receipt`, not from normalization, not from matching, not from any trigger (`information_schema.triggers` on the relevant tables shows only harmless `updated_at` triggers).

### Security (confirmed live, no grants changed)

`EXECUTE` on all four RPCs is granted to `authenticated` (shared role) but each independently checks `is_admin()` first; verified live that a genuine non-admin customer session calling `finalize_purchase_report()` directly gets `not_admin` (`42501`). `authenticated` has no `UPDATE` grant on `profiles.points_balance`/`membership_level`/`approved_purchases_count`, no `INSERT`/`UPDATE` grant on `receipt_manual_items` or `points_transactions` at all, and no `UPDATE` grant on `purchase_reports` at all - every authoritative write happens only inside a `SECURITY DEFINER` function. No service-role key exists in client code.

### Files modified

- `supabase/migrations/023_finalize_requires_resolved_items.sql` (new) - the `finalize_purchase_report()` unresolved-item guard described above.
- `src/screens/AdminReportDetailScreen.js` - `getFinalizeBlockingReason()` now also blocks on an unresolved row; `getActionErrorMessage()` gained the `unresolved_items_remain` translation.
- `src/services/adminReportService.js` - corrected two stale doc comments (`awardPurchasePoints()`/`finalizePurchaseReport()`) that still described the pre-019 `is_golden_light`-based formula; no behavior change.

### Deployment

Migration 023 was applied live shortly after this stage. Its unresolved-item guard was then reversed by a Stage 5 CORRECTION - see immediately below - migration 024_allow_unresolved_finalize.sql.

### CORRECTION: unresolved rows must not block finalization (024_allow_unresolved_finalize.sql)

Business decision, reversing 023: an `unresolved` `receipt_manual_items` row must be ALLOWED to remain on a finalized report - it simply earns 0 points, exactly like a `not_golden_light` row. `023`'s `unresolved_items_remain` guard is removed via a plain `CREATE OR REPLACE` of `finalize_purchase_report()` (024) - the function is otherwise byte-for-byte identical to the live/023 version (same authorization, report lock, status check, `save_manual_receipt_items()` call, approval, membership recalculation, and `award_purchase_points()` call). `award_purchase_points()` itself was never touched by 023 or 024 - it has always filtered `match_status = 'matched'` only, so this correction changes nothing about eligibility or the points formula, only whether an unresolved row is allowed to coexist with a finalized report. Mirrored client-side: `getFinalizeBlockingReason()` no longer treats an unresolved row as blocking (only a missing quantity/price on a *matched* row, or a non-positive eligible total, still block); `getActionErrorMessage()`'s now-unreachable `unresolved_items_remain` case was removed rather than left as dead code.

**Verified live** via isolated `BEGIN ... ROLLBACK` transactions against the real database, using the task's own example (1 matched row - SKU 6003028, quantity 42, unit_price 195 - plus 3 unresolved rows): finalize succeeded, `eligible_pre_vat_amount = 8190`, `points_awarded = 1638`, and all 3 unresolved rows remained saved on the receipt uncounted. Also re-verified unchanged: a zero-matched-row receipt still fails with `no_eligible_amount` (existing behavior preserved, not altered), and a duplicate/second finalize call on an already-approved report still fails with `report_not_reviewable` with no second award - duplicate-award protection (the `for update` lock, `award_purchase_points()`'s own `exists` check, and the `idx_points_transactions_one_purchase_reward_per_report` partial unique index) lives entirely outside this function and was untouched by either 023 or 024.

**Deployment**: migration 024 has been validated live via rolled-back transactions in the same way as 023 was - see the deployment note for whether it has been applied for real by the time this is read.

### CORRECTION 2: ambiguous 504/network failure after finalize (client-side only, no migration)

Live observation: an admin's "אישור וסיום טיפול" press received an HTTP 504 from `rpc/finalize_purchase_report`, but the database showed the transaction had fully committed (`status='approved'`, `points_awarded=1638`, exactly one `points_transactions` row) - the client simply never received the response.

**Root cause, confirmed via `pg_stat_statements` (not guessed)**: `finalize_purchase_report()` calls (including everything it does internally - `save_manual_receipt_items()`, the approval update, `recalculate_membership_level()`, `award_purchase_points()`) have historically completed in under 100ms (max observed 75.57ms across all recorded calls; `statement_timeout` is 2 minutes). The SQL itself is not slow. The 504 happened above Postgres - a gateway/network-layer response-delivery failure occurring *after* the transaction had already committed, not a backend performance problem. **No database-side optimization or migration was needed** (no migration 025).

**Client fix**: `handleFinalize()` (`AdminReportDetailScreen.js`) now classifies a finalize failure using a new `FINALIZE_KNOWN_SAFE_ERRORS` set - every error `finalize_purchase_report()` can raise *before* any write that matters (`not_admin`, `report_not_found`, every `save_manual_receipt_items()`/`award_purchase_points()` validation error, `no_eligible_amount`, `no_points_to_award`). Those show their real error message immediately, exactly as before. Anything **not** in that set - `report_not_reviewable`, `points_already_awarded` (both can mean an earlier call, ours or someone else's, already finished this report), or any unrecognized error (a raw gateway timeout body, a network exception, ...) - is treated as *ambiguous*: the client reads the report back (`getAdminReportDetail(report.id)`, the same read `loadDetail()` already uses) rather than guessing.

- Read-back shows `status === 'approved'` -> treated as a real success (closes the modal, refreshes via `loadDetail()`) - never shown as a failure, never re-invokes `finalizePurchaseReport()`.
- Read-back shows the report is still reviewable/rejected -> the failure was real; the original error message is shown.
- The read-back itself fails -> a distinct "לא ניתן היה לאמת..." message is shown, with no automatic retry of either the read-back or `finalizePurchaseReport()`.

`finalizePurchaseReport()` is never called a second time anywhere in this recovery path. Loading state (`finalizing`) is cleared by the pre-existing `finally` block regardless of which branch runs - no infinite spinner. Duplicate-award protection is completely unaffected (unchanged: the `for update` lock, `award_purchase_points()`'s own `exists` check, and the `idx_points_transactions_one_purchase_reward_per_report` partial unique index) - this fix only changes what the client *shows* after an ambiguous failure, never what the database does.

## Golden Light Classification Stage 6: naming the existing three-state model, no schema change

Formalizes a classification (`golden_light` / `non_golden_light` / `unknown`) for a SAVED `receipt_manual_items` row that already existed implicitly in the schema - `match_status` (011/019) already has exactly these three states, and no code path already inspected in Stages 4-5 ever infers `not_golden_light` automatically. **No migration, no admin UI change, no points formula change** - this stage adds one small, unused-by-any-existing-screen, pure helper module that names the concept, so a future stage (reporting, a customer-facing view, ...) has one clear place to import it from instead of re-deriving the mapping ad hoc.

### Files created

- `src/utils/goldenLightClassification.js` - `GOLDEN_LIGHT_CLASSIFICATION` (`golden_light`/`non_golden_light`/`unknown`) and `classifyGoldenLight(row)`, a pure function of a row's own `match_status`/`product_id`. Not imported anywhere yet - deliberately, per this stage's own "do not redesign the admin UI" instruction.

### Existing state model (confirmed, unchanged)

- `receipt_manual_items.match_status` (`unresolved` default / `matched` / `not_golden_light`) is the sole authority. `is_golden_light` (014) has been a pure computed mirror of `match_status = 'matched'` since 019 - written by `save_manual_receipt_items()`, never read by `award_purchase_points()` or anything else that matters.
- The ONLY place client code ever sets `match_status = 'not_golden_light'` is `AdminReportDetailScreen.js`'s `markRowNotGoldenLight()`, wired to one explicit button inside the product-match modal - confirmed by grepping every occurrence of the string in the screen/service files. `buildRowsFromOcrEvidence()` (Stage 4) never seeds it; `save_manual_receipt_items()` defaults an omitted/blank value to `'unresolved'`, never to `'not_golden_light'`.
- `public.products.brand` is `not null default 'Golden Light'`, and the live catalog is 211/211 active products, all that one brand (verified live) - a `'matched'` row (which the `receipt_manual_items_matched_requires_product` CHECK guarantees always has a real `product_id`, and which `save_manual_receipt_items()` independently re-validates against `products.is_active`) is therefore already, by construction, a confirmed Golden Light product today.

### Rules

- **`golden_light`**: `match_status = 'matched'` and a real `product_id` (both already guaranteed together by the existing CHECK constraints).
- **`non_golden_light`**: `match_status = 'not_golden_light'` - only ever reached via the admin's own explicit action, never inferred.
- **`unknown`**: everything else (`match_status = 'unresolved'`, or any row that hasn't been explicitly decided) - covers an unmatched/never-matched/never-reviewed row. Absence from the catalog, a fuzzy-only candidate, or OCR text that happens to mention "Golden Light" are all explicitly `unknown`, never `non_golden_light` - verified directly (Cases B/D/E below).

### Points impact

None - `award_purchase_points()` (unchanged, not touched by this stage) already sums exactly the rows this module calls `golden_light` (`match_status = 'matched'`); `unknown`/`non_golden_light` rows already contribute 0. This module never computes, previews, or influences a point total.

### Historical/catalog-expansion behavior

`classifyGoldenLight()` is a pure function of a row's own already-saved fields - it is never cached, backfilled, or re-evaluated in bulk. A receipt finalized today with an `unknown` row stays `unknown` forever unless an admin later reopens and explicitly changes that saved row (the existing post-approval-edit flow) - a future catalog addition can only ever change classification for a **future** receipt matched fresh against the larger catalog, never retroactively for an already-saved row. No migration/backfill script was written or is needed for this.

### Security

Unchanged - classification is derived entirely from `receipt_manual_items` fields that were already validated server-side inside the existing `is_admin()`-gated `save_manual_receipt_items()`. No new grant, no new customer-writable field, no service-role key anywhere near client code.

### Test results (Cases A-G)

9 tests, all passing, run directly against the real `classifyGoldenLight()` source (Node harness, same technique as every earlier stage's pure-function tests):

- **A**: `match_status='matched'` + real `product_id` -> `golden_light`.
- **B**: `match_status='unresolved'` -> `unknown`, explicitly confirmed not `non_golden_light`.
- **C**: `match_status='not_golden_light'` -> `non_golden_light`.
- **D**: an `unresolved` row whose description literally contains "GOLDEN LIGHT" -> still `unknown` - description text is never inspected by this function.
- **E**: a fuzzy-candidate-only row (still `unresolved`, since a fuzzy match is never auto-applied) -> `unknown`.
- **F**: identical input shape classifies identically regardless of "when" a match happened - a stand-in for "today's SKU" and "a SKU only the future catalog will recognize" both resolve to `golden_light` once `matched`, proving nothing here is time/catalog-state-dependent.
- **G**: calling the function repeatedly on an unchanged (frozen) historical row never drifts - proves there is no hidden mutable state or side effect.
- Two extra defensive cases: a schema-impossible `matched` row with no `product_id`, and a `null`/`undefined` row - both resolve safely to a non-`golden_light` result without throwing.

## Product Catalog Expansion Stage 7: conflict-safe import + coverage diagnostic, no schema change

Extends the existing `public.products`/`public.product_aliases` catalog foundation (004/018) with a conflict-safe import/dry-run tool and a read-only coverage diagnostic. **No migration** - the existing schema (SKU `unique not null`, barcode nullable/deliberately non-unique, `product_aliases.normalized_alias` globally unique, no write grant for `authenticated`/`anon`) already supports everything this stage needed. OCR/normalization/matching/points/finalize/admin UI are all untouched.

### Existing catalog architecture (confirmed before changing anything)

- `products`: `id`, `sku text not null unique`, `name text not null`, `description`, `brand text not null default 'Golden Light'`, `category`, `barcode text` (nullable, deliberately **not** unique - the real source data has a genuine duplicate, `753287487971` shared by GSWITCH 412525/412575), `product_family text not null`, `is_active boolean not null default true`.
- `product_aliases`: `product_id` (FK), `alias`, `normalized_alias` (auto-set by a trigger via `normalize_catalog_text()`, `unique` **globally** - not per-product), `alias_sku`/`source_name` (reserved, unused by matching).
- Access: RLS enabled on both tables; `authenticated` has `SELECT` only (active products / aliases of an active product); **no INSERT/UPDATE/DELETE grant exists for any client role on either table** - catalog writes are reachable only through a service-role connection, confirmed live.
- Live state (verified): 211 active products, all `brand = 'Golden Light'` (single value, no exceptions), 208 with a barcode (207 distinct - the one documented duplicate pair), 0 aliases.
- `productMatcher.ts`/`productMatching.js`/`normalize_catalog_text()` were inspected, not modified - the coverage-check tool reuses `matchManualItem()`/`normalizeCatalogText()` from `productMatching.js` directly rather than reimplementing any matching rule.
- The pre-existing `supabase/scripts/import-product-catalog.mjs` already read family Excel files and validated/reported malformed rows, missing barcodes, and duplicate barcodes/SKUs - but its actual write was a **blind `upsert(payload, { onConflict: 'sku' })`**, silently overwriting an existing row's `name`/`barcode`/`product_family` on every re-import. That gap is what this stage fixes.

### Migration

None. Confirmed unnecessary: SKU uniqueness, barcode nullability/non-uniqueness, and the alias uniqueness constraint already give exactly the guarantees this stage's conflict/duplicate detection needed.

### Files created

- `supabase/scripts/check-catalog-coverage.mjs` - read-only diagnostic (see below).

### Files modified

- `supabase/scripts/import-product-catalog.mjs` - conflict-safe classification (new/unchanged/enrich/conflict) replacing the old blind upsert; added the Stage 7 canonical JSON input format (with alias support); Excel family-file reading is unchanged.
- `supabase/scripts/package.json` - added a `check-coverage` npm script alongside the existing `import-catalog` one.

### Authoritative import format

Two input forms, freely combinable in one run:
1. **Family Excel** (unchanged): `FAMILY=path/to/file.xlsx`, positional `[item_code, description, barcode]` columns, exactly as before.
2. **Canonical JSON** (new): a top-level array of objects. Required (because the schema itself requires them): `sku`, `name`, `product_family` - all as JSON **strings** (a bare JSON number for `sku` is rejected outright, since it could never preserve a leading zero). Optional: `barcode` (string or `null`), `brand` (must be exactly `"Golden Light"` if supplied at all - anything else is rejected, never silently imported), `category`, `is_active` (real boolean), `aliases` (array of non-empty strings).

### SKU conflict behavior

Every field is compared independently against the live row: source omits a field -> never touched; existing field is `null` and source supplies a value -> **enrichment** (only that field is written); existing field already has a value that **differs** from the source -> **conflict** - nothing is written for that SKU at all (not even its otherwise-safe enrichable fields), fully reported with old vs. new values. A brand-new SKU is inserted. `is_active` is excluded from this comparison entirely and is never touched on an existing row by this script - only a brand-new insert ever sets it - so deactivation remains a separate, explicit decision this tool never makes.

### Barcode ambiguity behavior

Never blocks anything. Two different SKUs sharing a barcode - whether both new, or a new/changed one colliding with an existing different product's barcode - are preserved and reported as an informational ambiguity group, exactly matching the schema's own deliberately-non-unique `barcode` column.

### Alias behavior

An alias whose normalized form doesn't exist yet -> staged for insert. Already exists for the **same** product -> duplicate, no-op. Already exists for a **different** product (live or elsewhere in the same batch) -> conflict, not inserted (the DB's own global `normalized_alias` unique constraint would reject it anyway - this is caught and reported before ever attempting the write). A product held back by its own SKU conflict has its aliases held back too, for the same run, so a flagged SKU stays one reviewable unit.

### Dry-run behavior

`--dry-run`, or simply missing credentials, previews everything with zero writes. With credentials present, dry-run **reads** the live catalog (SELECT only) to compute the full new/unchanged/enrich/conflict/alias categorization against real data; without credentials, only file-level checks (malformed rows, in-batch duplicates/conflicts, missing barcodes) are available.

### Apply behavior

Only runs with real credentials and without `--dry-run`. Inserts every `new` row, applies only the enrichable fields for every `enrich` row (a targeted `update`, never a blind upsert), inserts every planned new alias, and **skips** every `conflict` row/alias entirely - printing the exact same report either way, with a final applied/skipped summary.

### Security

Unchanged from the existing model - both scripts only ever use a service-role connection read via `process.env`, never hardcoded, never bundled into the Expo app (both live under `supabase/scripts/`, a separate `package.json` outside the app's own dependency tree). No grant was added or changed; `authenticated`/`anon` still have zero write access to `products`/`product_aliases`.

### Test results (Cases A-J)

21 tests, all passing - the classification/validation/alias-planning functions were tested directly (dependency-free pure functions, no credentials needed) using both synthetic fixtures and the exact real live row for SKU 6003028; the coverage tool was additionally validated against a real snapshot of the live 211-product catalog.

- **A**: a SKU with no existing row -> `new`, full payload, `brand` omitted (DB default applies).
- **B**: identical data against the real live `6003028` row -> `unchanged`; supplying *less* data than what's already stored is also `unchanged`, never a false conflict.
- **C**: the real live `6003028` row with a different `name` -> `conflict`, reporting existing vs. incoming; a changed `barcode` conflicts the same way.
- **D**: two different new SKUs sharing a barcode -> both kept, reported as an ambiguity group, never blocked.
- **E/F**: a brand-new alias -> staged for insert; the same alias already on the *same* product -> duplicate no-op; already on a *different* product (live or same-batch) -> conflict, not inserted.
- **G**: a blank `sku`, a bare-number `sku`, and a non-`"Golden Light"` `brand` are all rejected as invalid.
- **H**: dry-run (with or without credentials) issues zero writes - `applyChanges()` is never called.
- **I**: apply mode's plan is built from the exact same `classified`/`aliasPlan` objects dry-run reports - deterministic, no divergence between preview and apply.
- **J**: confirmed directly - none of the task's 3 real "unknown" examples resolve against a real snapshot of today's live 211-product catalog; adding a product with the *joined* SKU `90294BK` (mirroring Stage 2's own token-join algorithm exactly) makes example A `resolvable`; adding a matching alias makes example B `resolvable` too - proving future catalog growth naturally resolves more rows without touching any code path this stage didn't already exercise.

### Coverage diagnostic (`check-catalog-coverage.mjs`)

Read-only; never touches `receipt_manual_items`/`receipt_ocr_lines`/`receipt_line_matches` and has no way to - it only ever evaluates evidence explicitly supplied (the task's 3 built-in examples, or `--input=file.json`). Reuses the real `matchManualItem()`/`normalizeCatalogText()` from `productMatching.js` unmodified; mirrors (does not reimplement) Stage 2's own `tokenizeCodeText`/`generateJoinedCandidates` join algorithm from `ocrNormalization.ts` so a multi-token `ProductCode` like `"600302 8"` is tried as `"6003028"` exactly the way the live pipeline already would. For each example, reports `resolvable` (exact match, with which evidence and method), `candidate_only` (a fuzzy/ambiguous `needs_review` candidate exists, not an exact match), or `unknown` - explicitly never `non_golden_light`, matching Stage 6's own conservative rule. Live result for all 3 task examples against the current catalog: **unknown** (none resolve today), confirmed against a real snapshot of the live 211-row catalog, not a guess.

## Customer Receipt Status Flow Stage 9: unified status wording + points-balance refresh, no schema change

Polishes the existing customer-facing receipt lifecycle (`PurchaseScreen.js`, `PurchaseHistoryScreen.js`, `PurchaseReportDetailsScreen.js`) and fixes a real points-balance staleness bug on two other screens. **No migration** - `purchase_reports.status`/`points_awarded`/`rejection_reason`/timestamps already provided everything needed.

### Files modified

- `src/screens/PurchaseHistoryScreen.js` / `src/screens/PurchaseReportDetailsScreen.js` - `getStatusMeta()` in both now collapses `submitted`/`processing`/`needs_review` into one label, `בבדיקה` - previously each showed a distinct, more technical-sounding label (`נשלחה לבדיקה`/`בעיבוד`/`נדרשת בדיקה`). `PurchaseReportDetailsScreen.js` also had a `report.status === 'needs_review'` info card ("החשבונית דורשת בדיקה נוספת") shown only for that one internal status - removed, since the screen's existing generic "still pending" messaging (the products-pending card, the neutral points card, the closing notice card) already covers every pending status uniformly; the now-orphaned `infoCard`/`infoCardTitle`/`infoCardSubtitle` styles were removed with it.
- `src/screens/HomeScreen.js` / `src/screens/RewardsScreen.js` - the profile load (which carries `points_balance`) was a plain mount-only `useEffect`, unlike `ProfileScreen.js`'s own profile load which already used `useFocusEffect`. Changed both to `useFocusEffect`, matching that existing pattern exactly - a customer returning to Home or Rewards after a receipt is approved elsewhere now sees their real balance without needing to log out/in or force-quit the app. Never adds/estimates points locally - only re-fetches the same authoritative `getProfile()` call that already existed.

### Customer status mapping

`approved` -> `אושרה`; `rejected` -> `נדחתה`; everything else (`submitted`/`processing`/`needs_review`) -> `בבדיקה`. No technical word (OCR/processing/review/normalization/matching) ever appears in a customer-facing label - verified directly (14 tests, see below).

### Upload-success UX

Already correct, unchanged - `PurchaseScreen.js` shows "החשבונית נשלחה לבדיקה" plus "נעדכן אתכם כשהנקודות יתווספו לחשבון" immediately after a successful upload, without waiting for OCR (`submitPurchaseReceipt()` dispatches OCR fire-and-forget - confirmed by re-reading `purchaseReportService.js`).

### Receipt-history UX

Already correct, unchanged - each row already shows a thumbnail, filename, submission date, the (now-unified) status badge, and awarded points when approved. Already properly guarded against a long filename overflowing (`numberOfLines`/`minWidth: 0`/`flexShrink`).

### Approved-points presentation

Unchanged, already correct - shows the stored `purchase_reports.points_awarded` directly (`getPurchaseReportById()` selects it explicitly; never recomputed from manual items/invoice rows client-side) with a clear "נוספו לחשבון" confirmation, only when `points_awarded > 0`.

### Rejection presentation

Unchanged, already correct - shows `אופס... הפעם לא הצלחנו לאשר את החשבونית` plus the admin's own `rejection_reason` text verbatim (never a raw DB/RPC error code), and never implies points were awarded (the points section is hidden entirely for a rejected report).

### Refresh/focus behavior

Both `PurchaseHistoryScreen.js` and `PurchaseReportDetailsScreen.js` already used `useFocusEffect` for their report data - re-confirmed, unchanged. The real gap was the points BALANCE specifically (see Files modified above) - now fixed to match.

### Security/RLS verification - a real gap found, no migration created

Row-level RLS is correct everywhere checked: a customer's `purchase_reports`/`receipt_manual_items`/`receipt_ocr_results`/`receipt_ocr_lines`/`receipt_line_matches` policies all scope strictly to `pr.user_id = auth.uid()` - confirmed live that requesting another customer's report resolves to "not found," never a distinguishable "exists but denied."

**Column-level grants are wider than the app's own UI uses**, confirmed live by simulating real customer sessions (not just reading grant metadata):
- `purchase_reports` has had a **whole-table** `grant select ... to authenticated` since its original migration (002) - includes `reviewed_by` (the reviewing admin's internal user id) and `admin_note` (a vestigial column, never written by any RPC, always null today, but a latent risk if ever populated later). Live-simulated as the real owning customer: `select *` on their own (real, rejected) report returns `reviewed_by`'s actual admin UUID today, via the app's own existing `getMyPurchaseReports()`.
- `receipt_ocr_results`/`receipt_ocr_lines` grant `authenticated` every column, including `raw_text`, `raw_item`, every `*_confidence` column, and every Stage-2 `normalized_*`/`normalization_notes`/`normalization_status` column - live-simulated as the real owning customer: a direct select on their own report's real OCR line returned the full raw text, confidence scores, and internal normalization/cross-evidence JSON. No current customer screen queries these tables, but the grant permits it.
- `receipt_line_matches` grants `product_id`/`match_status`/`match_method`/`confidence`/`matched_text`. `receipt_manual_items` grants `product_id`/`match_status`/`match_type`/`match_confidence`/`is_golden_light`/`created_by` - the app's own `getReceiptManualItems()` deliberately selects only `id, description, sku, quantity, unit_price, line_total`, but the wider grant is still directly reachable.

None of this is reachable cross-user, and no current screen renders any of it - but it directly contradicts this codebase's own established principle elsewhere (e.g. `receipt_manual_items.created_by`'s column grant IS already correctly narrowed specifically to avoid exposing internal admin identity - the same reasoning was apparently never applied to `reviewed_by`/the raw OCR tables). Per this stage's own explicit instruction, no migration was created - this is reported for a decision, not applied. A narrowly-scoped fix would be a set of `revoke select (...)` statements matching exactly the columns each customer-facing function already uses (`purchase_reports`: `id, user_id, receipt_path, original_filename, status, points_awarded, rejection_reason, created_at, updated_at` - already exactly `getPurchaseReportById()`'s own select list; `receipt_ocr_results`/`receipt_ocr_lines`: revoke all customer access, since no customer screen queries them today; `receipt_line_matches`/`receipt_manual_items`: narrow to what's actually used, or revoke customer access to the match-internal columns specifically).

### Test results

14 tests (pure-function, run directly against the real `getStatusMeta()` in both files), all passing: submitted/processing/needs_review verified to map to the identical `בבדיקה` label; approved/rejected verified distinct; every label verified free of technical wording (OCR/עיבוד/זיהוי/נורמל/התאמה/"בדיקה נוספת"). All 53 pre-existing cross-stage tests re-run and still passing - zero regression to OCR/matching/points/finalize/classification logic, none of which was touched this stage.

## Notes

- Email is still managed by Supabase Auth and is not duplicated in profiles.
- The schema now includes an OCR data foundation (receipt_ocr_results, receipt_ocr_lines), a product matching foundation (receipt_line_matches), a real product catalog foundation (products.barcode/product_family, product_aliases.alias_sku/source_name, supabase/scripts/import-product-catalog.mjs), deterministic manual-item product matching with a unified inline suggestion UX (receipt_manual_items.product_id/match_type/match_confidence/match_status, src/services/productMatching.js's getProductSuggestions()/matchManualItem() - see "Product matching foundation (Stage 2)" and "Product matching UX (Stage 3)" above), deterministic OCR-line product matching wired into the live process-receipt pipeline (receipt_line_matches, productMatcher.ts's matchOcrLineFromEvidence() - see "OCR Product Matching Stage 3" near the end of this document), a points-awarding foundation (points_transactions, finalize_purchase_report - eligibility reads match_status, not is_golden_light directly, though the two can never disagree), and automatic G Level progression (recalculate_membership_level), but still does not include reward redemption, point reversal/adjustment, or wholesaler/source detection. OCR provider integration now exists (Azure Document Intelligence, prebuilt-invoice), followed by a normalization/row-recovery pass - see "OCR Integration Stage 1" and "OCR Integration Stage 2" below.
- The normal admin review flow is now a single unified action ("אישור וסיום טיפול" - see "Unified one-click review workflow" above); the older separate save/approve/award-points steps described earlier in this document no longer reflect the app's actual UI, though every RPC they relied on still exists in the database exactly as documented (nothing was dropped).
- The admin manual-entry form no longer collects `sku`/`line_total` (see "Simplified admin manual-entry fields" above); both columns remain in `receipt_manual_items` for any historical row and for possible future OCR use, but eligibility is now calculated purely from `quantity * unit_price`.
- The process-receipt Edge Function (supabase/functions/process-receipt) is deployed to the live Supabase project and is invoked automatically from the client after a successful receipt upload (src/services/purchaseReportService.js's submitPurchaseReceipt(), fire-and-forget - see that file's own comments). See "OCR Integration Stage 1" and "OCR Integration Stage 2" below for what it does today.
- Migration 007_create_product_matching.sql has been run; `public.receipt_line_matches` exists. The real Golden Light catalog has not been imported into the live database yet (see "Product catalog foundation (Stage 1)" above - the migration and import script exist, but neither has been run against the live project), so live matching still currently resolves every line to `unmatched`.
- `productMatcher.ts`/`productMatchPersistence.ts` (deterministic OCR-line product matching) exist but are deliberately NOT called from `process-receipt/index.ts` - see "OCR Integration Stage 1"'s "Product matching is deliberately not invoked yet" above. An earlier version of this note said matching was wired in after OCR persistence; that call site was removed as part of OCR Integration Stage 1, before real OCR output could ever reach it, and remains removed through OCR Integration Stage 2.
- The admin receipt-review screen (AdminReportDetailScreen.js) now prefills its existing manual-item rows from OCR/normalization/matching evidence when a report has no saved receipt_manual_items yet - see "OCR Admin Review Integration Stage 4" above. Once the admin saves, receipt_manual_items becomes authoritative for that report and OCR is never consulted again; no approval or points are ever triggered by OCR/matching alone.
- finalize_purchase_report() now additionally requires every saved receipt_manual_items row for the report to be resolved (match_status matched or not_golden_light, never the default unresolved) before it will approve the report and award points - see "Admin Finalization & Points Safety Stage 5" above (migration 023). Everything else about the finalization/points pipeline (the points formula, duplicate-award protection, atomicity, rejection, security) was verified against the live database and found already correct - nothing else changed.
- AdminReportDetailScreen.handleFinalize() no longer treats an ambiguous finalize failure (an unrecognized error, or report_not_reviewable/points_already_awarded) as a definite failure - it reads the report back and only shows an error if the read-back confirms the report is genuinely still unfinalized. This was added after a live HTTP 504 was observed on rpc/finalize_purchase_report while the transaction had actually committed successfully - see "CORRECTION 2: ambiguous 504/network failure after finalize" above. No database change was needed; finalize_purchase_report() itself was already consistently fast (confirmed via pg_stat_statements).
- src/utils/goldenLightClassification.js names the golden_light/non_golden_light/unknown classification that already existed implicitly in receipt_manual_items.match_status - see "Golden Light Classification Stage 6" above. No new state, no migration, not wired into any screen yet; is_golden_light remains a pure computed mirror of match_status = matched, unchanged since migration 019.
- supabase/scripts/import-product-catalog.mjs now does conflict-safe classification (new/unchanged/enrich/conflict) against the live catalog instead of a blind upsert, and supports a canonical JSON input format with aliases - see "Product Catalog Expansion Stage 7" above. supabase/scripts/check-catalog-coverage.mjs is a new read-only diagnostic for whether the current catalog would resolve a given OCR example, reusing the real matchManualItem() matcher unmodified. No schema/migration change; no admin UI change.
- AdminReportDetailScreen.js received a Stage 8 UI/UX polish pass - no OCR/normalization/matching/classification/points/finalize business logic changed. Row-level controls (inputs, product-match button, delete/add-row) now visibly dim while a save/finalize request is in flight (previously disabled with no visual change) and carry explicit, row-indexed accessibilityLabel values; the points-awarded card's eligible-amount now formats with the same two-decimal convention as every other currency display on the screen; the header row's customer name truncates instead of risking pushing the status badge off a narrow viewport; rejection failures are now dev-logged the same way finalize/award-points failures already were. Confirmed via code audit (an automated unused-style/unused-function scan found none): the OCR status card stays fully removed, no raw OCR/normalization internals are ever rendered, and no dead code remained to clean up.
- SECURITY FINDING (Stage 9, not yet fixed - awaiting a decision, no migration created): purchase_reports/receipt_ocr_results/receipt_ocr_lines/receipt_line_matches/receipt_manual_items all grant authenticated customers more COLUMNS than the app itself ever queries - confirmed live by simulating a real customer session, not just reading grant metadata. RLS row-scoping is correct (own data only, verified), but a customer can currently fetch their own reviewed_by admin id and their own raw OCR text/confidence/normalization internals directly, entirely outside the app UI. See "Customer Receipt Status Flow Stage 9" above for the exact columns and a proposed narrow-grant fix.
