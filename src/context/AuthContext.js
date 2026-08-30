import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import * as Linking from 'expo-linking';

import { isCurrentUserAdmin } from '../services/adminService';
import { clearAvatarUrlCache, clearProfileCache } from '../services/profileService';
import { clearReceiptUrlCache } from '../services/purchaseReportService';
import { supabase } from '../services/supabase';

const AuthContext = createContext(null);

// Parses a Supabase auth callback URL (the password-recovery email link,
// opened either as a web page load or a goldenlightpro:// deep link) for
// the pieces this app cares about. Supabase places these in the URL
// fragment (#...) for the implicit grant flow used here - never in a way
// that requires a PKCE code verifier, which would break links opened on a
// different device/browser than the one that requested them, a common case
// for password recovery emails. Tokens are read once and never logged.
function parseAuthCallbackUrl(url) {
  if (!url) {
    return null;
  }

  const hashIndex = url.indexOf('#');
  const queryIndex = url.indexOf('?');
  const fragment = hashIndex >= 0 ? url.slice(hashIndex + 1) : '';
  const queryEnd = hashIndex >= 0 ? hashIndex : url.length;
  const query = queryIndex >= 0 && queryIndex < queryEnd ? url.slice(queryIndex + 1, queryEnd) : '';

  const params = new URLSearchParams(fragment || query);
  if ([...params.keys()].length === 0) {
    return null;
  }

  return {
    type: params.get('type'),
    accessToken: params.get('access_token'),
    refreshToken: params.get('refresh_token'),
    errorCode: params.get('error_code') || params.get('error'),
  };
}

