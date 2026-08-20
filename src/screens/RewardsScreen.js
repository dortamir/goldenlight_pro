import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import AppScreen from '../components/common/AppScreen';
import PointsBalanceCard from '../components/common/PointsBalanceCard';
import PrimaryButton from '../components/common/PrimaryButton';
import { useAuth } from '../context/AuthContext';
import { getProfile } from '../services/profileService';
import { colors, radius, shadows, spacing, typography } from '../theme';
import { isolateLTR } from '../utils/bidiText';

const mockRewards = [
  {
    id: 1,
    title: `שובר ${isolateLTR('BUYME')} בסך ${isolateLTR('100 ₪')}`,
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
    title: `שובר ${isolateLTR('Golden Light')} בסך ${isolateLTR('200 ₪')}`,
    cost: 2000,
    category: isolateLTR('Golden Light'),
  },
];

const filters = ['הכל', 'שוברים', 'ציוד', isolateLTR('Golden Light')];

export default function RewardsScreen() {
  const { user } = useAuth();
  const [activeFilter, setActiveFilter] = useState('הכל');
  const [selectedRewardId, setSelectedRewardId] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [rootHeight, setRootHeight] = useState(0);
  const [heroHeight, setHeroHeight] = useState(0);

  // Same measured-minHeight approach as HomeScreen/ProfileScreen/
  // PurchaseScreen's dark hero + light sheet (see HomeScreen for the full
  // explanation) - guarantees the light sheet reaches the bottom of the
  // real screen regardless of the flex-grow chain between here and the
  // ScrollView.
  const onRootLayout = useCallback((event) => {
    setRootHeight(event.nativeEvent.layout.height);
  }, []);
  const onHeroLayout = useCallback((event) => {
    setHeroHeight(event.nativeEvent.layout.height);
  }, []);
  const sheetMinHeight =
    rootHeight > 0 && heroHeight > 0 ? rootHeight - heroHeight + radius.xl : undefined;

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
    return { isAvailable, message: `חסרות ${isolateLTR(missing)} נק׳` };
  };

  const visibleRewards = useMemo(() => {
    if (activeFilter === 'הכל') {
      return mockRewards;
    }

    return mockRewards.filter((reward) => reward.category === activeFilter);
  }, [activeFilter]);

  return (
    <View style={styles.root} onLayout={onRootLayout}>
      {/* Full-bleed dark hero, same technique/tokens as HomeScreen/
          ProfileScreen/PurchaseScreen's own hero (see HomeScreen for the
          full explanation) - keeps every premium dark surface visually
          identical across screens. */}
      <LinearGradient
        colors={[colors.bgDark, colors.charcoal]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={styles.heroGradient}
      />

      <AppScreen
        backgroundColor="transparent"
        contentContainerStyle={styles.screenContent}
        style={styles.screenInner}
        // No bottom edge - same reasoning as the other tab screens (nested
        // under the (tabs) bottom bar, which already provides its own
        // clearance).
        edges={['top', 'left', 'right']}>
        <View style={styles.heroSection} onLayout={onHeroLayout}>
          <View style={styles.heroInner}>
            <Text style={styles.title}>הטבות</Text>
            <Text style={styles.subtitle}>ממשו את הנקודות שלכם להטבות ומתנות</Text>

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
              style={styles.pointsCard}
            />
          </View>
        </View>

        {/* Light content sheet - same full-bleed/rounded-top/measured-
            minHeight pattern as HomeScreen/ProfileScreen/PurchaseScreen's
            own sheet. */}
        <View style={[styles.sheet, sheetMinHeight ? { minHeight: sheetMinHeight } : null]}>
          <View style={styles.sheetInner}>
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

            <View style={styles.section}>
              <View style={styles.sectionHeaderRow}>
                <View style={styles.sectionHeadingGroup}>
                  <Text style={styles.sectionTitle}>הטבות זמינות</Text>
                  <View style={styles.sectionAccentDot} />
                </View>
              </View>

              {visibleRewards.length === 0 ? (
                <View style={styles.emptyState}>
                  <Text style={styles.emptyStateText}>אין הטבות להצגה בקטגוריה זו</Text>
                </View>
              ) : (
                <View style={styles.rewardsList}>
                  {visibleRewards.map((reward) => {
                    const isSelected = selectedRewardId === reward.id;
                    const { isAvailable, message: unavailableMessage } = getAvailability(reward);

                    return (
                      <View
                        key={reward.id}
                        style={[styles.rewardCard, !isAvailable && styles.rewardCardLocked]}>
                        <View style={styles.rewardHeader}>
                          <Text style={styles.rewardCategory}>{reward.category}</Text>
                          <Text style={styles.rewardTitle}>{reward.title}</Text>
                          <View style={styles.rewardCostPill}>
                            <Text style={styles.rewardCostText}>{`${isolateLTR(reward.cost.toLocaleString('he-IL'))} נק׳`}</Text>
                          </View>
                        </View>

                        {isSelected ? (
                          <View style={styles.selectedState}>
                            <Text style={styles.selectedTitle}>ההטבה נבחרה למימוש</Text>
                            <Text style={styles.selectedText}>קוד המימוש יוצג כאן לאחר חיבור המערכת</Text>
                          </View>
                        ) : null}

                        {isAvailable ? (
                          <PrimaryButton
                            title="מימוש ההטבה"
                            onPress={() => setSelectedRewardId(reward.id)}
                            style={styles.actionButton}
                          />
                        ) : (
                          <View style={styles.disabledBox}>
                            <Ionicons name="lock-closed-outline" size={14} color={colors.textMuted} />
                            <Text style={styles.disabledText}>{unavailableMessage}</Text>
                          </View>
                        )}
                      </View>
                    );
                  })}
                </View>
              )}
            </View>
          </View>
        </View>
      </AppScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  heroGradient: {
    ...StyleSheet.absoluteFillObject,
  },
  // Same cancel-AppScreen's-own-wrapper technique as HomeScreen/
  // ProfileScreen/PurchaseScreen (see HomeScreen's screenInner comment for
  // the full flex-chain explanation).
  screenInner: {
    flex: 1,
    width: '100%',
    maxWidth: '100%',
    alignSelf: 'stretch',
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  screenContent: {
    flexGrow: 1,
  },
  heroSection: {
    paddingTop: spacing.sm,
    // Extra bottom padding absorbs the sheet's negative marginTop overlap
    // below (see `sheet`), so the rounded corners never cut into the
    // points card.
    paddingBottom: spacing.xxl + radius.xl,
  },
  heroInner: {
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    alignItems: 'flex-end',
  },
  title: {
    fontSize: typography.title.fontSize,
    fontWeight: typography.title.fontWeight,
    color: colors.textOnDark,
    textAlign: 'right',
  },
  subtitle: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.mutedOnDark,
    textAlign: 'right',
    marginTop: spacing.xs,
    lineHeight: 18,
  },
  pointsCard: {
    width: '100%',
    marginTop: spacing.xl,
  },
  sheet: {
    flex: 1,
    backgroundColor: colors.background,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    marginTop: -radius.xl,
  },
  sheetInner: {
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xl,
    paddingBottom: spacing.xxl,
    gap: spacing.lg,
  },
  filterRow: {
    flexDirection: 'row-reverse',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  filterChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: radius.pill,
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
  section: {
    gap: spacing.md,
  },
  sectionHeaderRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
  },
  sectionHeadingGroup: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.xs,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    lineHeight: 24,
    color: colors.text,
    textAlign: 'right',
  },
  sectionAccentDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.primary,
  },
  rewardsList: {
    gap: spacing.md,
  },
  rewardCard: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.softCard,
  },
  // Not-eligible rewards read as quietly muted rather than a fully separate
  // treatment - a softer border only, no opacity dip on the whole card
  // (which would also fade the real point-cost text), keeping the
  // disabledBox below as the one clear "locked" signal.
  rewardCardLocked: {
    borderColor: colors.border,
    shadowOpacity: 0,
    elevation: 0,
  },
  rewardHeader: {
    alignItems: 'flex-end',
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
    marginTop: 4,
  },
  // Compact turquoise pill instead of plain muted text - easy to scan at a
  // glance, matching PurchaseScreen's receiptStatusPill treatment.
  rewardCostPill: {
    marginTop: spacing.sm,
    alignSelf: 'flex-end',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    backgroundColor: colors.primarySoft,
  },
  rewardCostText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.primaryPressed,
    textAlign: 'center',
  },
  selectedState: {
    marginTop: spacing.md,
    backgroundColor: colors.primarySoft,
    borderRadius: radius.md,
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
    marginTop: spacing.md,
  },
  disabledBox: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    marginTop: spacing.md,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
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
  emptyState: {
    minHeight: 96,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  emptyStateText: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'center',
  },
});
