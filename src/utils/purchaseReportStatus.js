import { colors } from '../theme';

// The single customer-facing receipt-status mapping, shared by every
// customer screen that shows a purchase_reports.status value (HomeScreen's
// "פעילות אחרונה", PurchaseHistoryScreen, PurchaseReportDetailsScreen).
//
// A customer never needs to know which internal pipeline stage their
// receipt is at - submitted (uploaded, not yet picked up), processing (OCR
// running), and needs_review (OCR finished, waiting for an admin) are three
// internal states of the SAME thing from the customer's point of view: "we
// have it, we're on it". All three collapse to one label/visual treatment -
// never a technical word like "OCR"/"processing"/"review" that implies the
// customer should know or care how far along the internal pipeline is. Only
// approved/rejected are real, distinct, final outcomes worth their own
// label. Admin screens use their own, independent status wording (the
// admin genuinely needs to distinguish these states) and must not import
// this helper.
export function getCustomerReceiptStatusMeta(status) {
  switch (status) {
    case 'approved':
      return { label: 'אושרה', backgroundColor: colors.successSoft, textColor: colors.success };
    case 'rejected':
      return { label: 'נדחתה', backgroundColor: colors.errorSoft, textColor: colors.error };
    case 'submitted':
    case 'processing':
    case 'needs_review':
    default:
      return { label: 'בבדיקה', backgroundColor: colors.primarySoft, textColor: colors.primaryPressed };
  }
}