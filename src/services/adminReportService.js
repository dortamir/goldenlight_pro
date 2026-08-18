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
    .select('id, user_id, receipt_path, original_filename, status, points_awarded, created_at, updated_at')
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

  return {
    ...report,
    customerName: nameById.get(report.user_id) || null,
    ocrResult: ocrResult || null,
    ocrLines,
    lineMatches,
  };
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
