import { Platform } from 'react-native';

import { supabase } from './supabase';

function generatePurchaseReportId() {
  if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  let timestamp = Date.now();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const randomValue = (timestamp + Math.random() * 16) % 16 | 0;
    timestamp = Math.floor(timestamp / 16);
    return (character === 'x' ? randomValue : (randomValue & 0x3) | 0x8).toString(16);
  });
}

function sanitizeFilename(fileName) {
  const baseName = (fileName || 'receipt').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-');
  const trimmed = baseName.replace(/^[-.]+|[-.]+$/g, '');
  const extension = trimmed.includes('.') ? '' : '.jpg';
  return `${trimmed || 'receipt'}${extension}`;
}

async function createUploadPayload(file) {
  const mimeType = file?.type || 'image/jpeg';
  const safeName = sanitizeFilename(file?.name || file?.fileName || 'receipt.jpg');

  if (Platform.OS === 'web') {
    const response = await fetch(file.uri);
    const blob = await response.blob();
    return new File([blob], safeName, { type: mimeType });
  }

  return {
    uri: file.uri,
    name: safeName,
    type: mimeType,
  };
}

export async function uploadReceipt({ file, userId, purchaseReportId }) {
  if (!supabase || !userId || !purchaseReportId || !file?.uri) {
    throw new Error('Receipt upload is not available.');
  }

  const safeName = sanitizeFilename(file?.name || file?.fileName || 'receipt.jpg');
  const storagePath = `${userId}/${purchaseReportId}/${safeName}`;
  const uploadPayload = await createUploadPayload(file);

  const { data: uploadData, error: uploadError } = await supabase.storage
    .from('receipts')
    .upload(storagePath, uploadPayload, {
      contentType: uploadPayload.type || 'image/jpeg',
      upsert: false,
    });

  if (uploadError) {
    throw uploadError;
  }

  return {
    purchaseReportId,
    storagePath,
    uploadData,
  };
}

export async function createPurchaseReport({ id, userId, receiptPath, originalFilename }) {
  if (!supabase || !userId || !id || !receiptPath) {
    throw new Error('Purchase report cannot be created.');
  }

  const { data, error } = await supabase.from('purchase_reports').insert({
    id,
    user_id: userId,
    receipt_path: receiptPath,
    original_filename: originalFilename || null,
  });

  if (error) {
    throw error;
  }

  return data;
}

// Dispatches OCR processing (supabase/functions/process-receipt) for an
// already-submitted report - never called until AFTER both the receipt
// file and the purchase_reports row are durably persisted (see
// submitPurchaseReceipt below). Carries the normal signed-in user's own
// session automatically (supabase.functions.invoke() attaches the current
// Authorization header itself - no service-role key, no Azure key, and no
// manual header handling here or anywhere in the client).
//
// Deliberately fire-and-forget from the caller's perspective: process-receipt
// runs Azure's full submit+poll cycle server-side (up to ~90s, see
// ocrProvider.ts), and the customer must not be blocked on the upload
// screen for that - submitPurchaseReceipt() below does not await this
// function's full resolution, only starts it. Any failure here (network
// error, function not reachable, non-2xx response) is caught and logged
// here and never rejects/propagates - the receipt and purchase_reports row
// already exist regardless, so the report stays reviewable/retryable
// through the existing admin flow either way. This never retries on its
// own (no client-side retry loop) - process-receipt's own
// claim_ocr_processing() is the single source of truth for whether a retry
// is safe.
async function invokeProcessReceiptOcr(purchaseReportId) {
  if (!supabase || !purchaseReportId) {
    return;
  }

  try {
    console.log('[Purchase] OCR processing invocation dispatched', purchaseReportId);
    const { error } = await supabase.functions.invoke('process-receipt', {
      body: { purchaseReportId },
    });

    if (error) {
      console.warn('[Purchase] OCR processing invocation failed to start', purchaseReportId, error.message);
    }
  } catch (error) {
    console.warn('[Purchase] OCR processing invocation failed to start', purchaseReportId, error?.message);
  }
}

export async function submitPurchaseReceipt({ file, userId }) {
  const purchaseReportId = generatePurchaseReportId();
  const uploadResult = await uploadReceipt({ file, userId, purchaseReportId });

  try {
    await createPurchaseReport({
      id: purchaseReportId,
      userId,
      receiptPath: uploadResult.storagePath,
      originalFilename: file?.name || file?.fileName || null,
    });

    // Both preconditions are now durably satisfied (receipt uploaded,
    // purchase_reports row exists with the correct receipt_path) - dispatch
    // OCR without awaiting its full completion, so the caller's own
    // success/navigation flow isn't blocked on Azure's response time. Not
    // awaited on purpose - see invokeProcessReceiptOcr()'s own comment.
    invokeProcessReceiptOcr(purchaseReportId);

    return {
      purchaseReportId,
      receiptPath: uploadResult.storagePath,
    };
  } catch (error) {
    try {
      await supabase.storage.from('receipts').remove([uploadResult.storagePath]);
    } catch (cleanupError) {
      console.warn('[Purchase] Upload cleanup failed due to storage policy or environment constraints.', cleanupError);
    }

    throw error;
  }
}

export async function getMyPurchaseReports(userId) {
  if (!supabase || !userId) {
    return [];
  }

  const { data, error } = await supabase
    .from('purchase_reports')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

export async function getPurchaseReportById(reportId, userId) {
  if (!supabase || !reportId || !userId) {
    return null;
  }

  const { data, error } = await supabase
    .from('purchase_reports')
    .select('id, original_filename, receipt_path, status, points_awarded, rejection_reason, created_at, updated_at')
    .eq('id', reportId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

// Read-only: the receipt line items an admin manually entered while
// reviewing this report (see public.receipt_manual_items /
// public.save_manual_receipt_items, supabase/migrations/011_receipt_manual_items.sql
// and 012_customer_manual_items_read.sql). This function has no special
// privilege of its own - it only ever returns rows the caller's own
// ownership-based RLS policy admits (purchase_reports.user_id = auth.uid()),
// so a customer can never read another customer's manual items through it.
// created_by (which admin entered the data) is intentionally excluded, both
// here and at the database column-grant level - never expose internal admin
// identity to the customer. These are manually copied receipt lines, not a
// confirmed match against the Golden Light product catalog - callers must
// not relabel them as matched products.
export async function getReceiptManualItems(purchaseReportId) {
  if (!supabase || !purchaseReportId) {
    return [];
  }

  const { data, error } = await supabase
    .from('receipt_manual_items')
    .select('id, description, sku, quantity, unit_price, line_total')
    .eq('purchase_report_id', purchaseReportId)
    .order('line_index', { ascending: true });

  if (error) {
    throw error;
  }

  return data || [];
}

export async function getReceiptSignedUrl(receiptPath, expiresInSeconds = 300) {
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
