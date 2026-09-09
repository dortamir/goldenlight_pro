import { Platform } from 'react-native';

import { readLocalFileAsArrayBuffer } from '../utils/localFileBytes';
import { supabase } from './supabase';

const PROFILE_COLUMNS =
  'id, full_name, phone, profession, date_of_birth, avatar_path, points_balance, membership_level, approved_purchases_count, created_at, updated_at';

const AVATAR_BUCKET = 'profile-avatars';

// Signed URLs are requested with a 1-hour lifetime, long enough to cover a
// normal app session. The in-memory cache below treats a cached entry as
// stale a few minutes before that real expiry, so callers naturally get a
// fresh URL ahead of time instead of ever being handed an expired one.
const AVATAR_SIGNED_URL_TTL_SECONDS = 60 * 60;
const AVATAR_SIGNED_URL_REFRESH_MARGIN_MS = 5 * 60 * 1000;

// Shared in-memory cache: avatarPath -> { url, expiresAt }. This is process
// memory only (never persisted), and is shared by every screen that imports
// this module, so ProfileScreen and EditProfileScreen naturally reuse each
// other's already-resolved signed URLs instead of each requesting their own.
const avatarUrlCache = new Map();
// In-flight request de-duplication: avatarPath -> Promise<string|null>, so
// near-simultaneous requests for the same avatar (e.g. two screens mounting
// close together) share a single Supabase Storage request.
const avatarUrlInflight = new Map();

// Returns a still-valid cached signed URL for this avatar path, or null if
// there is no cached entry or it's expired/about to expire. Synchronous, so
// callers can decide to skip a "loading" UI state entirely on a cache hit.
export function getCachedAvatarUrl(avatarPath) {
  if (!avatarPath) {
    return null;
  }

  const entry = avatarUrlCache.get(avatarPath);
  if (!entry || Date.now() >= entry.expiresAt) {
    return null;
  }

  return entry.url;
}

// Drops any cached/in-flight signed URL for this avatar path. Must be called
// whenever the underlying image at that path may have changed even though
// the path string itself stayed the same (e.g. an upsert avatar replacement
// at "<userId>/avatar.jpg") - otherwise the cache would keep serving a
// signed URL pointing at stale (but still valid) bytes.
export function invalidateAvatarUrlCache(avatarPath) {
  if (!avatarPath) {
    return;
  }

  avatarUrlCache.delete(avatarPath);
  avatarUrlInflight.delete(avatarPath);
}

// STAGE 15.1: drops every cached/in-flight avatar URL, regardless of path -
// called on sign-out (AuthContext.js), unlike invalidateAvatarUrlCache()
// above (one specific path, called after a successful re-upload).
export function clearAvatarUrlCache() {
  avatarUrlCache.clear();
  avatarUrlInflight.clear();
}

// STAGE 15.3: short-lived profile-row cache + in-flight de-duplication,
// mirroring the avatar/receipt signed-URL cache pattern above. Home,
// Rewards, and Profile each independently call getProfile() on their own
// focus - switching between them in quick succession (Home -> Rewards ->
// Profile -> Home) was issuing 3-4 separate, near-simultaneous requests for
// the exact same profile row. The TTL is deliberately short (unlike the
// hour-long avatar-URL cache) - long enough to de-duplicate a quick tab
// switch, short enough that returning to any screen more than a few seconds
// later (the realistic case for "an admin approved my receipt while I was
// looking elsewhere") always gets a fresh fetch. The backend row remains
// the sole source of truth - this only avoids redundant round-trips for the
// exact same data within the same few seconds; it never invents or
// estimates a value.
const PROFILE_CACHE_TTL_MS = 8 * 1000;
const profileCache = new Map();
const profileInflight = new Map();

// Synchronous - lets a caller decide to skip its own loading state on a
// cache hit, same as getCachedAvatarUrl/getCachedReceiptUrl.
export function getCachedProfile(userId) {
  if (!userId) {
    return null;
  }

  const entry = profileCache.get(userId);
  if (!entry || Date.now() >= entry.expiresAt) {
    return null;
  }

  return entry.data;
}

function setCachedProfile(userId, data) {
  if (!userId) {
    return;
  }

  profileCache.set(userId, { data, expiresAt: Date.now() + PROFILE_CACHE_TTL_MS });
}

// Drops this user's cached/in-flight profile fetch - called after a
// successful updateProfile() below, so a save is reflected immediately
// rather than being masked by a still-valid cache entry holding the
// pre-edit row.
export function invalidateProfileCache(userId) {
  if (!userId) {
    return;
  }

  profileCache.delete(userId);
  profileInflight.delete(userId);
}

