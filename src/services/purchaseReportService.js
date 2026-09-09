import { Image } from 'expo-image';
import { Platform } from 'react-native';

import { readLocalFileAsArrayBuffer } from '../utils/localFileBytes';
import { supabase } from './supabase';

// STAGE 15.1: receipt-image signed-URL cache, mirroring profileService.js's
// own avatarUrlCache/avatarUrlInflight pattern exactly (same shape, same
// reasoning) - before this, getReceiptSignedUrl() requested a brand-new
// signed URL from Storage on every single call, including every time
// HomeScreen/PurchaseHistoryScreen re-fetched thumbnails on focus (Home <->
// Rewards <-> Profile <-> History, or simply returning to a tab) even
// though the previous URL was still perfectly valid - a real, measured
// source of redundant network round-trips and part of why images felt slow
// to (re)load on a physical device. Keyed by storagePath
// (purchase_reports.receipt_path), which is already globally unique per
// report (namespaced under `${userId}/${purchaseReportId}/...` - see
// uploadReceipt() below), so this can never serve one report's cached URL
// for another. Process memory only, never persisted - see
// clearReceiptUrlCache() below, called on sign-out (AuthContext) so a
// different user signing in on the same device never has a stale cached
// URL served for a storage path they don't currently own (paths are
// per-user-namespaced anyway, so this is defense in depth, not the only
// thing preventing cross-user leakage - RLS/Storage policies remain
// authoritative).
const RECEIPT_SIGNED_URL_TTL_SECONDS = 300;
const RECEIPT_SIGNED_URL_REFRESH_MARGIN_MS = 30 * 1000;
const receiptUrlCache = new Map();
const receiptUrlInflight = new Map();

// Drops every cached/in-flight receipt signed URL. Called on sign-out - see
// clearReceiptUrlCache()'s own call site in AuthContext.js.
export function clearReceiptUrlCache() {
  receiptUrlCache.clear();
  receiptUrlInflight.clear();
}

// STAGE 17: writes a signed URL into this SAME shared cache directly - used
// by adminReportService.js's getAdminReceiptSignedUrl() after ITS OWN
// (admin-authorized) Storage call succeeds. A signed URL is a bearer token
// for a specific Storage object, valid regardless of which authorized
// session generated it - a customer's own receipt request and an admin's
// review of that same report both key on the identical, globally-unique
// receipt_path, so sharing the cache (not the underlying generation call,
// which genuinely does need to stay admin-owned - see
// adminReportService.js's own comment) avoids a redundant Storage signing
// call whichever side already resolved it first.
export function setCachedReceiptUrl(receiptPath, url, expiresInSeconds = RECEIPT_SIGNED_URL_TTL_SECONDS) {
  if (!receiptPath || !url) {
    return;
  }

  receiptUrlCache.set(receiptPath, {
    url,
    expiresAt: Date.now() + expiresInSeconds * 1000 - RECEIPT_SIGNED_URL_REFRESH_MARGIN_MS,
  });
}

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

