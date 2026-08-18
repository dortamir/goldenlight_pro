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
// the current schema supports those meaningfully yet.
export async function getAdminDashboardSummary() {
  if (!supabase) {
    throw new Error('Admin data is not available.');
  }

  const [needsAttention, processing, approved] = await Promise.all([
    supabase
      .from('purchase_reports')
      .select('id', { count: 'exact', head: true })
      .in('status', REVIEW_QUEUE_STATUSES),
    supabase.from('purchase_reports').select('id', { count: 'exact', head: true }).eq('status', 'processing'),
    supabase.from('purchase_reports').select('id', { count: 'exact', head: true }).eq('status', 'approved'),
  ]);

  if (needsAttention.error) {
    throw needsAttention.error;
  }
  if (processing.error) {
    throw processing.error;
  }
  if (approved.error) {
    throw approved.error;
  }

  return {
    // "חשבוניות לבדיקה" - everything currently waiting for admin attention
    // (submitted + needs_review), see REVIEW_QUEUE_STATUSES above.
    needsReviewCount: needsAttention.count ?? 0,
    processingCount: processing.count ?? 0,
    approvedCount: approved.count ?? 0,
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
// ממתינות / בטיפול / אושרו / נדחו" UI filters happens client-side in
// AdminReportsHistoryScreen against this same full list - there is no
// separate query per filter.
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

  let ocrLines = [];
  let lineMatches = [];

  if (ocrResult) {
    const { data: lines, error: linesError } = await supabase
      .from('receipt_ocr_lines')
      .select('id, line_index, raw_text, detected_quantity, detected_unit_price, detected_total')
      .eq('ocr_result_id', ocrResult.id)
      .order('line_index', { ascending: true });

    if (linesError) {
      throw linesError;
    }

    ocrLines = lines || [];

    if (ocrLines.length > 0) {
      const { data: matches, error: matchesError } = await supabase
        .from('receipt_line_matches')
        .select('id, ocr_line_id, match_status, match_method, confidence, matched_text')
        .in('ocr_line_id', ocrLines.map((line) => line.id));

      if (matchesError) {
        throw matchesError;
      }

      lineMatches = matches || [];
    }
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
// receipt_manual_items rows marked is_golden_light, sums each row's
// coalesce(line_total, quantity * unit_price), and recalculates
// floor(eligible_total * 0.2) in NUMERIC arithmetic - that is the only
// source of the authoritative value. The RPC itself re-verifies admin
// membership, that the report is 'approved', that a real eligible amount
// exists ('no_eligible_amount' otherwise), and that no purchase_reward
// transaction already exists for it ('points_already_awarded' otherwise) -
// this function only forwards the report id and lets whatever the RPC
// raises propagate as a real Error for the screen to translate into safe
// Hebrew text.
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
