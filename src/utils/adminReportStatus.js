import { colors } from '../theme';

// The single ADMIN-facing receipt-status mapping, shared by every admin
// screen that shows a purchase_reports.status value (AdminHomeScreen's own
// queue, AdminReportsHistoryScreen's "כל החשבוניות", AdminReportDetailScreen's
// header badge). Deliberately separate from src/utils/purchaseReportStatus.js
// (the CUSTOMER-facing mapping, which collapses submitted/processing/
// needs_review into one "בבדיקה" state) - kept as its own file/export
// rather than reusing that one, even though the grouping is now similar,
// because the admin vocabulary ("דורשת בדיקה" vs "בבדיקה") and this
// function's return shape (label + backgroundColor + textColor, vs the
// customer helper's identical shape but different palette/wording) remain
// independent by design - a future change to either must not silently
// affect the other.
//
// STAGE 13 UPDATE: submitted/processing/needs_review now collapse into the
// SAME single "דורשת בדיקה" label admin-side too - internal `processing` is
// a real, unchanged purchase_reports.status (the OCR pipeline itself is not
// touched by this), but it is no longer surfaced as its own distinct
// admin-facing operational category. This is presentation only: nothing
// here writes to the database, and REVIEWABLE_STATUSES (adminReportService.js
// - the actual finalize/reject eligibility gate, independently enforced by
// finalize_purchase_report()/review_purchase_report() in Postgres) is a
// separate constant, deliberately unchanged - a 'processing' report still
// cannot be finalized/rejected until the pipeline itself moves it to
// 'needs_review', regardless of how it's labeled here.
//
// `warning`/`warningSoft` (previously unused anywhere in this theme) mark
// this whole "needs a decision" group as slightly more attention-worthy
// than a purely informational state, without borrowing the `error`/
// `errorSoft` tokens reserved for a genuine rejection.
export function getAdminReportStatusMeta(status) {
  switch (status) {
    case 'approved':
      return { label: 'אושרה', backgroundColor: colors.successSoft, textColor: colors.success };
    case 'rejected':
      return { label: 'נדחתה', backgroundColor: colors.errorSoft, textColor: colors.error };
    case 'submitted':
    case 'processing':
    case 'needs_review':
    default:
      return { label: 'דורשת בדיקה', backgroundColor: colors.warningSoft, textColor: colors.warning };
  }
}