// STAGE 15.2 FOLLOW-UP (blocking-fix pass): the previous fix here - reading
// the file via `fetch(uri).then(r => r.blob())` and passing the resulting
// Blob straight into `@supabase/storage-js`'s `upload()` - broke NEW receipt
// uploads on the physical iPhone entirely (they never completed). Root
// cause: React Native's own `Blob` class (`react-native/Libraries/Blob/
// Blob.js`) is NOT a full W3C Blob implementation - its own doc comment
// states "Currently we only support creating Blobs from other Blobs", and
// it represents blob data as an opaque reference into NATIVE-side storage
// (`BlobManager`), not real in-JS bytes. Re-uploading that native-blob
// reference through a SECOND fetch/XHR call (inside `uploadOrUpdate()`'s own
// FormData-building branch) is a known-unreliable path for local files on
// iOS - unlike a genuine browser Blob (which web correctly still uses
// below, since browsers implement the full spec), it does not reliably
// round-trip large local file data across two separate native-bridge hops.
//
// Fix: on native, read the file's real bytes directly into an `ArrayBuffer`
// via readLocalFileAsArrayBuffer() (../utils/localFileBytes.js, wrapping
// expo-file-system's `File#arrayBuffer()` - already the exact API this app
// uses successfully in `receiptImageFormat.js` for magic-byte detection),
// and upload that ArrayBuffer directly. `@supabase/storage-js` does not
// wrap a plain ArrayBuffer in FormData (only Blob/FormData get that
// treatment) - it sends it as the raw fetch body with the `content-type`
// header set from `options.contentType` below, which IS a standard,
// spec-compliant `BodyInit` type that React Native's fetch/XHR bridge
// supports directly, without ever touching RN's own limited Blob class.
// This is NOT the `{uri,name,type}` descriptor object from before Stage
// 15.2 either - `body` here is real, already-read binary data.
async function createUploadPayload(file) {
  const mimeType = file?.type || 'image/jpeg';
  const safeName = sanitizeFilename(file?.name || file?.fileName || 'receipt.jpg');

  if (Platform.OS === 'web') {
    const response = await fetch(file.uri);
    const blob = await response.blob();
    return { body: new File([blob], safeName, { type: mimeType }), contentType: mimeType, byteSize: blob.size ?? null };
  }

  const arrayBuffer = await readLocalFileAsArrayBuffer(file.uri);

  return { body: arrayBuffer, contentType: mimeType, byteSize: arrayBuffer.byteLength };
}

export async function uploadReceipt({ file, userId, purchaseReportId }) {
  if (!supabase || !userId || !purchaseReportId || !file?.uri) {
    throw new Error('Receipt upload is not available.');
  }

  const safeName = sanitizeFilename(file?.name || file?.fileName || 'receipt.jpg');
  const storagePath = `${userId}/${purchaseReportId}/${safeName}`;
  const uploadPayload = await createUploadPayload(file);

  if (__DEV__) {
    console.log('[Purchase] Uploading receipt to Storage', {
      storagePath,
      contentType: uploadPayload.contentType,
      byteSize: uploadPayload.byteSize,
    });
  }

  const { data: uploadData, error: uploadError } = await supabase.storage
    .from('receipts')
    .upload(storagePath, uploadPayload.body, {
      contentType: uploadPayload.contentType,
      upsert: false,
    });

  if (uploadError) {
    if (__DEV__) {
      console.warn('[Purchase] Receipt Storage upload failed', storagePath, uploadError.message);
    }
    throw uploadError;
  }

  if (__DEV__) {
    console.log('[Purchase] Receipt Storage upload succeeded', storagePath);
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
    if (__DEV__) {
      console.warn('[Purchase] purchase_reports insert failed', id, error.code, error.message);
    }
    throw error;
  }

  if (__DEV__) {
    console.log('[Purchase] purchase_reports insert succeeded', id);
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

  const startedAt = __DEV__ ? Date.now() : 0;

  const { data, error } = await supabase
    .from('purchase_reports')
    .select(
      'id, user_id, receipt_path, original_filename, status, points_awarded, rejection_reason, created_at, updated_at, reviewed_at',
    )
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    if (__DEV__) {
      console.warn('[Purchase] getMyPurchaseReports failed', {
        code: error.code,
        message: error.message,
        elapsedMs: Date.now() - startedAt,
      });
    }
    throw error;
  }

  if (__DEV__) {
    console.log('[Purchase] getMyPurchaseReports succeeded', {
      count: data?.length ?? 0,
      elapsedMs: Date.now() - startedAt,
    });
  }

  return data || [];
}

