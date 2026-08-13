import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import AppScreen from '../components/common/AppScreen';
import PointsBalanceCard from '../components/common/PointsBalanceCard';
import { useAuth } from '../context/AuthContext';
import { getProfile } from '../services/profileService';
import { colors, shadows, spacing, typography } from '../theme';

const mockRewards = [
  {
    id: 1,
    title: 'שובר BUYME בסך 100 ₪',
    cost: 1000,
    category: 'שובר מתנה',
  },
  {
    id: 2,
    title: 'ערכת כלי עבודה מקצועית',
    cost: 1500,
    category: 'ציוד מקצועי',
  },
  {
    id: 3,
    title: 'שובר Golden Light בסך 200 ₪',
    cost: 2000,
    category: 'Golden Light',
  },
];

const filters = ['הכל', 'שוברים', 'ציוד', 'Golden Light'];

export default function RewardsScreen() {
  const { user } = useAuth();
  const [activeFilter, setActiveFilter] = useState('הכל');
  const [selectedRewardId, setSelectedRewardId] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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
          setProfile(null);
          setError('לא הצלחנו לטעון את יתרת הנקודות');
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

  const pointsBalance = profile?.points_balance ?? 0;

  const formatNumber = (value) => {
    const numericValue = Number.isFinite(value) ? value : 0;
    return numericValue.toLocaleString('he-IL');
  };

  const getAvailability = (reward) => {
    if (loading) {
      return { isAvailable: false, message: 'טוען יתרה...' };
    }

    if (error) {
      return { isAvailable: false, message: 'לא ניתן לבדוק זמינות' };
    }

    const isAvailable = pointsBalance >= reward.cost;
    const missing = formatNumber(Math.max(reward.cost - pointsBalance, 0));
    return { isAvailable, message: `חסרות ${missing} נק׳` };
  };

  const visibleRewards = useMemo(() => {
    if (activeFilter === 'הכל') {
      return mockRewards;
    }

    return mockRewards.filter((reward) => reward.category === activeFilter);
  }, [activeFilter]);

  return (
    <AppScreen backgroundColor={colors.background} contentContainerStyle={styles.screenContent}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>הטבות</Text>
          <Text style={styles.subtitle}>ממשו את הנקודות שלכם להטבות ומתנות</Text>
        </View>

        <PointsBalanceCard
          pointsBalance={pointsBalance}
          meta="זמינות למימוש"
          loading={loading}
          error={error}
          onRetry={() =>
            user?.id &&
            getProfile(user.id)
              .then((data) => {
                setProfile(data);
                setError('');
              })
              .catch(() => setError('לא הצלחנו לטעון את יתרת הנקודות'))
          }
        />

        <View style={styles.filterRow}>
          {filters.map((filter) => {
            const active = filter === activeFilter;
            return (
              <Pressable
                key={filter}
                style={[styles.filterChip, active && styles.filterChipActive]}
                onPress={() => setActiveFilter(filter)}>
                <Text style={[styles.filterText, active && styles.filterTextActive]}>{filter}</Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={styles.sectionTitle}>הטבות זמינות</Text>

        {visibleRewards.map((reward) => {
          const isSelected = selectedRewardId === reward.id;
          const { isAvailable, message: unavailableMessage } = getAvailability(reward);

          return (
            <View key={reward.id} style={styles.rewardCard}>
              <View style={styles.rewardHeader}>
                <Text style={styles.rewardCategory}>{reward.category}</Text>
                {reward.title.includes('BUYME') ? (
                  <View style={styles.titleWrap}>
                    <Text style={styles.rewardTitle}>שובר</Text>
                    <Text style={styles.rewardTitleInline}>BUYME</Text>
                    <Text style={styles.rewardTitle}>בסך 100 ₪</Text>
                  </View>
                ) : reward.title.includes('Golden Light') ? (
                  <View style={styles.titleWrap}>
                    <Text style={styles.rewardTitle}>שובר</Text>
                    <Text style={styles.rewardTitleInline}>Golden Light</Text>
                    <Text style={styles.rewardTitle}>בסך 200 ₪</Text>
                  </View>
                ) : (
                  <Text style={styles.rewardTitle}>{reward.title}</Text>
                )}
                <View style={styles.rewardCostRow}>
                  <Text style={styles.rewardCost}>{reward.cost.toLocaleString('he-IL')} נק׳</Text>
                </View>
              </View>

              {isSelected ? (
                <View style={styles.selectedState}>
                  <Text style={styles.selectedTitle}>ההטבה נבחרה למימוש</Text>
                  <Text style={styles.selectedText}>קוד המימוש יוצג כאן לאחר חיבור המערכת</Text>
                </View>
              ) : null}

              {isAvailable ? (
                <Pressable
                  style={styles.actionButton}
                  onPress={() => setSelectedRewardId(reward.id)}>
                  <Text style={styles.actionButtonText}>מימוש ההטבה</Text>
                </Pressable>
              ) : (
                <View style={styles.disabledBox}>
                  <Text style={styles.disabledText}>{unavailableMessage}</Text>
                </View>
              )}
            </View>
          );
        })}
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
    paddingBottom: 2,
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
  filterRow: {
    flexDirection: 'row-reverse',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: 2,
  },
  filterChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.border,
    minHeight: 34,
    justifyContent: 'center',
  },
  filterChipActive: {
    backgroundColor: colors.primarySoft,
    borderColor: colors.primary,
  },
  filterText: {
    fontSize: typography.caption.fontSize,
    fontWeight: '600',
    color: colors.textMuted,
    textAlign: 'right',
  },
  filterTextActive: {
    color: colors.primary,
  },
  sectionTitle: {
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
    marginTop: spacing.xs,
  },
  rewardCard: {
    backgroundColor: colors.white,
    borderRadius: 16,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.softCard,
  },
  rewardHeader: {
    alignItems: 'flex-end',
  },
  titleWrap: {
    flexDirection: 'row-reverse',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    alignItems: 'baseline',
    marginTop: 4,
  },
  rewardCategory: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.primary,
    textAlign: 'right',
    letterSpacing: 0.3,
  },
  rewardTitle: {
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  rewardTitleInline: {
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
    marginHorizontal: 4,
  },
  rewardCostRow: {
    marginTop: 4,
    alignItems: 'flex-end',
  },
  rewardCost: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
  },
  selectedState: {
    marginTop: spacing.sm,
    backgroundColor: colors.primarySoft,
    borderRadius: 12,
    padding: spacing.md,
  },
  selectedTitle: {
    fontSize: typography.caption.fontSize,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  selectedText: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: 4,
  },
  actionButton: {
    marginTop: spacing.sm,
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: spacing.md,
    alignItems: 'center',
    shadowColor: colors.primaryPressed,
    shadowOpacity: 0.2,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 3,
  },
  actionButtonText: {
    fontSize: typography.button.fontSize,
    fontWeight: typography.button.fontWeight,
    color: colors.black,
    textAlign: 'center',
  },
  disabledBox: {
    marginTop: spacing.sm,
    borderRadius: 12,
    paddingVertical: spacing.md,
    alignItems: 'center',
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.border,
  },
  disabledText: {
    fontSize: typography.caption.fontSize,
    fontWeight: '600',
    color: colors.textMuted,
    textAlign: 'center',
  },
});