// Strips a recovery callback's fragment/query (tokens or error params) from
// the visible web URL as soon as it has been read, so a hard refresh never
// re-delivers the same tokens or error state. Only ever touches the
// fragment/query - never the pathname - so it cannot change which Expo
// Router route is showing. No-op on native (no window/history there) and
// swallows any failure - this is a hygiene step, never required for
// correctness.
function cleanRecoveryParamsFromUrl() {
  try {
    if (typeof globalThis !== 'undefined' && globalThis.window?.history?.replaceState) {
      const { pathname, search } = globalThis.window.location;
      globalThis.window.history.replaceState(null, '', pathname + search);
    }
  } catch {
    // Cosmetic only - safe to ignore.
  }
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  // True once a password-recovery link has been opened and its recovery
  // session established - see the deep-link effect below. Distinct from a
  // normal SIGNED_IN session so route guards (app/(auth)/_layout.js) can
  // keep a recovering user on the reset-password screen instead of bouncing
  // them into the authenticated app, without weakening normal auth
  // protection for everyone else.
  const [passwordRecovery, setPasswordRecovery] = useState(false);
  // True when a recovery link arrives with an error (expired/invalid/
  // already used) rather than valid tokens - lets ResetPasswordScreen show
  // a safe message instead of a broken form.
  const [recoveryError, setRecoveryError] = useState(false);
  // STAGE 17: the app's ONE resolved admin_users check, shared by
  // app/index.js's routing decision and app/admin/_layout.js's own route
  // guard - see the effect below. `isAdmin` defaults false (fail closed);
  // `adminLoading` defaults true so a route decision never assumes
  // "not admin" before this has actually resolved at least once. This is
  // still a UI-only convenience, exactly like the existing
  // isCurrentUserAdmin() it wraps - it decides where the app NAVIGATES a
  // user, never what a database write is allowed to do. Every privileged
  // admin mutation remains independently enforced by its own RLS policy/
  // SECURITY DEFINER RPC (is_admin()), regardless of this value.
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminLoading, setAdminLoading] = useState(true);
  // Idempotency guard for the recovery deep-link effect below: remembers
  // the exact callback URL already processed during this AuthProvider's
  // lifetime, so the same URL is never handled twice (React dev-mode
  // StrictMode double effect invocation, an accidental remount/re-entry, or
  // getInitialURL() and the 'url' event both delivering the same URL).
  const processedRecoveryUrlRef = useRef(null);

  useEffect(() => {
    let isMounted = true;

    async function initializeSession() {
      if (__DEV__) {
        console.log('[Auth] Initialization started');
      }

      if (!supabase) {
        if (isMounted) {
          setLoading(false);
        }
        return;
      }

      try {
        const { data: { session: currentSession }, error } = await supabase.auth.getSession();

        if (!isMounted) {
          return;
        }

        if (error && __DEV__) {
          console.warn('[Auth] Failed to restore session', error.message);
        }

        if (__DEV__) {
          console.log('[Auth] getSession resolved', { hasSession: Boolean(currentSession) });
        }

        setSession(currentSession);
        setUser(currentSession?.user ?? null);
      } catch (error) {
        if (isMounted && __DEV__) {
          console.warn('[Auth] Session restoration failed', { code: error?.code, message: error?.message });
        }
      }

      // STAGE 15.2: `loading` only flips to `false` from inside this
      // subscription callback now - never from a separate, earlier
      // synchronous call right after `getSession()` above resolves (the
      // previous behavior). `getSession()`'s own snapshot and this
      // subscription are two different signals from the same underlying
      // auth client; supabase-js guarantees this callback fires at least
      // once on startup (the documented `INITIAL_SESSION` event, "emitted
      // right after the Supabase client is constructed and the initial
      // session from storage is loaded"), so waiting for it - rather than
      // for `getSession()`'s own resolution - is a strictly more
      // conservative readiness signal for "this app's authenticated
      // requests are now safe to fire," without any arbitrary delay: it
      // still resolves as soon as the underlying client is actually ready,
      // never later than that. HomeScreen/ProfileScreen/PurchaseHistoryScreen
      // never fire their own first authenticated request until `loading`
      // (from this same AuthContext) is false, via the routing guards in
      // app/index.js and app/(tabs)/_layout.js - so this directly narrows
      // the cold-start window in which a data fetch could race ahead of the
      // auth client's own confirmed-ready state.
      const { data: { subscription } } = supabase.auth.onAuthStateChange((event, nextSession) => {
        if (!isMounted) {
          return;
        }

        if (__DEV__) {
          console.log('[Auth] onAuthStateChange fired', { event, hasSession: Boolean(nextSession) });
        }

        // Supabase's own PASSWORD_RECOVERY event only fires from its
        // browser-only automatic URL detection, which this client has
        // disabled (detectSessionInUrl: false - see services/supabase.js);
        // the deep-link effect below is this app's actual, cross-platform
        // mechanism for entering recovery mode. This branch is kept as a
        // defensive no-op-if-unused handler in case that event is ever
        // emitted by another path, so it is never silently mishandled as an
        // ordinary sign-in.
        if (event === 'PASSWORD_RECOVERY') {
          setPasswordRecovery(true);
        } else if (event === 'SIGNED_OUT') {
          setPasswordRecovery(false);
          setRecoveryError(false);
        }

        setSession(nextSession);
        setUser(nextSession?.user ?? null);
        setLoading(false);

        if (__DEV__) {
          console.log('[Auth] Initialization complete - loading=false');
        }
      });

      return () => subscription.unsubscribe();
    }

    const cleanupPromise = initializeSession();

    return () => {
      isMounted = false;
      cleanupPromise?.then((cleanup) => cleanup?.());
    };
  }, []);

  // STAGE 17: resolves the admin_users check exactly ONCE per user/session,
  // replacing the separate isCurrentUserAdmin() call that used to live only
  // inside app/admin/_layout.js - that screen now reads isAdmin/adminLoading
  // from context instead of re-fetching the same row itself (see that
  // file). Waits for `loading` (auth) to settle first, so this never fires
  // against a not-yet-confirmed session. Keyed on `user?.id` (not the whole
  // user/session object) for the same reason the main auth effect's own
  // comment gives elsewhere in this file - a token refresh must not
  // re-trigger this. isCurrentUserAdmin() already fails closed internally
  // (any error, including no Supabase client, resolves to `false`, never
  // throws) - see adminService.js - so there is no separate error branch
  // to handle here; a lookup failure simply resolves isAdmin to `false`,
  // same as a genuine non-admin.
  useEffect(() => {
    let isActive = true;

    if (loading) {
      return undefined;
    }

    if (!user) {
      setIsAdmin(false);
      setAdminLoading(false);
      return undefined;
    }

    setAdminLoading(true);

    isCurrentUserAdmin().then((admin) => {
      if (isActive) {
        setIsAdmin(admin);
        setAdminLoading(false);
      }
    });

    return () => {
      isActive = false;
    };
  }, [loading, user?.id]);

  // Password-recovery deep-link handling. Works identically on web (the
  // recovery link opens a normal page load, whose full URL - including the
  // #access_token=...&type=recovery fragment Supabase appends - is read via
  // Linking.getInitialURL()) and on native (the same link, opened as a
  // goldenlightpro:// deep link, is delivered the same way). This is
  // deliberately independent of supabase-js's own automatic URL detection
  // (which only exists on web and is disabled here) so recovery works the
  // same way on every platform this app runs on.
  useEffect(() => {
    let isMounted = true;

    async function handleAuthCallbackUrl(url) {
      const parsed = parseAuthCallbackUrl(url);
      if (!parsed || !supabase) {
        return;
      }

      const isRecoveryTokens = parsed.type === 'recovery' && parsed.accessToken && parsed.refreshToken;
      const isRecoveryError = Boolean(parsed.errorCode);

      if (!isRecoveryTokens && !isRecoveryError) {
        return;
      }

      // Idempotency guard: never process the exact same callback URL twice
      // during this AuthProvider's lifetime.
      if (processedRecoveryUrlRef.current === url) {
        return;
      }
      processedRecoveryUrlRef.current = url;

      // Strip the recovery tokens/error params from the visible URL as
      // early as possible - before any async work - so a hard refresh can
      // never re-deliver the same tokens or error state. Applies to both
      // the success and error cases; only the fragment/query is touched,
      // never the pathname/route.
      cleanRecoveryParamsFromUrl();

      if (isRecoveryTokens) {
        const { error } = await supabase.auth.setSession({
          access_token: parsed.accessToken,
          refresh_token: parsed.refreshToken,
        });

        if (!isMounted) {
          return;
        }

        if (error) {
          // Never log the tokens themselves - only a safe error code/message.
          if (__DEV__) {
            console.warn('[Auth] Failed to establish password recovery session', {
              code: error.code,
              message: error.message,
            });
          }
          setRecoveryError(true);
          return;
        }

        // session/user are deliberately NOT set here - this setSession()
        // call is also observed by the onAuthStateChange subscriber above,
        // which is the single source of truth for session/user. Updating
        // them here too would double every state update (and the resulting
        // full-tree context re-render) for no benefit.
        setPasswordRecovery(true);
        setRecoveryError(false);
        return;
      }

      setRecoveryError(true);
    }

    Linking.getInitialURL().then((url) => {
      if (isMounted && url) {
        handleAuthCallbackUrl(url);
      }
    });

    const subscription = Linking.addEventListener('url', ({ url }) => {
      handleAuthCallbackUrl(url);
    });

    return () => {
      isMounted = false;
      subscription.remove();
    };
  }, []);

  const clearPasswordRecovery = () => {
    setPasswordRecovery(false);
    setRecoveryError(false);
  };

  const signIn = async (email, password) => {
    if (!supabase) {
      throw new Error('Supabase is not configured.');
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      throw error;
    }

    setSession(data.session);
    setUser(data.user);
    // A normal, explicit sign-in is never a recovery session, even if this
    // browser previously had passwordRecovery/recoveryError set from an
    // earlier, abandoned recovery link - without this, app/(auth)/_layout.js
    // could still treat this freshly-signed-in user as "in recovery" and
    // redirect them to reset-password instead of the app.
    setPasswordRecovery(false);
    setRecoveryError(false);
    return data;
  };

  const signUp = async ({ email, password, fullName, phone, profession }) => {
    if (!supabase) {
      throw new Error('Supabase is not configured.');
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
          phone,
          profession,
        },
      },
    });

    if (error) {
      throw error;
    }

    setSession(data.session);
    setUser(data.user);
    // Same reasoning as signIn() above - a fresh registration is never a
    // recovery session.
    setPasswordRecovery(false);
    setRecoveryError(false);
    return data;
  };

  const signOut = async () => {
    if (!supabase) {
      return;
    }

    const { error } = await supabase.auth.signOut();

    if (error) {
      throw error;
    }

    // STAGE 15.1: drop every cached receipt/avatar signed URL - both caches
    // are already namespaced per-user by storage path (see
    // purchaseReportService.js's receiptUrlCache / profileService.js's
    // avatarUrlCache), so this isn't the only thing preventing one user's
    // cached image from being served under another - but a different user
    // signing in on the same device afterward should still start with a
    // clean slate rather than carrying process-memory state from the
    // previous session indefinitely.
    clearReceiptUrlCache();
    clearAvatarUrlCache();
    clearProfileCache();

    setSession(null);
    setUser(null);
    setPasswordRecovery(false);
    setRecoveryError(false);
    // STAGE 17: explicit reset (defense in depth - the admin-resolution
    // effect above would also reset these once `user` becomes null, since
    // it's keyed on user?.id, but setting them directly here removes any
    // dependency on effect-scheduling timing for "no cross-user role
    // leakage"). false/false, not false/true - "no user" is a resolved,
    // definite "not admin", not a still-loading state.
    setIsAdmin(false);
    setAdminLoading(false);
  };

  const value = useMemo(
    () => ({
      session,
      user,
      loading,
      isAdmin,
      adminLoading,
      passwordRecovery,
      recoveryError,
      signIn,
      signUp,
      signOut,
      clearPasswordRecovery,
    }),
    [loading, isAdmin, adminLoading, passwordRecovery, recoveryError, session, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