// STAGE 32.7.1: reads through the SECURITY DEFINER public.get_my_purchase_
// report(p_report_id) RPC (035_get_my_purchase_report.sql), replacing a
// plain `.from('purchase_reports').select(...)` that started failing with
// 42501 once the customer column grant was narrowed by
// 025_customer_column_grant_hardening.sql without ever being extended to
// cover promoted_to_tier/promotion_acknowledged_at (added later by 031).
// The RPC needs no table grant at all and derives identity exclusively
// from auth.uid() server-side - `userId` is still accepted here purely as
// a cheap client-side guard (mirrors every other "expected caller" check
// in this file), never sent to or trusted by the RPC itself, which cannot
// return another customer's row regardless of what's passed here.
export async function getPurchaseReportById(reportId, userId) {
  if (!supabase || !reportId || !userId) {
    return null;
  }

  const { data, error } = await supabase.rpc('get_my_purchase_report', { p_report_id: reportId });

  if (error) {
    throw error;
  }

  // `returns table (...)` RPCs resolve to an array of rows via
  // supabase-js - zero rows means "not found or not owned by this caller",
  // preserving the exact same null-for-not-found shape the previous
  // `.maybeSingle()` call already gave every existing caller.
  const row = Array.isArray(data) ? data[0] : data;

  return row ?? null;
}

// STAGE 32.4: the single unacknowledged tier promotion (if any) for this
// customer, used by HomeScreen to surface LevelUpCelebration automatically
// on return-to-app instead of only inside PurchaseReportDetailsScreen.
//
// STAGE 32.4.2: switched from a plain `.from('purchase_reports').select(...)`
// to the SECURITY DEFINER public.get_my_pending_tier_promotion() RPC
// (032_pending_tier_promotion_rpc.sql) after physical runtime testing
// proved the plain select fails with 42501 ("permission denied for table
// purchase_reports") - purchase_reports' customer-facing SELECT grant was
// narrowed to an explicit column list by
// 025_customer_column_grant_hardening.sql, written before
// promoted_to_tier/promotion_acknowledged_at existed, so neither column was
// ever added to that list (see the migration's own comment for the full
// mechanic). The RPC needs no table grant at all - it runs with its
// owner's privileges - and takes no userId parameter (identity comes
// exclusively from auth.uid() inside the function), so this function no
// longer accepts one either; a caller can never request another customer's
// promotion. `.rpc()` on a `returns table (...)` function resolves to an
// array (0 or 1 rows here, per the RPC's own `limit 1`), unlike a plain
// `.select().maybeSingle()` call - unwrapped below into the same
// `{ id, promoted_to_tier, reviewed_at }` shape callers already expect, so
// HomeScreen's own code needed no further change beyond dropping the now-
// unused userId argument at its call site. Returns null (never throws) when
// there is nothing pending.
export async function getPendingTierPromotion() {
  if (!supabase) {
    return null;
  }

  const { data, error } = await supabase.rpc('get_my_pending_tier_promotion');

  if (error) {
    throw error;
  }

  const row = Array.isArray(data) ? data[0] : data;

  if (!row) {
    return null;
  }

  return { id: row.report_id, promoted_to_tier: row.promoted_to_tier, reviewed_at: row.reviewed_at };
}

