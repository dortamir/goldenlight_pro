import { supabase } from './supabase';

// Admin-only read services for purchase reports. Deliberately separate from
// purchaseReportService.js: that module's queries are written for the
// customer's own data (implicitly scoped by the customer RLS policy, and in
// getPurchaseReportById's case explicitly filtered by userId too) - reusing
// it here would blur that boundary. Every query below instead relies on the
// admin-only RLS policies added in
// supabase/migrations/009_admin_read_access.sql (public.is_admin()), which
// only ever admit rows when the CALLING user is a real admin_users member -
// this module has no special client-side privilege of its own and cannot
// read anything a non-admin session's Supabase client couldn't already be
// denied at the database level.
//
// Read-only: nothing here inserts, updates, or deletes any row. Approval/
// rejection/points/admin-note writes are a later, separate stage.

// Reports currently waiting for admin attention. At this stage of the
// project there is no automated OCR/processing pipeline moving a report
// from submitted -> processing -> approved/needs_review, so a freshly
// submitted receipt has no other way to ever be looked at - it must stay in
// the admin workflow exactly like a needs_review one, not just the reports
// a (not-yet-existing) automated pass has specifically flagged. Once that
// pipeline exists, 'submitted' may naturally drain into 'processing' on its
// own and this list can be revisited - not before.
const REVIEW_QUEUE_STATUSES = ['submitted', 'needs_review'];

async function fetchProfileNamesByIds(userIds) {
  if (!userIds || userIds.length === 0) {
    return new Map();
  }

  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name')
    .in('id', userIds);

  if (error) {
    throw error;
  }

  return new Map((data || []).map((profile) => [profile.id, profile.full_name]));
}

// The admin's ONLY read path for receipt_manual_items as of migration 014:
// is_golden_light is deliberately unreadable via a plain
// `.from('receipt_manual_items').select(...)` (its column-level SELECT
// grant was revoked from `authenticated` entirely, the same treatment as
// created_by), so the admin reads through this SECURITY DEFINER RPC
// instead, which re-checks public.is_admin() itself and returns every
// column including is_golden_light.
async function fetchManualItems(reportId) {
  const { data, error } = await supabase.rpc('get_admin_manual_items', { p_report_id: reportId });

  if (error) {
    throw error;
  }

  return data || [];
}

