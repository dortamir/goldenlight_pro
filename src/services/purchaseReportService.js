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
    if (__DEV__) {
      console.log('[Purchase] OCR processing invocation dispatched', purchaseReportId);
    }
    const { error } = await supabase.functions.invoke('process-receipt', {
      body: { purchaseReportId },
    });

    if (error && __DEV__) {
      console.warn('[Purchase] OCR processing invocation failed to start', purchaseReportId, error.message);
    }
  } catch (error) {
    if (__DEV__) {
      console.warn('[Purchase] OCR processing invocation failed to start', purchaseReportId, error?.message);
    }
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
      if (__DEV__) {
        console.warn('[Purchase] Upload cleanup failed due to storage policy or environment constraints.', cleanupError);
      }
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
    .select(
      'id, user_id, receipt_path, original_filename, status, points_awarded, rejection_reason, created_at, updated_at, reviewed_at',
    )
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

// Read-only: ONLY the confirmed Golden Light receipt lines that actually
// contributed to this report's points - i.e. exactly the rows
// public.award_purchase_points() itself sums (receipt_manual_items rows
// with match_status = 'matched' for this report), never every saved manual
// item regardless of match state. Reads through the SECURITY DEFINER
// public.get_my_eligible_receipt_items() RPC (026_customer_eligible_receipt_items.sql)
// rather than a plain table select, because match_status/product_id/
// match_type/match_confidence/is_golden_light are deliberately NOT part of
// the customer's direct receipt_manual_items column grant (migration 025) -
// the RPC performs the match_status = 'matched' filter server-side and
// returns only the same safe display columns the customer already had
// access to. Ownership is enforced inside the RPC itself (joins to
// purchase_reports, requires user_id = auth.uid()), so - exactly like
// before - a customer can never read another customer's items through it;
// a report that isn't theirs (or doesn't exist) simply resolves to zero
// rows. created_by (which admin entered the data) was never exposed here
// and still isn't - the RPC doesn't return it.
export async function getEligibleReceiptItems(purchaseReportId) {
  if (!supabase || !purchaseReportId) {
    return [];
  }

  const { data, error } = await supabase.rpc('get_my_eligible_receipt_items', {
    p_report_id: purchaseReportId,
  });

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