// STAGE 32: marks this report's level-up celebration as shown/dismissed -
// the ONLY way promotion_acknowledged_at can ever be written (see
// public.acknowledge_tier_promotion() in 031_membership_tier_rewards.sql).
// Ownership and "is there actually a pending promotion" are both enforced
// server-side, not trusted here - calling this for a report that isn't the
// caller's own, or that has no pending promotion, is a harmless no-op.
export async function acknowledgeTierPromotion(reportId) {
  if (!supabase || !reportId) {
    return;
  }

  const { error } = await supabase.rpc('acknowledge_tier_promotion', { p_report_id: reportId });

  if (error) {
    if (__DEV__) {
      console.warn('[Purchase] acknowledgeTierPromotion failed', { code: error.code, message: error.message });
    }
    throw error;
  }
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

// STAGE 20: stable expo-image cache identity for receipt images. The
// underlying Supabase signed URL for a given receipt_path changes every
// time it's regenerated (a fresh query string/token), but expo-image's
// default cache identity IS the request URL itself unless a separate
// `cacheKey` is supplied on the image source ("The cache key used to query
// and store this specific image. If not provided, the uri is used also as
// the cache key." - verified against the installed expo-image 57.0.2 type
// definitions, node_modules/expo-image/build/Image.types.d.ts, before
// writing this). Without this, a receipt whose signed URL was regenerated
// between visits looks like a brand-new image to expo-image and gets
// refetched/redecoded from scratch even though it's the exact same file.
// Keying on receiptPath (already globally unique per report, already the
// key this file's own receiptUrlCache uses) keeps the SAME expo-image
// cache entry valid across however many different signed URLs get
// generated for that same object, so a receipt already seen once (a Home
// thumbnail, a History thumbnail, or the Detail screen's full image) stays
// instantly available from expo-image's own memory/disk cache everywhere
// else it's shown - independent of this module's own 5-minute signed-URL
// TTL, and independent of which screen resolved it first.
export function receiptImageCacheKey(receiptPath) {
  return receiptPath ? `receipt:${receiptPath}` : undefined;
}

// Returns a still-valid cached signed URL for this receipt path, or null if
// there is none/it's expired - synchronous, so a caller can skip straight
// to rendering on a cache hit instead of showing a loading placeholder
// first. Mirrors profileService.js's getCachedAvatarUrl() exactly.
export function getCachedReceiptUrl(receiptPath) {
  if (!receiptPath) {
    return null;
  }

  const entry = receiptUrlCache.get(receiptPath);
  if (!entry || Date.now() >= entry.expiresAt) {
    return null;
  }

  return entry.url;
}

export async function getReceiptSignedUrl(receiptPath, expiresInSeconds = RECEIPT_SIGNED_URL_TTL_SECONDS) {
  if (!supabase || !receiptPath) {
    return null;
  }

  const cached = getCachedReceiptUrl(receiptPath);
  if (cached) {
    return cached;
  }

  const inflight = receiptUrlInflight.get(receiptPath);
  if (inflight) {
    return inflight;
  }

  if (__DEV__) {
    console.log('[Purchase] Receipt signed URL request start (cache miss)', receiptPath);
  }
  const startedAt = __DEV__ ? Date.now() : 0;

  const requestPromise = (async () => {
    const { data, error } = await supabase.storage
      .from('receipts')
      .createSignedUrl(receiptPath, expiresInSeconds);

    if (error) {
      // Never log the receiptPath's actual signed URL - only success/failure
      // and the storage path (already known to belong to this user).
      if (__DEV__) {
        console.warn('[Purchase] Failed to create receipt signed URL', receiptPath, error.message, {
          elapsedMs: Date.now() - startedAt,
        });
      }
      throw error;
    }

    const url = data?.signedUrl || null;

    if (__DEV__) {
      console.log('[Purchase] Receipt signed URL created', receiptPath, url ? 'ok' : 'empty', {
        elapsedMs: Date.now() - startedAt,
      });
    }

    if (url) {
      receiptUrlCache.set(receiptPath, {
        url,
        expiresAt: Date.now() + expiresInSeconds * 1000 - RECEIPT_SIGNED_URL_REFRESH_MARGIN_MS,
      });
    }

    return url;
  })();

  receiptUrlInflight.set(receiptPath, requestPromise);

  try {
    return await requestPromise;
  } finally {
    receiptUrlInflight.delete(receiptPath);
  }
}

// STAGE 21.1: the single shared place that actually warms an expo-image
// cache entry for a receipt - extracted here because, before this, the same
// `Image.loadAsync({ uri, cacheKey })` call was duplicated inline in
// HomeScreen.js's loadThumbnails AND in prefetchReceiptImages below, and
// admin (adminReportService.js) had no warming at all (see that file's own
// STAGE 21.1 comment on loadAdminReceiptThumbnails). Every caller - customer
// or admin, priority or background - now goes through this one function, so
// there is exactly one place that can warm a receipt's cache entry
// incorrectly, and exactly one place the in-flight de-dupe below applies.
//
// Takes an ALREADY-RESOLVED signed URL rather than a receiptPath alone -
// resolving the URL is the caller's job (via getReceiptSignedUrl /
// getAdminReceiptSignedUrl, whichever is appropriate for who's asking), kept
// deliberately separate from warming so a caller that already has a fresh
// URL (e.g. from the shared receiptUrlCache) never pays for a redundant
// resolve just to warm the image.
//
// De-duped by cacheKey, not receiptPath, purely for symmetry with
// receiptImageCacheKey's own output - two near-simultaneous callers for the
// same receipt (e.g. a History row's priority batch and someone opening that
// same report's Detail screen at the same moment) share the one in-flight
// Image.loadAsync call instead of issuing two.
//
// Never throws - resolves to a boolean (true = warmed, false = failed) so a
// caller can gate a "this thumbnail is genuinely ready" state on the result,
// while still choosing to fall back to a normal <Image> network load (by
// still exposing the URL) even when warming itself failed. See
// adminReportService.js's loadAdminReceiptThumbnails for that exact pattern.
//
// STAGE 21.1 / PART G note: no separate "is this already cached?" pre-check
// (e.g. Image.getCachePathAsync, which IS a real, verified API in the
// installed expo-image build) was added in front of this. Image.loadAsync
// itself already resolves from its own memory/disk cache first and only
// hits the network on a genuine miss, so awaiting it on an already-warm
// cacheKey is not "a mandatory network gate" - it settles immediately from
// cache. Every caller here also already has its OWN fast path for a warm
// receipt: a cache hit on the signed-URL cache (getCachedReceiptUrl) is
// treated as ready without ever calling this function at all, since a URL
// only ever lands in that cache after this function has already been
// awaited once for it (see getReceiptSignedUrl's own callers and
// loadAdminReceiptThumbnails below) - so a genuinely warm receipt never
// reaches this function a second time in the first place.
const imageWarmInflight = new Map();

export function warmReceiptImage(receiptPath, signedUrl) {
  if (!receiptPath || !signedUrl) {
    return Promise.resolve(false);
  }

  const cacheKey = receiptImageCacheKey(receiptPath);
  const inflight = imageWarmInflight.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const warmPromise = Image.loadAsync({ uri: signedUrl, cacheKey })
    .then(() => true)
    .catch((err) => {
      if (__DEV__) {
        console.warn('[Purchase] Receipt image warm failed', receiptPath, err?.message);
      }
      return false;
    })
    .finally(() => {
      imageWarmInflight.delete(cacheKey);
    });

  imageWarmInflight.set(cacheKey, warmPromise);
  return warmPromise;
}

// STAGE 20.1: superseded Stage 20's own Image.prefetch(url)-based version.
// Re-investigated per the physical-device finding that prefetched images
// weren't measurably speeding up the actual render: Image.prefetch() only
// accepts a URL (confirmed again against the installed expo-image 57.0.2
// type definitions, node_modules/expo-image/build/Image.d.ts) - no cacheKey
// parameter - so it warms a cache entry keyed by the signed URL itself,
// while every rendered receipt <Image> in this app uses the STABLE
// `receipt:<path>` cacheKey (see receiptImageCacheKey above), a genuinely
// different cache entry. That mismatch meant the prefetch's own network
// fetch was real (and did warm the OS/CDN layer to some degree), but expo-
// image itself would still treat the later render as a cache miss and
// re-request the bytes under the correct key.
//
// STAGE 21.1: now delegates the actual warm to warmReceiptImage above
// instead of calling Image.loadAsync directly - same behavior, just no
// longer a second copy of that call.
export async function prefetchReceiptImages(receiptPaths) {
  if (!Array.isArray(receiptPaths) || receiptPaths.length === 0) {
    return;
  }

  await Promise.all(
    receiptPaths.map(async (receiptPath) => {
      if (!receiptPath) {
        return;
      }

      try {
        const url = await getReceiptSignedUrl(receiptPath);
        if (url) {
          await warmReceiptImage(receiptPath, url);
        }
      } catch (err) {
        if (__DEV__) {
          console.warn('[Purchase] Receipt image prefetch failed', receiptPath, err?.message);
        }
      }
    }),
  );
}
