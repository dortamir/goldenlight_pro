import { createContext, useContext, useEffect, useMemo, useState } from 'react';

import { supabase } from '../services/supabase';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    async function initializeSession() {
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

        if (error) {
          console.warn('[Auth] Failed to restore session', error.message);
        }

        setSession(currentSession);
        setUser(currentSession?.user ?? null);
      } catch (error) {
        if (isMounted) {
          console.warn('[Auth] Session restoration failed', error);
        }
      }

      const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
        if (!isMounted) {
          return;
        }

        setSession(nextSession);
        setUser(nextSession?.user ?? null);
        setLoading(false);
      });

      if (isMounted) {
        setLoading(false);
      }

      return () => subscription.unsubscribe();
    }

    const cleanupPromise = initializeSession();

    return () => {
      isMounted = false;
      cleanupPromise?.then((cleanup) => cleanup?.());
    };
  }, []);

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

    setSession(null);
    setUser(null);
  };

  const value = useMemo(
    () => ({
      session,
      user,
      loading,
      signIn,
      signUp,
      signOut,
    }),
    [loading, session, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