// The existing 'purchase_reward' points_transactions row for a report, if
// any has been awarded yet - never eligible_pre_vat_amount-derived
// on-the-fly, just whatever the secure RPC actually recorded.
async function fetchPurchaseRewardTransaction(reportId) {
  const { data, error } = await supabase
    .from('points_transactions')
    .select('id, points, eligible_pre_vat_amount, created_at')
    .eq('purchase_report_id', reportId)
    .eq('transaction_type', 'purchase_reward')
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

// Real counts only - no revenue/points/user-growth metrics, since nothing in
// the current schema supports those meaningfully yet. `processing` is a
// real, unchanged backend status (see purchase_reports.status and the
// process-receipt Edge Function foundation), but it isn't part of the
// current admin-facing presentation - the dashboard only surfaces the three
// operational categories an admin actually acts on: pending (submitted +
// needs_review), approved, and rejected.
export async function getAdminDashboardSummary() {
  if (!supabase) {
    throw new Error('Admin data is not available.');
  }

  const [pending, approved, rejected] = await Promise.all([
    supabase
      .from('purchase_reports')
      .select('id', { count: 'exact', head: true })
      .in('status', REVIEW_QUEUE_STATUSES),
    supabase.from('purchase_reports').select('id', { count: 'exact', head: true }).eq('status', 'approved'),
    supabase.from('purchase_reports').select('id', { count: 'exact', head: true }).eq('status', 'rejected'),
  ]);

  if (pending.error) {
    throw pending.error;
  }
  if (approved.error) {
    throw approved.error;
  }
  if (rejected.error) {
    throw rejected.error;
  }

  return {
    // "ממתינות לבדיקה" - everything currently waiting for admin attention
    // (submitted + needs_review), see REVIEW_QUEUE_STATUSES above.
    pendingCount: pending.count ?? 0,
    approvedCount: approved.count ?? 0,
    rejectedCount: rejected.count ?? 0,
  };
}

// The primary review queue: every report currently waiting for admin
// attention (submitted + needs_review - see REVIEW_QUEUE_STATUSES above),
// oldest first so a neglected receipt naturally rises to the top rather than
// getting buried under newer submissions.
export async function getAdminReviewQueue() {
  if (!supabase) {
    return [];
  }

  const { data: reports, error } = await supabase
    .from('purchase_reports')
    .select('id, user_id, receipt_path, original_filename, status, points_awarded, created_at')
    .in('status', REVIEW_QUEUE_STATUSES)
    .order('created_at', { ascending: true });

  if (error) {
    throw error;
  }

  if (!reports || reports.length === 0) {
    return [];
  }

  const nameById = await fetchProfileNamesByIds([...new Set(reports.map((report) => report.user_id))]);

  return reports.map((report) => ({
    ...report,
    customerName: nameById.get(report.user_id) || null,
  }));
}

// Every purchase report regardless of status (submitted, processing,
// needs_review, approved, rejected), for the admin history/all-receipts
// view - deliberately NOT filtered by REVIEW_QUEUE_STATUSES, unlike
// getAdminReviewQueue() above. Newest first, so a just-submitted or
// just-decided receipt appears at the top. Status filtering for the "הכל /
// ממתינות לבדיקה / אושרו / נדחו" UI filters happens client-side in
// AdminReportsHistoryScreen against this same full list - there is no
// separate query per filter. A 'processing' report is still included in
// this full list (and reachable via "הכל") even though no current filter
// pill isolates it on its own - that status simply isn't part of today's
// admin-facing filter set.
export async function getAdminReports() {
  if (!supabase) {
    return [];
  }

  const { data: reports, error } = await supabase
    .from('purchase_reports')
    .select('id, user_id, receipt_path, original_filename, status, points_awarded, created_at')
    .order('created_at', { ascending: false });

  if (error) {
    throw error;
  }

  if (!reports || reports.length === 0) {
    return [];
  }

  const nameById = await fetchProfileNamesByIds([...new Set(reports.map((report) => report.user_id))]);

  return reports.map((report) => ({
    ...report,
    customerName: nameById.get(report.user_id) || null,
  }));
}

// Full read-only detail for one report: the report row, its owner's name,
// and - only if they actually exist - its OCR result/lines and per-line
// match results. No product/points/approval data is fabricated when these
// don't exist yet; callers should treat missing OCR/match data as a neutral
// pending state, not an error.
export async function getAdminReportDetail(reportId) {
  if (!supabase || !reportId) {
    return null;
  }

  const { data: report, error: reportError } = await supabase
    .from('purchase_reports')
    .select(
      'id, user_id, receipt_path, original_filename, status, points_awarded, reviewed_at, rejection_reason, created_at, updated_at',
    )
    .eq('id', reportId)
    .maybeSingle();

  if (reportError) {
    throw reportError;
  }

  if (!report) {
    return null;
  }

  const nameById = await fetchProfileNamesByIds([report.user_id]);

  const { data: ocrResult, error: ocrError } = await supabase
    .from('receipt_ocr_results')
    .select('id, status, provider, raw_text, processed_at')
    .eq('purchase_report_id', reportId)
    .maybeSingle();

  if (ocrError) {
    throw ocrError;
  }

  // Deliberately isolated in its own try/catch, same reasoning as
  // manualItems/pointsAward below: OCR/matching data is a convenience the
  // admin review form (Stage 4 - see AdminReportDetailScreen's
  // buildRowsFromOcrEvidence) uses to prefill from when no manual items
  // exist yet, never a hard requirement for the rest of this screen to
  // render. A failure here must not block the receipt image/approve-
  // reject actions, and must not regress the existing manual-entry
  // workflow for a report with missing/failed OCR.
  let ocrLines = [];
  let lineMatches = [];

  try {
    if (ocrResult) {
      // receipt_ocr_lines' Stage 1 (product_code/*_confidence) and Stage 2
      // (normalized_product_code/normalized_quantity/normalized_unit_price/
      // normalized_total/normalization_status/normalization_notes/
      // source_ocr_line_id/is_recovered_row) columns are deliberately
      // excluded from the plain customer/admin-shared column grant (see
      // 021_ocr_azure_document_intelligence.sql/022_ocr_normalization.sql)
      // - read them through this SECURITY DEFINER RPC instead, the same
      // pattern already used for receipt_manual_items/
      // get_admin_manual_items. A plain `.from('receipt_ocr_lines').select(...)`
      // here would silently come back without any of the Stage 2
      // normalized fields Stage 4's prefill needs.
      const { data: lines, error: linesError } = await supabase.rpc('get_admin_ocr_lines', {
        p_report_id: reportId,
      });

      if (linesError) {
        throw linesError;
      }

      ocrLines = lines || [];

      if (ocrLines.length > 0) {
        // product_id is included here (unlike before) - it's already part
        // of receipt_line_matches' existing column-level grant
        // (007_create_product_matching.sql), just not previously selected
        // by this query. Needed so a 'matched' OCR line can be prefilled
        // with an authoritative product, not just its status label.
        const { data: matches, error: matchesError } = await supabase
          .from('receipt_line_matches')
          .select('id, ocr_line_id, product_id, match_status, match_method, confidence, matched_text')
          .in('ocr_line_id', ocrLines.map((line) => line.id));

        if (matchesError) {
          throw matchesError;
        }

        lineMatches = matches || [];

        // One small, targeted lookup for the matched products' own
        // sku/name - never the full ~211-row catalog, never a per-row
        // query. Enriches each matched row in place so the admin review
        // form can show/prefill the official product identity (Stage 4's
        // "green matched state + official SKU/product identity")
        // directly, without a separate round trip per row.
        const matchedProductIds = [
          ...new Set(lineMatches.filter((match) => match.product_id).map((match) => match.product_id)),
        ];

        if (matchedProductIds.length > 0) {
          const { data: matchedProducts, error: productsError } = await supabase
            .from('products')
            .select('id, sku, name')
            .in('id', matchedProductIds);

          if (productsError) {
            throw productsError;
          }

          const productById = new Map((matchedProducts || []).map((product) => [product.id, product]));
          lineMatches = lineMatches.map((match) => {
            const product = match.product_id ? productById.get(match.product_id) : null;
            return {
              ...match,
              matched_product_sku: product?.sku || null,
              matched_product_name: product?.name || null,
            };
          });
        }
      }
    }
  } catch (err) {
    if (__DEV__) {
      console.warn('[Admin] Failed to load OCR/matching data', { code: err?.code, message: err?.message });
    }
    ocrLines = [];
    lineMatches = [];
  }

  // Deliberately isolated in its own try/catch, unlike the reads above: the
  // manual-items table/RPC is a separate, secondary part of this screen
  // (see AdminReportDetailScreen's manual-entry section), and any failure
  // here (e.g. the underlying migration missing) must never take down the
  // rest of an otherwise-working report load - the receipt image, OCR
  // section, and approve/reject actions all have to keep rendering
  // regardless. On failure this resolves to an empty list instead of
  // rejecting the whole getAdminReportDetail() call.
  let manualItems = [];
  try {
    manualItems = await fetchManualItems(reportId);
  } catch (err) {
    if (__DEV__) {
      console.warn('[Admin] Failed to load manual receipt items', { code: err?.code, message: err?.message });
    }
  }

  // Same isolation reasoning as manualItems above - whether points have
  // already been awarded is secondary to the rest of this screen; a
  // failure here must not block the receipt image/OCR/approve-reject
  // sections from rendering.
  let pointsAward = null;
  try {
    pointsAward = await fetchPurchaseRewardTransaction(reportId);
  } catch (err) {
    if (__DEV__) {
      console.warn('[Admin] Failed to load points award state', { code: err?.code, message: err?.message });
    }
  }

  return {
    ...report,
    customerName: nameById.get(report.user_id) || null,
    ocrResult: ocrResult || null,
    ocrLines,
    lineMatches,
    manualItems,
    pointsAward,
  };
}

// Standalone read, exported separately for callers that only need the
// manual-item set (getAdminReportDetail already includes it for the report
// detail screen's normal load/refresh path).
export async function getAdminManualItems(reportId) {
  if (!supabase || !reportId) {
    return [];
  }

  return fetchManualItems(reportId);
}

// Loads the active Golden Light catalog (products + their aliases) for
// CLIENT-SIDE product matching - see src/services/productMatching.js. This
// is a plain `.from(...).select(...)` read, not a new RPC: public.products/
// public.product_aliases already grant plain SELECT to `authenticated` for
// active rows (004_create_product_catalog.sql), the exact same read path
// the admin's own Supabase session already has for any other screen. There
// is no service-role key involved and no elevated privilege here - only
// WRITING a match (via saveAdminManualItems/finalizePurchaseReport, both
// already is_admin()-gated) is privileged.
//
// Intended to be called ONCE per report-review session (see
// AdminReportDetailScreen's load effect) and reused for every row's
// matching/search, rather than re-queried per row - this is what keeps
// matching a single one-time read plus in-memory JS work, with no N+1
// query pattern, even as the catalog grows well past its current ~211 rows.
export async function loadCatalogForMatching() {
  if (!supabase) {
    return { products: [], aliases: [] };
  }

  const { data: productRows, error: productsError } = await supabase
    .from('products')
    .select('id, sku, name, barcode, product_family, is_active')
    .eq('is_active', true);

  if (productsError) {
    throw productsError;
  }

  const products = (productRows || []).map((row) => ({
    id: row.id,
    sku: row.sku,
    name: row.name,
    barcode: row.barcode,
    productFamily: row.product_family,
    isActive: Boolean(row.is_active),
  }));

  if (products.length === 0) {
    return { products: [], aliases: [] };
  }

  const productIds = products.map((product) => product.id);

  const { data: aliasRows, error: aliasesError } = await supabase
    .from('product_aliases')
    .select('product_id, alias, normalized_alias')
    .in('product_id', productIds);

  if (aliasesError) {
    throw aliasesError;
  }

  const aliases = (aliasRows || []).map((row) => ({
    productId: row.product_id,
    alias: row.alias,
    normalizedAlias: row.normalized_alias,
  }));

  return { products, aliases };
}

// Replaces the FULL manual-item set for one report via the single secure
// RPC (public.save_manual_receipt_items, migration 011, extended by
// migration 014) - there is deliberately no direct
// `.from('receipt_manual_items').insert/update(...)` anywhere in this
// module. `items` is a plain array of
// { description, sku, quantity, unit_price, line_total, is_golden_light }
// objects (any of sku/quantity/unit_price/line_total may be null;
// is_golden_light defaults to false when omitted); line_index is assigned
// server-side from array order and is never sent from here. The RPC
// re-validates every field itself and performs the delete+insert replace
// atomically in one transaction, so a failed save can never leave a report
// with a half-replaced item set - this function does not attempt any
// client-side delete/insert sequencing of its own.
export async function saveAdminManualItems(reportId, items) {
  if (!supabase || !reportId) {
    throw new Error('report_not_found');
  }

  const { error } = await supabase.rpc('save_manual_receipt_items', {
    p_report_id: reportId,
    p_items: items,
  });

  if (error) {
    throw error;
  }
}

// REVIEWABLE_STATUSES mirrors REVIEW_QUEUE_STATUSES (kept as a separate,
// clearly-named export) - a report can only be finalized or rejected while
// it is still 'submitted' or 'needs_review'. The actual authority for this
// rule lives in public.finalize_purchase_report() and
// public.review_purchase_report() (both independently re-check it) - this
// constant is only used by the UI to decide whether to show the unified
// review form/actions at all, never to bypass what the database itself
// enforces.
export const REVIEWABLE_STATUSES = ['submitted', 'needs_review'];

// The single unified review action ("אישור וסיום טיפול") via
// public.finalize_purchase_report(p_report_id, p_items) (migration 015).
// There is deliberately no direct `.from(...).update(...)` or separate
// approve/save/award calls anywhere in this function. `items` has the exact
// same shape saveAdminManualItems() takes
// ({ description, sku, quantity, unit_price, line_total, is_golden_light }
// per row) - the RPC itself validates and atomically replaces the report's
// manual item set, then approves the report, then calculates and awards
// points, all inside one Postgres transaction. The client sends ONLY the
// report id and the item list - never points, points_awarded, an eligible
// total, reviewed_by, or reviewed_at. If ANY step inside the RPC fails
// (invalid item, no eligible Golden Light amount, zero points, a report
// that's no longer reviewable, ...), the entire call rolls back - there is
// no way for items to end up saved without the report being approved, or
// approved without points being awarded. Returns the awarded points.
//
// An item left 'unresolved' is allowed and does not block this call (see
// 024_allow_unresolved_finalize.sql, which removed 023's brief
// 'unresolved_items_remain' guard) - it is simply excluded from the
// eligible total the same way a 'not_golden_light' item already is.
export async function finalizePurchaseReport(reportId, items) {
  if (!supabase || !reportId) {
    throw new Error('report_not_found');
  }

  const { data, error } = await supabase.rpc('finalize_purchase_report', {
    p_report_id: reportId,
    p_items: items,
  });

  if (error) {
    throw error;
  }

  return data;
}

// Rejects a report via the single secure RPC (public.review_purchase_report,
// migration 010) - there is deliberately NO direct
// `.from('purchase_reports').update(...)` anywhere in this module.
// review_purchase_report()'s 'approved' decision path still exists in the
// database (migration 010) but is intentionally not wrapped here anymore -
// the normal admin UI now approves exclusively through
// finalizePurchaseReport() below (migration 015), which saves the manual
// items AND awards points together with the approval, atomically. Rejection
// stays deliberately separate and simple: it never touches
// receipt_manual_items or points, exactly as before.
//
// `reason` is sent as-is; public.review_purchase_report() is the actual
// source of truth for trimming/non-empty/max-length validation (it re-does
// this itself rather than trusting the client), so a caller cannot bypass
// those rules by calling this function directly.
export async function rejectAdminReport(reportId, reason) {
  if (!supabase || !reportId) {
    throw new Error('report_not_found');
  }

  const { error } = await supabase.rpc('review_purchase_report', {
    p_report_id: reportId,
    p_decision: 'rejected',
    p_rejection_reason: reason,
  });

  if (error) {
    throw error;
  }
}

// Fallback-only path: awards purchase-reward points for an ALREADY-approved
// report that has no points_transactions row yet, via the single secure RPC
// (public.award_purchase_points, migration 014). Under the normal review
// flow this can never be needed - finalizePurchaseReport() above awards
// points atomically together with approval, so a freshly-finalized report
// always has hasPointsAward === true immediately. This function/RPC stays
// reachable only for a report that reached 'approved' status BEFORE the
// unified flow existed (via the old review_purchase_report() 'approved'
// path) and was never separately awarded - see
// AdminReportDetailScreen's "צבירת נקודות" fallback section, shown only
// when isApproved && !hasPointsAward. The client sends ONLY the report id -
// there is deliberately no eligiblePreVatAmount/points/points_awarded
// parameter anywhere in this call, and no direct
// `.from('points_transactions').insert(...)` or `.from('profiles').update(...)`
// anywhere in this module. The RPC independently loads the report's
// receipt_manual_items rows with match_status = 'matched' (is_golden_light
// is still stored on each row for display, but has been a pure computed
// mirror of match_status = 'matched' since 019_product_matching_manual_
// items.sql - it is not read here), sums each row's quantity * unit_price
// (line_total is always null - see 016_simplify_eligible_amount_calc.sql),
// and recalculates floor(eligible_total * 0.2) in NUMERIC arithmetic -
// that is the only source of the authoritative value; it can only ever
// reflect what the admin actually saved to receipt_manual_items, never a
// live/OCR value. The RPC itself re-verifies admin membership, that the
// report is 'approved', that a real eligible amount exists
// ('no_eligible_amount' otherwise), and that no purchase_reward
// transaction already exists for it ('points_already_awarded' otherwise,
// backed by a genuine partial UNIQUE INDEX on points_transactions so a
// second purchase-reward row for the same report is impossible even under
// a race) - this function only forwards the report id and lets whatever
// the RPC raises propagate as a real Error for the screen to translate
// into safe Hebrew text.
export async function awardPurchasePoints(reportId) {
  if (!supabase || !reportId) {
    throw new Error('report_not_found');
  }

  const { data, error } = await supabase.rpc('award_purchase_points', {
    p_report_id: reportId,
  });

  if (error) {
    throw error;
  }

  return data;
}

// Mirrors purchaseReportService.getReceiptSignedUrl's shape exactly, but
// kept as its own function here rather than imported/shared: admin access to
// an arbitrary user's receipt file only succeeds because of the dedicated
// "Admins can view any receipt in storage" Storage policy (see migration
// 009) - keeping this call admin-owned makes that dependency explicit rather
// than borrowing a customer-service function that happens to work for an
// unrelated reason.
export async function getAdminReceiptSignedUrl(receiptPath, expiresInSeconds = 300) {
  if (!supabase || !receiptPath) {
    return null;
  }

  const { data, error } = await supabase.storage
    .from('receipts')
    .createSignedUrl(receiptPath, expiresInSeconds);

  if (error) {
    throw error;
  }

  return data?.signedUrl || null;
}