// Drops every cached/in-flight profile fetch, regardless of user - called
// on sign-out (AuthContext.js), same reasoning as clearAvatarUrlCache/
// clearReceiptUrlCache: a different user signing in on the same device must
// never see a stale cached profile row left over from the previous session.
export function clearProfileCache() {
  profileCache.clear();
  profileInflight.clear();
}

export async function getProfile(userId) {
  if (!supabase || !userId) {
    throw new Error('Profile not available');
  }

  const cached = getCachedProfile(userId);
  if (cached) {
    return cached;
  }

  const inflight = profileInflight.get(userId);
  if (inflight) {
    return inflight;
  }

  const startedAt = __DEV__ ? Date.now() : 0;

  const requestPromise = (async () => {
    const { data, error } = await supabase
      .from('profiles')
      .select(PROFILE_COLUMNS)
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      if (__DEV__) {
        console.warn('[Profile] getProfile failed', { code: error.code, message: error.message, elapsedMs: Date.now() - startedAt });
      }
      throw error;
    }

    if (__DEV__) {
      console.log('[Profile] getProfile succeeded', { elapsedMs: Date.now() - startedAt });
    }

    if (data) {
      setCachedProfile(userId, data);
    }

    return data;
  })();

  profileInflight.set(userId, requestPromise);

  try {
    return await requestPromise;
  } finally {
    profileInflight.delete(userId);
  }
}

export async function updateProfile(userId, updates) {
  if (!supabase || !userId) {
    throw new Error('Profile not available');
  }

  // Explicitly whitelist the only columns the mobile client is allowed to
  // change. Any other field on `updates` (points_balance, membership_level,
  // approved_purchases_count, id, created_at, updated_at, ...) is ignored
  // here, and would be rejected by the database's column grants regardless.
  const payload = {
    full_name: updates?.full_name,
    phone: updates?.phone,
    profession: updates?.profession ?? null,
  };

  // avatar_path is only included when the caller explicitly provides it
  // (i.e. a new avatar was uploaded during this save), so profiles that
  // aren't changing their photo never have their existing avatar_path
  // touched by this update.
  if (updates && Object.prototype.hasOwnProperty.call(updates, 'avatar_path')) {
    payload.avatar_path = updates.avatar_path ?? null;
  }

  // STAGE 26: same "only included when explicitly provided" pattern as
  // avatar_path above - a profile save that isn't setting a birthday never
  // touches the existing column. The database is the real enforcement
  // point for "settable once" (see supabase/migrations/028_birthday_bonus.sql's
  // profiles_prevent_date_of_birth_change trigger) - this client whitelist
  // only decides which columns THIS function is willing to forward at all,
  // it is not itself a security boundary.
  if (updates && Object.prototype.hasOwnProperty.call(updates, 'date_of_birth')) {
    payload.date_of_birth = updates.date_of_birth ?? null;
  }

  const { data, error } = await supabase
    .from('profiles')
    .update(payload)
    .eq('id', userId)
    .select(PROFILE_COLUMNS)
    .maybeSingle();

  if (error) {
    throw error;
  }

  // The row just changed server-side - a still-valid cache entry from
  // before this save would otherwise keep serving the pre-edit data to
  // ProfileScreen/RewardsScreen/HomeScreen for up to PROFILE_CACHE_TTL_MS
  // after returning to them. The fresh row is already in hand here, so it's
  // written directly rather than merely invalidating and forcing another
  // round-trip.
  if (data) {
    setCachedProfile(userId, data);
  }

  return data;
}

// STAGE 26: calls the server-side public.claim_my_birthday_bonus() RPC
// (see supabase/migrations/028_birthday_bonus.sql). All eligibility logic -
// whether today is the caller's birthday, whether this year's bonus was
// already granted, the +1,000 point amount itself - lives entirely inside
// that SECURITY DEFINER function; this is a thin, side-effect-free wrapper
// that never computes or assumes anything about eligibility itself. Safe to
// call on every authenticated session start (see AuthContext.js) - on any
// day that isn't a qualifying birthday, or once this year's bonus already
// exists, the RPC itself is a read-only no-op that returns awarded: false.
export async function claimBirthdayBonus() {
  if (!supabase) {
    return { awarded: false, pointsBalance: null, bonusPoints: 0 };
  }

  const { data, error } = await supabase.rpc('claim_my_birthday_bonus');

  if (error) {
    if (__DEV__) {
      console.warn('[Profile] claimBirthdayBonus failed', {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      });
    }
    throw error;
  }

  // supabase-js returns a `returns table (...)` RPC result as an array of
  // rows - this function always returns exactly one row for an
  // authenticated caller.
  const row = Array.isArray(data) ? data[0] : data;

  return {
    awarded: Boolean(row?.awarded),
    pointsBalance: Number.isFinite(row?.points_balance) ? row.points_balance : null,
    bonusPoints: Number.isFinite(row?.bonus_points) ? row.bonus_points : 0,
  };
}

