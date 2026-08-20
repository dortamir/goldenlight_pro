-- Product Catalog Stage 1: Golden Light product catalog + alias foundation.
--
-- Adapts the EXISTING public.products / public.product_aliases tables
-- (004_create_product_catalog.sql) rather than creating new ones - both
-- were created early in this project as an empty foundation (no product
-- data has ever been inserted - confirmed by inspecting every migration
-- and this file's own running notes before writing this one), and are
-- already referenced by receipt_line_matches.product_id (007) and by the
-- deterministic matching pipeline (productMatcher.ts/
-- productMatchPersistence.ts), both of which read `sku`/`name`/`is_active`
-- from products and `alias`/`normalized_alias` from product_aliases. None
-- of those column names change here, so nothing in the matching pipeline
-- needs to change (and nothing here changes matching BEHAVIOR at all -
-- this migration only adds columns; automatic matching is a later stage).
--
-- `sku` already IS the "item_code" business identifier this stage asks
-- for (`not null unique`) and `name` already IS the required product
-- description field - both keep their existing names rather than being
-- renamed, to avoid rippling a purely cosmetic rename through the
-- matching pipeline (TypeScript interfaces + Supabase select lists) for
-- no functional benefit. Two genuinely new fields are added below:
-- `barcode` (nullable, intentionally NOT uniquely constrained) and
-- `product_family` (not null, free text, no enum).

-- ------------------------------------------------------------------------
-- barcode: nullable - real source data has products with no barcode at
-- all (e.g. GSWITCH 40071/40072/40073), and those must still import
-- successfully. Deliberately NOT unique - the real source data also has a
-- genuine duplicate barcode (753287487971, shared by two distinct GSWITCH
-- products, 412525 and 412575) that must not block import. Indexed
-- (non-unique) for future lookup performance once matching priority 1
-- ("barcode exact") is implemented - not implemented in this stage.
alter table public.products
  add column if not exists barcode text;

create index if not exists idx_products_barcode
  on public.products (barcode);

-- ------------------------------------------------------------------------
-- product_family: added nullable first, backfilled, then set NOT NULL -
-- the standard safe pattern for adding a required column regardless of
-- whether any row already exists (none do today). Deliberately free text,
-- not an enum/check-constrained set of values - GBOX/GSWITCH/GTECH are
-- today's real values (see supabase/scripts/import-product-catalog.mjs),
-- but more families are expected later and must never require a schema
-- migration to add.
alter table public.products
  add column if not exists product_family text;

update public.products
  set product_family = 'UNKNOWN'
  where product_family is null;

alter table public.products
  alter column product_family set not null;

alter table public.products
  add constraint products_product_family_not_blank
  check (length(btrim(product_family)) > 0);

-- ------------------------------------------------------------------------
-- Deliberately NOT added: normalized_item_code / normalized_description
-- columns on products. The existing matcher (productMatcher.ts) already
-- normalizes `sku`/`name` in memory at match time via
-- normalizeCatalogText() (mirroring public.normalize_catalog_text()
-- exactly) - it never reads a stored normalized column. Adding one here
-- would be unused dead weight with no consumer, and would risk drifting
-- out of sync with the real sku/name if a future catalog update forgot to
-- refresh it. If a genuine query-time need for a stored normalized column
-- emerges later (e.g. an indexed exact-normalized lookup instead of an
-- in-memory scan), it should be added then, together with the trigger
-- that would keep it correct - not speculatively now, per this stage's
-- explicit "do not rewrite matching behavior" scope.

-- ------------------------------------------------------------------------
-- product_aliases: two new nullable columns for future alias types this
-- stage does NOT populate (no fake/sample aliases are inserted anywhere
-- in this migration). `alias`/`normalized_alias`/`product_id`/`created_at`
-- are left completely unchanged (still `not null`/`unique` on
-- normalized_alias) - the matching pipeline's CatalogAlias type and
-- productMatchPersistence.ts's select list read exactly `product_id,
-- alias, normalized_alias` today and continue to work unmodified.
--
-- Making `alias` itself nullable (to support a genuine "SKU-only alias,
-- no free-text name" row, as hinted at by this stage's suggested
-- alias_text/alias_sku field pair) is deliberately deferred, not done
-- here: normalize_catalog_text(null) collapses to an empty string, and
-- the existing `normalized_alias` unique constraint would then only ever
-- allow ONE such row across the whole table before colliding - correctly
-- supporting a null alias requires also revisiting
-- set_normalized_alias()/that unique constraint (e.g. a partial unique
-- index), which is real matching-infrastructure work out of scope for
-- this foundation-only stage. `alias_sku`/`source_name` are safe to add
-- now regardless, since they impose no new constraint and nothing reads
-- them yet.
alter table public.product_aliases
  add column if not exists alias_sku text;

alter table public.product_aliases
  add column if not exists source_name text;

-- ------------------------------------------------------------------------
-- Access model: UNCHANGED from 004_create_product_catalog.sql - no grant
-- or policy is added, dropped, or modified by this migration. Re-affirmed
-- here for clarity, not re-created:
--   - RLS is enabled on both tables.
--   - `authenticated` has SELECT only - active products, and aliases
--     belonging to an active product (see the two policies in 004).
--   - No INSERT/UPDATE/DELETE grant exists for `authenticated` at all, on
--     either table. Catalog writes are reachable only through a trusted
--     service-role connection (see
--     supabase/scripts/import-product-catalog.mjs), never through the
--     mobile app's anon/authenticated Supabase client - the service-role
--     key never ships in the app and is never used by any client code.
--   - `anon` has no access to either table.
-- Newly added columns (barcode, product_family, alias_sku, source_name)
-- are covered by the existing whole-table SELECT grant automatically -
-- none of them are sensitive/internal-only (unlike e.g.
-- receipt_manual_items.created_by elsewhere in this schema), so no
-- column-level revoke is needed for any of them.
