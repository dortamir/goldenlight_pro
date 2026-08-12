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

## Notes

- Email is still managed by Supabase Auth and is not duplicated in profiles.
- The schema now includes an OCR data foundation (receipt_ocr_results, receipt_ocr_lines) and a product matching foundation (receipt_line_matches) in addition to the catalog foundation, but still does not include points rules or admin management flows.
- The process-receipt Edge Function (supabase/functions/process-receipt) exists as source-controlled code only. It has not been deployed and is not yet called from the app.
- Migration 007_create_product_matching.sql has been run; `public.receipt_line_matches` exists. No real Golden Light product/alias data has been imported, so live matching currently resolves every line to `unmatched`.
- Deterministic product matching (`productMatcher.ts`/`productMatchPersistence.ts`) is now called from `process-receipt/index.ts` after OCR persistence. This does not change today's observed behavior, since the function's success path is still unreachable without a configured OCR provider - see "Product matching foundation" above for the full integration and failure-isolation details.