// STAGE 32.5: the single unacknowledged birthday-bonus celebration (if any)
// for this customer - the persistent, reload/logout-survivable replacement
// for AuthContext's old in-memory birthdayBonus state. Reads through the
// SECURITY DEFINER public.get_my_pending_birthday_celebration() RPC
// (033_birthday_bonus_celebration.sql), required (not just preferred) since
// points_transactions' only RLS policy is admin-only - a plain customer
// select against this table returns zero rows regardless of any table
// grant. Returns null (never throws) when there is nothing pending.
export async function getPendingBirthdayCelebration() {
  if (!supabase) {
    return null;
  }

  const { data, error } = await supabase.rpc('get_my_pending_birthday_celebration');

  if (error) {
    throw error;
  }

  const row = Array.isArray(data) ? data[0] : data;

  if (!row) {
    return null;
  }

  return { id: row.transaction_id, bonusPoints: row.bonus_points, rewardYear: row.reward_year };
}

// STAGE 32.5: marks this birthday-bonus transaction's celebration as shown/
// dismissed - the ONLY way points_transactions.acknowledged_at can ever be
// written (public.acknowledge_my_birthday_celebration() in
// 033_birthday_bonus_celebration.sql). Ownership and "is this actually a
// pending birthday bonus" are both enforced server-side, not trusted here -
// calling this for a transaction that isn't the caller's own, or that
// isn't a birthday bonus, or is already acknowledged, is a harmless no-op.
export async function acknowledgeBirthdayCelebration(transactionId) {
  if (!supabase || !transactionId) {
    return;
  }

  const { error } = await supabase.rpc('acknowledge_my_birthday_celebration', {
    p_transaction_id: transactionId,
  });

  if (error) {
    if (__DEV__) {
      console.warn('[Profile] acknowledgeBirthdayCelebration failed', { code: error.code, message: error.message });
    }
    throw error;
  }
}

function getAvatarExtension(mimeType) {
  switch (String(mimeType || '').toLowerCase()) {
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/jpeg':
    case 'image/jpg':
    default:
      return 'jpg';
  }
}

// STAGE 15.2 FOLLOW-UP: same fix as purchaseReportService.js's
// createUploadPayload() (see its comment for the full explanation). React
// Native's own `Blob` class only supports wrapping OTHER Blobs, not raw
// bytes, and re-uploading a native-blob reference produced by
// `fetch(uri).blob()` through a second fetch call is unreliable for local
// files on iOS - it broke new receipt uploads entirely on the physical
// device. On native, this now reads the real bytes directly into an
// ArrayBuffer via expo-file-system's `File#arrayBuffer()` and uploads that
// directly - never wrapped in RN's own Blob. Web keeps using a real browser
// Blob (fully spec-compliant there, unlike RN's).
async function createAvatarUploadPayload(asset, mimeType, fileName) {
  if (Platform.OS === 'web') {
    const response = await fetch(asset.uri);
    const blob = await response.blob();
    return { body: new File([blob], fileName, { type: mimeType }), byteSize: blob.size ?? null };
  }

  const arrayBuffer = await readLocalFileAsArrayBuffer(asset.uri);
  return { body: arrayBuffer, byteSize: arrayBuffer.byteLength };
}

// STAGE 32.6.3: every upload now gets a UNIQUE storage path
// ("<userId>/avatar-<timestamp>.<ext>"), replacing the old stable
// "<userId>/avatar.<ext>" + upsert:true design. That design relied on every
// downstream cache (this module's own avatarUrlCache, expo-image's native
// cache, and potentially an HTTP/CDN cache in front of Supabase Storage)
// correctly distinguishing two different signed URLs for the SAME path from
// their query-string token alone - physical testing showed the rendered
// image could still go stale despite a genuinely fresh, different-token
// signed URL being resolved (see this stage's own diagnosis). A unique path
// per upload removes that entire class of uncertainty: every layer that
// might cache by path (not just by full URL) now sees a genuinely new
// object, with no assumption required about query-string cache-key
// handling anywhere in the chain.
//
// Never derived from user input - Date.now() only, exactly as directed.
// upsert is no longer relied upon for normal replacement (kept `false`,
// Supabase Storage's own default) - a same-millisecond collision for the
// same user is not a realistic scenario this app needs to tolerate, and an
// explicit failure here is safer than a silent overwrite would be.
//
// This function no longer deletes anything - the OLD stale-extension
// cleanup here used to guess sibling files from a stable filename pattern,
// which no longer applies now that every path is unique per upload.
// Deleting the previous avatar is now the caller's responsibility (see
// deletePreviousAvatar() below), performed only AFTER the caller has
// confirmed profiles.avatar_path was actually updated to point at this new
// path - never from inside the upload step itself, which has no way to
// know whether the subsequent DB write will succeed.
export async function uploadProfileAvatar(userId, asset) {
  if (!supabase || !userId || !asset?.uri) {
    throw new Error('Avatar upload is not available.');
  }

  const mimeType = asset.mimeType || asset.type || 'image/jpeg';
  const extension = getAvatarExtension(mimeType);
  const fileName = `avatar-${Date.now()}.${extension}`;
  const storagePath = `${userId}/${fileName}`;
  const uploadPayload = await createAvatarUploadPayload(asset, mimeType, fileName);

  if (__DEV__) {
    console.log('[Profile] Uploading avatar to Storage', { storagePath, contentType: mimeType, byteSize: uploadPayload.byteSize });
  }

  const { error: uploadError } = await supabase.storage
    .from(AVATAR_BUCKET)
    .upload(storagePath, uploadPayload.body, {
      contentType: mimeType,
      upsert: false,
    });

  if (uploadError) {
    throw uploadError;
  }

  return storagePath;
}

