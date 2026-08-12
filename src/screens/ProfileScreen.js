import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';

import AppScreen from '../components/common/AppScreen';
import { useAuth } from '../context/AuthContext';
import { getCachedAvatarUrl, getProfile, getProfileAvatarSignedUrl } from '../services/profileService';
import { colors, shadows, spacing, typography } from '../theme';

const accountActions = [
  'עריכת פרטים אישיים',
  'שינוי סיסמה',
  'עזרה ותמיכה',
];

export default function ProfileScreen() {
  const router = useRouter();
  const { signOut, user } = useAuth();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // status: 'loading' | 'none' | 'ready' | 'error'. Starts as 'loading' so the
  // avatar circle never falls back to the initial-letter placeholder while we
  // don't yet know whether this profile has an avatar_path — that fallback
  // is reserved for the 'none'/'error' states once we actually know.
  const [avatarState, setAvatarState] = useState({ status: 'loading', url: null });
  // Mirrors the URL currently shown on screen (only while status === 'ready').
  // Avatar uploads reuse the same storage path (upsert), so avatar_path
  // staying the same string does NOT mean the underlying image is
  // unchanged — only comparing against the URL we're actually displaying
  // does. Using a ref (not state) avoids a stale closure inside the
  // useFocusEffect callback below, which is only recreated when user?.id
  // changes.
  const currentAvatarUrlRef = useRef(null);

  const handleLogout = async () => {
    try {
      await signOut();
      router.replace('/(auth)/login');
    } catch (error) {
      console.warn('[Auth] Logout failed', error);
    }
  };

  useFocusEffect(
    useCallback(() => {
      let isActive = true;

      async function loadProfile() {
        if (!user?.id) {
          setProfile(null);
          setLoading(false);
          setError('');
          currentAvatarUrlRef.current = null;
          setAvatarState({ status: 'none', url: null });
          return;
        }

        try {
          setLoading(true);
          setError('');
          const data = await getProfile(user.id);
          if (isActive) {
            setProfile(data);
          }

          const avatarPath = data?.avatar_path || null;

          if (!avatarPath) {
            currentAvatarUrlRef.current = null;
            if (isActive) {
              setAvatarState({ status: 'none', url: null });
            }
          } else {
            // Always re-check the shared cache, even when avatar_path itself
            // is unchanged from before: avatar uploads use upsert against a
            // stable "<userId>/avatar.<ext>" path, so replacing the photo
            // does not change this string. uploadProfileAvatar() invalidates
            // the cache entry for that path on a successful upload, so a
            // fresh call here will correctly pick up the new signed URL
            // instead of never even looking (which was the bug: skipping
            // this check whenever the path string matched the previous one).
            const cachedUrl = getCachedAvatarUrl(avatarPath);

            if (cachedUrl) {
              if (cachedUrl !== currentAvatarUrlRef.current) {
                // Either the very first resolution, or the cache now holds a
                // newer URL than what's on screen (post-replacement) - swap
                // straight to it, no loading state needed since we already
                // have the value synchronously.
                currentAvatarUrlRef.current = cachedUrl;
                if (isActive) {
                  setAvatarState({ status: 'ready', url: cachedUrl });
                }
              }
              // else: identical to what's already displayed - no-op, avoids
              // any unnecessary re-render/flicker.
            } else {
              // Genuine cache miss: a brand-new avatar we've never resolved,
              // or an entry invalidated after a same-path replacement that
              // hasn't been re-populated yet. Only show the loading
              // placeholder if nothing valid is currently on screen -
              // otherwise keep the current avatar visible until the fresh
              // URL resolves, then swap directly.
              if (!currentAvatarUrlRef.current && isActive) {
                setAvatarState({ status: 'loading', url: null });
              }

              getProfileAvatarSignedUrl(avatarPath)
                .then((url) => {
                  if (isActive) {
                    if (url) {
                      currentAvatarUrlRef.current = url;
                      setAvatarState({ status: 'ready', url });
                    } else {
                      setAvatarState({ status: 'error', url: null });
                    }
                  }
                })
                .catch(() => {
                  if (isActive) {
                    setAvatarState({ status: 'error', url: null });
                  }
                });
            }
          }
        } catch (err) {
          if (isActive) {
            setError('לא הצלחנו לטעון את פרטי החשבון');
            setProfile(null);
          }
        } finally {
          if (isActive) {
            setLoading(false);
          }
        }
      }

      loadProfile();

      return () => {
        isActive = false;
      };
    }, [user?.id]),
  );

  const avatarLetter = (() => {
    const source = profile?.full_name || user?.user_metadata?.full_name || user?.email || 'G';
    const visible = String(source).trim();
    return visible ? visible[0] : 'G';
  })();

  return (
    <AppScreen backgroundColor={colors.background} contentContainerStyle={styles.screenContent}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>אזור אישי</Text>
          <Text style={styles.subtitle}>פרטי החשבון והפעילות שלך</Text>
        </View>

        <View style={styles.profileCard}>
          <View style={styles.avatarWrap}>
            <View style={styles.avatarCircle}>
              {avatarState.status === 'ready' && avatarState.url ? (
                <Image
                  source={{ uri: avatarState.url }}
                  style={styles.avatarImage}
                  resizeMode="cover"
                  fadeDuration={200}
                />
              ) : avatarState.status === 'loading' ? (
                <View style={styles.avatarLoadingWrap}>
                  <ActivityIndicator color={colors.primary} size="small" />
                </View>
              ) : (
                <Text style={styles.avatarText}>{avatarLetter}</Text>
              )}
            </View>
            <View style={styles.profileIdentity}>
              {loading ? (
                <View style={styles.loadingWrap}>
                  <ActivityIndicator color={colors.primary} size="small" />
                </View>
              ) : error ? (
                <Text style={styles.errorText}>{error}</Text>
              ) : (
                <>
                  <Text style={styles.profileName}>{profile?.full_name || 'לא הוגדר שם'}</Text>
                  <Text style={styles.profileRole}>{profile?.profession || 'לא הוגדר מקצוע'}</Text>
                </>
              )}
            </View>
          </View>

          <View style={styles.detailsList}>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>טלפון</Text>
              <Text style={styles.detailValue}>{profile?.phone || '—'}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>אימייל</Text>
              <Text style={styles.detailValue}>{user?.email || '—'}</Text>
            </View>
          </View>
        </View>

        <View style={styles.summaryCard}>
          <Text style={styles.sectionTitle}>סיכום החשבון</Text>
          {loading ? (
            <View style={styles.summaryLoading}>
              <ActivityIndicator color={colors.primary} size="small" />
            </View>
          ) : error ? (
            <View style={styles.summaryErrorWrap}>
              <Text style={styles.errorText}>{error}</Text>
              <Pressable onPress={() => user?.id && getProfile(user.id).then(setProfile).catch(() => setError('לא הצלחנו לטעון את פרטי החשבון'))}>
                <Text style={styles.retryText}>נסו שוב</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.summaryGrid}>
              <View style={styles.summaryItem}>
                <Text style={styles.summaryLabel}>יתרת נקודות</Text>
                <Text style={styles.summaryValue}>{profile?.points_balance ?? 0}</Text>
              </View>
              <View style={styles.summaryItem}>
                <Text style={styles.summaryLabel}>רכישות שאושרו</Text>
                <Text style={styles.summaryValue}>{profile?.approved_purchases_count ?? 0}</Text>
              </View>
            </View>
          )}
        </View>

        <View style={styles.actionsCard}>
          <Text style={styles.sectionTitle}>הגדרות וחשבון</Text>
          {accountActions.map((action) => {
            let onPress;
            if (action === 'עריכת פרטים אישיים') {
              onPress = () => router.push('/(tabs)/profile/edit');
            } else if (action === 'שינוי סיסמה') {
              onPress = () => router.push('/(tabs)/profile/change-password');
            } else if (action === 'עזרה ותמיכה') {
              onPress = () => router.push('/(tabs)/profile/help-support');
            }

            return (
              <Pressable key={action} style={styles.actionRow} onPress={onPress}>
                <Text style={styles.actionText}>{action}</Text>
              </Pressable>
            );
          })}
        </View>

        <Pressable style={styles.logoutButton} onPress={handleLogout}>
          <Text style={styles.logoutText}>התנתקות</Text>
        </Pressable>
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  screenContent: {
    justifyContent: 'flex-start',
    alignItems: 'stretch',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xl,
    paddingBottom: spacing.huge,
  },
  container: {
    width: '100%',
    gap: spacing.md,
  },
  header: {
    alignItems: 'flex-end',
  },
  title: {
    fontSize: typography.title.fontSize,
    fontWeight: typography.title.fontWeight,
    color: colors.text,
    textAlign: 'right',
  },
  subtitle: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: spacing.xs,
    lineHeight: 18,
  },
  profileCard: {
    backgroundColor: colors.white,
    borderRadius: 20,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.softCard,
  },
  avatarWrap: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.md,
  },
  avatarCircle: {
    width: 52,
    height: 52,
    borderRadius: 999,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: colors.primary,
  },
  avatarImage: {
    width: '100%',
    height: '100%',
  },
  avatarLoadingWrap: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.primary,
    textAlign: 'center',
  },
  profileIdentity: {
    flex: 1,
    alignItems: 'flex-end',
  },
  profileName: {
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  profileRole: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: 4,
  },
  loadingWrap: {
    minHeight: 40,
    justifyContent: 'center',
  },
  errorText: {
    fontSize: typography.caption.fontSize,
    fontWeight: '600',
    color: colors.error,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  summaryLoading: {
    minHeight: 64,
    justifyContent: 'center',
    alignItems: 'center',
  },
  summaryErrorWrap: {
    minHeight: 64,
    justifyContent: 'center',
    alignItems: 'flex-end',
    gap: spacing.sm,
  },
  retryText: {
    fontSize: typography.caption.fontSize,
    fontWeight: '600',
    color: colors.primary,
    textAlign: 'right',
  },
  detailsList: {
    marginTop: spacing.lg,
    gap: spacing.sm,
  },
  detailRow: {
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.surfaceMuted,
    alignItems: 'flex-end',
  },
  detailLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    textAlign: 'right',
  },
  detailValue: {
    fontSize: typography.caption.fontSize,
    fontWeight: '600',
    color: colors.text,
    textAlign: 'left',
    writingDirection: 'ltr',
    marginTop: 4,
  },
  summaryCard: {
    backgroundColor: colors.white,
    borderRadius: 16,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.softCard,
  },
  sectionTitle: {
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
    marginBottom: spacing.md,
  },
  summaryGrid: {
    flexDirection: 'row-reverse',
    gap: spacing.md,
  },
  summaryItem: {
    flex: 1,
    backgroundColor: colors.surfaceMuted,
    borderRadius: 14,
    padding: spacing.md,
    alignItems: 'flex-end',
  },
  summaryLabel: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
  },
  summaryValue: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.primary,
    textAlign: 'right',
    marginTop: 6,
  },
  actionsCard: {
    backgroundColor: colors.white,
    borderRadius: 16,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.softCard,
  },
  actionRow: {
    borderTopWidth: 1,
    borderTopColor: colors.surfaceMuted,
    paddingVertical: spacing.md,
    alignItems: 'flex-end',
  },
  actionText: {
    fontSize: typography.caption.fontSize,
    fontWeight: '600',
    color: colors.text,
    textAlign: 'right',
  },
  logoutButton: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: spacing.md,
    alignItems: 'center',
    backgroundColor: colors.white,
  },
  logoutText: {
    fontSize: typography.button.fontSize,
    fontWeight: typography.button.fontWeight,
    color: colors.textMuted,
    textAlign: 'center',
  },
});
