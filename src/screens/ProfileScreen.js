import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import AppScreen from '../components/common/AppScreen';
import { useAuth } from '../context/AuthContext';
import { getProfile } from '../services/profileService';
import { colors, spacing, typography } from '../theme';

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

  const handleLogout = async () => {
    try {
      await signOut();
      router.replace('/(auth)/login');
    } catch (error) {
      console.warn('[Auth] Logout failed', error);
    }
  };

  useEffect(() => {
    let isActive = true;

    async function loadProfile() {
      if (!user?.id) {
        setProfile(null);
        setLoading(false);
        setError('');
        return;
      }

      try {
        setLoading(true);
        setError('');
        const data = await getProfile(user.id);
        if (isActive) {
          setProfile(data);
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
  }, [user?.id]);

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
              <Text style={styles.avatarText}>{avatarLetter}</Text>
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
          {accountActions.map((action) => (
            <Pressable key={action} style={styles.actionRow}>
              <Text style={styles.actionText}>{action}</Text>
            </Pressable>
          ))}
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
    shadowColor: colors.black,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
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
    shadowColor: colors.black,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.04,
    shadowRadius: 6,
    elevation: 2,
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
    fontSize: 20,
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
    shadowColor: colors.black,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.04,
    shadowRadius: 6,
    elevation: 2,
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