// STAGE 32.6.3: deletes the customer's PREVIOUS avatar object, called only
// by EditProfileScreen.js's save flow, only AFTER updateProfile() has
// confirmed profiles.avatar_path now points at the NEW path. Never throws -
// a cleanup failure here must never affect an already-successful save (the
// new avatar is already live in both Storage and the DB by the time this
// runs); it is logged in __DEV__ and otherwise silently ignored, per the
// explicit "do not roll back, just log and continue" requirement. Three
// defensive checks before ever calling Storage's remove(): the previous
// path must be non-empty, must differ from the new path (never delete what
// we just pointed the profile at), and must live inside this exact user's
// own folder (`${userId}/...`) - this function will never delete an
// arbitrary caller-supplied path outside that scope, even if called with
// unexpected input.
export async function deletePreviousAvatar(userId, previousAvatarPath, newAvatarPath) {
  if (!supabase || !userId || !previousAvatarPath) {
    return;
  }

  if (previousAvatarPath === newAvatarPath) {
    return;
  }

  if (!previousAvatarPath.startsWith(`${userId}/`)) {
    if (__DEV__) {
      console.warn('[Profile] Refusing to delete avatar outside the caller\'s own folder', {
        userId,
        previousAvatarPath,
      });
    }
    return;
  }

  try {
    const { error } = await supabase.storage.from(AVATAR_BUCKET).remove([previousAvatarPath]);

    if (error) {
      throw error;
    }

    if (__DEV__) {
      console.log('[Profile] Deleted previous avatar', { previousAvatarPath });
    }
  } catch (err) {
    if (__DEV__) {
      console.warn('[Profile] Failed to delete previous avatar (non-fatal)', {
        previousAvatarPath,
        message: err?.message,
      });
    }
  } finally {
    // Regardless of whether the object delete itself succeeded, nothing
    // should keep serving a signed URL for a path profiles.avatar_path no
    // longer references.
    invalidateAvatarUrlCache(previousAvatarPath);
  }
}

export async function getProfileAvatarSignedUrl(avatarPath, options = {}) {
  const { forceRefresh = false } = options;

  if (!supabase || !avatarPath) {
    return null;
  }

  if (!forceRefresh) {
    const cached = getCachedAvatarUrl(avatarPath);
    if (cached) {
      return cached;
    }

    const inflight = avatarUrlInflight.get(avatarPath);
    if (inflight) {
      return inflight;
    }
  }

  if (__DEV__) {
    console.log('[Profile] Avatar signed URL request start (cache miss)', avatarPath);
  }
  const startedAt = __DEV__ ? Date.now() : 0;

  const requestPromise = (async () => {
    const { data, error } = await supabase.storage
      .from(AVATAR_BUCKET)
      .createSignedUrl(avatarPath, AVATAR_SIGNED_URL_TTL_SECONDS);

    if (error) {
      // Never log the actual signed URL - only success/failure and the
      // storage path (already known to belong to this user).
      if (__DEV__) {
        console.warn('[Profile] Failed to create avatar signed URL', avatarPath, error.message, {
          elapsedMs: Date.now() - startedAt,
        });
      }
      throw error;
    }

    const url = data?.signedUrl || null;

    if (__DEV__) {
      console.log('[Profile] Avatar signed URL created', avatarPath, url ? 'ok' : 'empty', {
        elapsedMs: Date.now() - startedAt,
      });
    }

    if (url) {
      avatarUrlCache.set(avatarPath, {
        url,
        expiresAt: Date.now() + AVATAR_SIGNED_URL_TTL_SECONDS * 1000 - AVATAR_SIGNED_URL_REFRESH_MARGIN_MS,
      });
    }

    return url;
  })();

  avatarUrlInflight.set(avatarPath, requestPromise);

  try {
    return await requestPromise;
  } finally {
    avatarUrlInflight.delete(avatarPath);
  }
}
