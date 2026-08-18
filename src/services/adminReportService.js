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

const MANUAL_ITEM_COLUMNS = 'id, line_index, description, sku, quantity, unit_price, line_total, created_at, updated_at';

async function fetchManualItems(reportId) {
  const { data, error } = await supabase
    .from('receipt_manual_items')
    .select(MANUAL_ITEM_COLUMNS)
    .eq('purchase_report_id', reportId)
    .order('line_index', { ascending: true });

  if (error) {
    throw error;
  }

  return data || [];
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

  return {
    ...report,
    customerName: nameById.get(report.user_id) || null,
    ocrResult: ocrResult || null,
    ocrLines,
    lineMatches,
    manualItems,
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
// RPC (public.save_manual_receipt_items, migration 011) - there is
// deliberately no direct `.from('receipt_manual_items').insert/update(...)`
// anywhere in this module. `items` is a plain array of
// { description, sku, quantity, unit_price, line_total } objects (any of
// sku/quantity/unit_price/line_total may be null); line_index is assigned
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
// clearly-named export) - a report can only be finalized while it is still
// 'submitted' or 'needs_review'. The actual authority for this rule lives
// in public.review_purchase_report() (migration 010) - this constant is
// only used by the UI to decide whether to show the approve/reject actions
// at all, never to bypass what the database itself enforces.
export const REVIEWABLE_STATUSES = ['submitted', 'needs_review'];

// Finalizes a report as approved or rejected. Both are thin wrappers around
// the single secure RPC (public.review_purchase_report, migration 010) -
// there is deliberately NO direct `.from('purchase_reports').update(...)`
// anywhere in this module. The RPC itself re-verifies admin membership,
// re-checks the report is still reviewable (raising 'report_not_reviewable'
// otherwise - e.g. a second admin session that already acted, or a report
// still 'processing'), and validates the rejection reason; this function
// only forwards the caller's intent and lets whatever the RPC raises
// propagate as a real Error for the screen to translate into safe Hebrew
// text. Neither function awards points or touches public.profiles in any
// way - that is enforced by the RPC, not by this client code.
export async function approveAdminReport(reportId) {
  if (!supabase || !reportId) {
    throw new Error('report_not_found');
  }

  const { error } = await supabase.rpc('review_purchase_report', {
    p_report_id: reportId,
    p_decision: 'approved',
  });

  if (error) {
    throw error;
  }
}

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
