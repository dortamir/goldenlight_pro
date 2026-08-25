// Golden Light Classification - Stage 6.
//
// Formalizes, as a small pure helper, a classification that already exists
// implicitly in the schema: whether a SAVED receipt_manual_items row (the
// admin's own reviewed/finalized state, never a raw OCR/matching
// suggestion) represents a confirmed Golden Light product, a confirmed
// non-Golden-Light product, or neither yet.
//
// This is deliberately NOT a new state, NOT a new column, and NOT a new
// admin control - receipt_manual_items.match_status (011_receipt_manual_
// items.sql, extended by 019_product_matching_manual_items.sql) already has
// exactly the three states this classification needs:
//
//   match_status = 'matched'          (+ a real product_id, guaranteed by
//                                       receipt_manual_items_matched_
//                                       requires_product)  -> golden_light
//   match_status = 'not_golden_light'                      -> non_golden_light
//   match_status = 'unresolved' (the default)               -> unknown
//
// CONSERVATIVE BY CONSTRUCTION: 'not_golden_light' is never inferred by any
// existing code path - the ONLY place that ever sets it is
// AdminReportDetailScreen.js's markRowNotGoldenLight(), wired to one
// explicit admin button inside the product-match modal (confirmed by
// reading every call site). A row that failed to match, was never matched,
// or simply hasn't been looked at yet always stays 'unresolved' -
// buildRowsFromOcrEvidence() (Stage 4) never seeds 'not_golden_light' from
// OCR/matching evidence, and save_manual_receipt_items() defaults an
// unspecified/omitted match_status to 'unresolved', never to
// 'not_golden_light'. This module does not change or duplicate any of that
// - it only names the three states that already exist.
//
// WHY "matched" ALREADY MEANS "Golden Light", NOT JUST "some product":
// public.products.brand is `not null default 'Golden Light'`
// (004_create_product_catalog.sql), and every row in the live catalog is
// that brand (verified live - 211/211 active products, single brand
// value). save_manual_receipt_items() also independently re-validates that
// a 'matched' row's product_id references a real, active products row
// before ever accepting the save (`not exists (select 1 from products
// where id = v_product_id and is_active = true)` -> invalid_product). A
// 'matched' row is therefore, by construction, always a confirmed Golden
// Light product today - no separate brand lookup is available (or needed)
// through the existing get_admin_manual_items()/receipt_manual_items
// columns to double-check it. If the catalog ever legitimately grows to
// include a non-Golden-Light brand, this assumption - and the queries that
// rely on it (award_purchase_points() itself included) - would need to be
// revisited together; that is explicitly out of scope for this stage.
//
// is_golden_light (added in 014_automatic_points_eligibility.sql) is NOT a
// second source of truth - since 019_product_matching_manual_items.sql it
// has been a pure computed mirror of `match_status = 'matched'`, written
// only by save_manual_receipt_items() and never read by any points logic.
// This module reads match_status directly for the same reason
// award_purchase_points() does, and never reads/writes is_golden_light.
//
// POINTS ARE UNCHANGED BY THIS MODULE: award_purchase_points() (Postgres)
// remains the ONLY authoritative source of eligible points, and it already
// sums exactly the rows this module calls GOLDEN_LIGHT (match_status =
// 'matched') - nothing here recomputes, previews, or influences that sum.
// UNKNOWN and NON_GOLDEN_LIGHT rows already contribute 0 points today,
// with no change required.
//
// CATALOG EXPANSION SAFETY: classification is computed fresh from each
// row's OWN saved match_status/product_id every time this function is
// called - never cached, never backfilled, never written anywhere. A
// receipt finalized today with an UNKNOWN row stays UNKNOWN in this
// module's output forever (its saved match_status never changes on its
// own), even after the catalog later gains a matching SKU - exactly the
// existing "OCR is only ever the initial seed, receipt_manual_items is
// authoritative once saved" rule already established in Stage 4. Only a
// FUTURE receipt, matched fresh against the larger catalog at review time,
// can ever become GOLDEN_LIGHT for that SKU.

export const GOLDEN_LIGHT_CLASSIFICATION = Object.freeze({
  GOLDEN_LIGHT: 'golden_light',
  NON_GOLDEN_LIGHT: 'non_golden_light',
  UNKNOWN: 'unknown',
});

// `row` is any object carrying a saved receipt_manual_items row's
// match_status/product_id - the exact shape both buildRowsFromManualItems()
// (AdminReportDetailScreen.js, live editable rows) and
// get_admin_manual_items()'s own return rows already have. Never call this
// with a receipt_line_matches/receipt_ocr_lines row - those are Stage 3's
// OWN, differently-named three-state model
// ('unmatched'/'matched'/'needs_review'), not this one; feeding one into
// the other would silently misclassify every 'needs_review' OCR line as
// UNKNOWN-shaped input with an unrecognized match_status value, which
// happens to still resolve to UNKNOWN here but is not the intent.
export function classifyGoldenLight(row) {
  if (row && row.match_status === 'matched' && row.product_id) {
    return GOLDEN_LIGHT_CLASSIFICATION.GOLDEN_LIGHT;
  }
  if (row && row.match_status === 'not_golden_light') {
    return GOLDEN_LIGHT_CLASSIFICATION.NON_GOLDEN_LIGHT;
  }
  return GOLDEN_LIGHT_CLASSIFICATION.UNKNOWN;
}