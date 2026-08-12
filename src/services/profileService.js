import { Platform } from 'react-native';

import { supabase } from './supabase';

const PROFILE_COLUMNS =
  'id, full_name, phone, profession, avatar_path, points_balance, membership_level, approved_purchases_count, created_at, updated_at';

const AVATAR_BUCKET = 'profile-avatars';
const AVATAR_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];

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

export async function getProfile(userId) {
  if (!supabase || !userId) {
    throw new Error('Profile not available');
  }

  const { data, error } = await supabase
    .from('profiles')
    .select(PROFILE_COLUMNS)
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
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

  const { data, error } = await supabase
    .from('profiles')
    .update(payload)
    .eq('id', userId)
    .select(PROFILE_COLUMNS)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
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

async function createAvatarUploadPayload(asset, mimeType, fileName) {
  if (Platform.OS === 'web') {
    const response = await fetch(asset.uri);
    const blob = await response.blob();
    return new File([blob], fileName, { type: mimeType });
  }

  return {
    uri: asset.uri,
    name: fileName,
    type: mimeType,
  };
}

export async function uploadProfileAvatar(userId, asset) {
  if (!supabase || !userId || !asset?.uri) {
    throw new Error('Avatar upload is not available.');
  }

  const mimeType = asset.mimeType || asset.type || 'image/jpeg';
  const extension = getAvatarExtension(mimeType);
  const fileName = `avatar.${extension}`;
  const storagePath = `${userId}/${fileName}`;
  const uploadPayload = await createAvatarUploadPayload(asset, mimeType, fileName);

  const { error: uploadError } = await supabase.storage
    .from(AVATAR_BUCKET)
    .upload(storagePath, uploadPayload, {
      contentType: mimeType,
      upsert: true,
    });

  if (uploadError) {
    throw uploadError;
  }

  // Each user has exactly one current avatar. Since the object path is keyed
  // by file extension, replacing a .png avatar with a .jpg one (for example)
  // would otherwise leave the old file behind. Best-effort clean up any
  // other supported-extension avatar files for this user so they don't
  // accumulate; this is non-fatal if it fails.
  const staleExtensions = AVATAR_EXTENSIONS.filter((ext) => ext !== extension);
  if (staleExtensions.length > 0) {
    try {
      await supabase.storage
        .from(AVATAR_BUCKET)
        .remove(staleExtensions.map((ext) => `${userId}/avatar.${ext}`));
    } catch (cleanupError) {
      if (__DEV__) {
        console.warn('[Profile] Failed to clean up stale avatar files', cleanupError);
      }
    }

    staleExtensions.forEach((ext) => invalidateAvatarUrlCache(`${userId}/avatar.${ext}`));
  }

  // The upload above may have used `upsert: true` against the SAME path as
  // before (e.g. replacing userId/avatar.jpg with a new photo). The path
  // string is unchanged, but the bytes behind it are not, so any cached
  // signed URL for this path must be dropped here rather than left to
  // expire naturally - otherwise the UI could keep showing (or re-resolve to
  // display) the previous photo's content via a technically-still-valid URL.
  invalidateAvatarUrlCache(storagePath);

  return storagePath;
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

  const requestPromise = (async () => {
    const { data, error } = await supabase.storage
      .from(AVATAR_BUCKET)
      .createSignedUrl(avatarPath, AVATAR_SIGNED_URL_TTL_SECONDS);

    if (error) {
      throw error;
    }

    const url = data?.signedUrl || null;

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
