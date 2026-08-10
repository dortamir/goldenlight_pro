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
