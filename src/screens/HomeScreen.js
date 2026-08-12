import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import AppScreen from '../components/common/AppScreen';
import { useAuth } from '../context/AuthContext';
import { getProfile } from '../services/profileService';
import { getMyPurchaseReports } from '../services/purchaseReportService';
import { colors, spacing, typography } from '../theme';

const quickActions = [
  {
    title: 'דיווח רכישה',
    subtitle: 'העלאת חשבונית חדשה',
    route: '/(tabs)/purchase',
  },
  {
    title: 'הטבות',
    subtitle: 'צפייה בהטבות שלך',
    route: '/(tabs)/rewards',
  },
];

export default function HomeScreen() {
  const { user } = useAuth();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reports, setReports] = useState([]);
  const [reportsLoading, setReportsLoading] = useState(true);
  const [reportsError, setReportsError] = useState('');

  useEffect(() => {
    let isMounted = true;

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

        if (!isMounted) {
          return;
        }

        setProfile(data);
      } catch (err) {
        if (!isMounted) {
          return;
        }

        setProfile(null);
        setError('לא הצלחנו לטעון את נתוני החשבון');
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    loadProfile();

    return () => {
      isMounted = false;
    };
  }, [user?.id]);

  useFocusEffect(
    useCallback(() => {
      let isActive = true;

      async function loadReports() {
        if (!user?.id) {
          setReports([]);
          setReportsLoading(false);
          setReportsError('');
          return;
        }

        try {
          setReportsLoading(true);
          setReportsError('');
          const data = await getMyPurchaseReports(user.id);

          if (isActive) {
            setReports(data);
          }
        } catch (err) {
          if (isActive) {
            setReports([]);
            setReportsError('לא הצלחנו לטעון את הפעילות האחרונה');
          }
        } finally {
          if (isActive) {
            setReportsLoading(false);
          }
        }
      }

      loadReports();

      return () => {
        isActive = false;
      };
    }, [user?.id]),
  );

  const firstName = (() => {
    const fullName = String(profile?.full_name || '').trim();

    if (!fullName) {
      return 'שלום';
    }

    const [name] = fullName.split(/\s+/);
    return name || 'שלום';
  })();

  const membershipLevel = String(profile?.membership_level || 'BRONZE').toUpperCase();
  const safeMembershipLevel = ['BRONZE', 'SILVER', 'GOLD'].includes(membershipLevel)
    ? membershipLevel
    : 'BRONZE';
  const pointsBalance = profile?.points_balance ?? 0;

  const formatNumber = (value) => {
    const numericValue = Number.isFinite(value) ? value : 0;
    return numericValue.toLocaleString('he-IL');
  };

  const formatReportDate = (value) => {
    const date = new Date(value);

    if (!value || Number.isNaN(date.getTime())) {
      return '';
    }

    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${day}.${month}.${year}`;
  };

  const getStatusMeta = (status) => {
    switch (status) {
      case 'processing':
        return { label: 'בעיבוד', backgroundColor: colors.primarySoft, textColor: colors.primary };
      case 'needs_review':
        return { label: 'נדרשת בדיקה', backgroundColor: colors.surfaceMuted, textColor: colors.textMuted };
      case 'approved':
        return { label: 'אושרה', backgroundColor: colors.successSoft, textColor: colors.success };
      case 'rejected':
        return { label: 'נדחתה', backgroundColor: colors.errorSoft, textColor: colors.error };
      case 'submitted':
      default:
        return { label: 'נשלחה לבדיקה', backgroundColor: colors.primarySoft, textColor: colors.primaryPressed };
    }
  };

  const recentReports = reports.slice(0, 3);

  return (
    <AppScreen
      backgroundColor={colors.background}
      contentContainerStyle={styles.screenContent}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.greeting}>{loading ? 'טוען...' : `שלום, ${firstName}`}</Text>
          <Text style={styles.title}>ברוכים הבאים ל +GOLDEN</Text>
          <Text style={styles.tagline}>מועדון המקצוענים של גולדן לייט</Text>
        </View>

        <View style={styles.heroCard}>
          <Text style={styles.heroLabel}>יתרת הנקודות שלך</Text>

          {loading ? (
            <View style={styles.loadingState}>
              <ActivityIndicator color={colors.primary} size="small" />
            </View>
          ) : error ? (
            <View style={styles.errorState}>
              <Text style={styles.errorText}>{error}</Text>
              <Pressable onPress={() => user?.id && getProfile(user.id).then(setProfile).catch(() => setError('לא הצלחנו לטעון את נתוני החשבון'))}>
                <Text style={styles.retryText}>נסו שוב</Text>
              </Pressable>
            </View>
          ) : (
            <>
              <View style={styles.pointsRow}>
                <Text style={styles.pointsValue}>{formatNumber(pointsBalance)}</Text>
                <Text style={styles.pointsUnit}>נק׳</Text>
              </View>
              <Text style={styles.heroMeta}>הטבות יופיעו בהמשך</Text>

              <View style={styles.levelRow}>
                <Text style={styles.levelBadge}>{safeMembershipLevel}</Text>
                <Text style={styles.levelMeta}>רמת החברות מעודכנת מהמערכת</Text>
              </View>

              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: '0%' }]} />
              </View>
            </>
          )}
        </View>

        <Text style={styles.sectionTitle}>פעולות מהירות</Text>
        <View style={styles.actionsRow}>
          {quickActions.map((action) => (
            <Pressable
              key={action.title}
              style={styles.actionCard}
              onPress={() => router.push(action.route)}>
              <View style={styles.actionAccent} />
              <Text style={styles.actionTitle}>{action.title}</Text>
              <Text style={styles.actionSubtitle}>{action.subtitle}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.sectionTitle}>פעילות אחרונה</Text>
        {reportsLoading ? (
          <View style={styles.activityCard}>
            <View style={styles.activityLoadingWrap}>
              <ActivityIndicator color={colors.primary} size="small" />
            </View>
          </View>
        ) : reportsError ? (
          <View style={styles.activityCard}>
            <View style={styles.activityInfo}>
              <Text style={styles.activityErrorText}>{reportsError}</Text>
              <Pressable
                onPress={() =>
                  user?.id &&
                  getMyPurchaseReports(user.id)
                    .then((data) => {
                      setReports(data);
                      setReportsError('');
                    })
                    .catch(() => setReportsError('לא הצלחנו לטעון את הפעילות האחרונה'))
                }>
                <Text style={styles.retryText}>נסו שוב</Text>
              </Pressable>
            </View>
          </View>
        ) : recentReports.length === 0 ? (
          <View style={styles.activityCard}>
            <View style={styles.activityInfo}>
              <Text style={styles.activityTitle}>אין פעילות אחרונה להצגה</Text>
              <Text style={styles.activitySubtitle}>הפעילות תופיע כאן לאחר אישורים חדשים</Text>
            </View>
          </View>
        ) : (
          <View style={styles.activityList}>
            {recentReports.map((report) => {
              const statusMeta = getStatusMeta(report.status);
              const showPoints = report.status === 'approved' && report.points_awarded > 0;

              return (
                <View key={report.id} style={styles.activityCard}>
                  <View style={styles.activityInfo}>
                    <Text style={styles.activityTitle} numberOfLines={1}>
                      {report.original_filename || 'חשבונית'}
                    </Text>
                    <Text style={styles.activitySubtitle}>{formatReportDate(report.created_at)}</Text>
                    {showPoints ? (
                      <Text style={styles.activityPoints}>{`+${formatNumber(report.points_awarded)} נק׳`}</Text>
                    ) : null}
                  </View>
                  <View style={[styles.statusBadge, { backgroundColor: statusMeta.backgroundColor }]}>
                    <Text style={[styles.statusBadgeText, { color: statusMeta.textColor }]}>{statusMeta.label}</Text>
                  </View>
                </View>
              );
            })}
          </View>
        )}
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
  },
  container: {
    width: '100%',
    gap: spacing.xl,
  },
  header: {
    alignItems: 'flex-end',
    paddingTop: spacing.xs,
  },
  greeting: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textMuted,
    textAlign: 'right',
    marginBottom: 2,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
    lineHeight: 28,
  },
  tagline: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: 4,
  },
  heroCard: {
    backgroundColor: colors.black,
    borderRadius: 24,
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.xxl,
    borderWidth: 1,
    borderColor: colors.primarySoft,
    shadowColor: colors.black,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.15,
    shadowRadius: 20,
    elevation: 4,
  },
  heroLabel: {
    fontSize: typography.caption.fontSize,
    fontWeight: '600',
    color: colors.surfaceElevated,
    textAlign: 'right',
    opacity: 0.8,
  },
  pointsRow: {
    flexDirection: 'row-reverse',
    alignItems: 'baseline',
    marginTop: spacing.sm,
    gap: spacing.xs,
  },
  pointsValue: {
    fontSize: 40,
    fontWeight: '700',
    color: colors.primary,
    textAlign: 'right',
    lineHeight: 42,
  },
  pointsUnit: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.surfaceElevated,
    lineHeight: 22,
    marginBottom: 1,
  },
  heroMeta: {
    marginTop: spacing.sm,
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.surfaceMuted,
    textAlign: 'right',
  },
  loadingState: {
    minHeight: 140,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: spacing.md,
  },
  errorState: {
    minHeight: 140,
    justifyContent: 'center',
    alignItems: 'flex-end',
    paddingVertical: spacing.md,
    gap: spacing.xs,
  },
  errorText: {
    fontSize: typography.caption.fontSize,
    fontWeight: '600',
    color: colors.surfaceMuted,
    textAlign: 'right',
  },
  retryText: {
    fontSize: typography.caption.fontSize,
    fontWeight: '700',
    color: colors.primary,
    textAlign: 'right',
  },
  levelRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
    paddingTop: spacing.xs,
  },
  levelBadge: {
    fontSize: typography.caption.fontSize,
    fontWeight: '700',
    color: colors.primary,
    textAlign: 'right',
    letterSpacing: 1.2,
  },
  levelMeta: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.surfaceMuted,
    textAlign: 'right',
  },
  progressTrack: {
    height: 8,
    borderRadius: 999,
    backgroundColor: '#2F3640',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: colors.primary,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
    marginBottom: spacing.xs,
  },
  actionsRow: {
    flexDirection: 'row-reverse',
    gap: spacing.md,
    alignItems: 'stretch',
  },
  actionCard: {
    flex: 1,
    backgroundColor: colors.white,
    borderRadius: 18,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: colors.black,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 10,
    elevation: 2,
    alignItems: 'flex-end',
    minHeight: 110,
    justifyContent: 'center',
  },
  actionAccent: {
    width: 30,
    height: 3,
    borderRadius: 999,
    backgroundColor: colors.primary,
    marginBottom: spacing.sm,
  },
  actionTitle: {
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  actionSubtitle: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: spacing.xs,
  },
  activityCard: {
    backgroundColor: colors.white,
    borderRadius: 18,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
    shadowColor: colors.black,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  activityInfo: {
    flex: 1,
    alignItems: 'flex-end',
  },
  activityTitle: {
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  activitySubtitle: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: spacing.xs,
  },
  activityList: {
    gap: spacing.md,
  },
  activityLoadingWrap: {
    minHeight: 64,
    justifyContent: 'center',
    alignItems: 'center',
  },
  activityErrorText: {
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.error,
    textAlign: 'right',
  },
  statusBadge: {
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    alignSelf: 'flex-start',
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'center',
  },
  activityPoints: {
    fontSize: typography.caption.fontSize,
    fontWeight: '700',
    color: colors.success,
    textAlign: 'right',
    marginTop: spacing.xs,
  },
  activityDate: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: spacing.xs,
  },
});
