import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import AppScreen from '../components/common/AppScreen';
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
  return (
    <AppScreen
      backgroundColor={colors.background}
      contentContainerStyle={styles.screenContent}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.greeting}>שלום, ישראל</Text>
          <Text style={styles.title}>ברוכים הבאים ל +GOLDEN</Text>
          <Text style={styles.tagline}>מועדון המקצוענים של גולדן לייט</Text>
        </View>

        <View style={styles.heroCard}>
          <Text style={styles.heroLabel}>יתרת הנקודות שלך</Text>
          <View style={styles.pointsRow}>
            <Text style={styles.pointsValue}>1,850</Text>
            <Text style={styles.pointsUnit}>נק׳</Text>
          </View>
          <Text style={styles.heroMeta}>שווה ערך ל-925 ₪ בהטבות</Text>

          <View style={styles.levelRow}>
            <Text style={styles.levelBadge}>GOLD</Text>
            <Text style={styles.levelMeta}>150 נק׳ לרמה הבאה</Text>
          </View>

          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: '70%' }]} />
          </View>
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
        <View style={styles.activityCard}>
          <View style={styles.activityInfo}>
            <Text style={styles.activityTitle}>רכישה אושרה</Text>
            <Text style={styles.activitySubtitle}>חשבונית #1248</Text>
            <Text style={styles.activityDate}>08.08.2026</Text>
          </View>

          <View style={styles.activityPoints}>
            <Text style={styles.pointsBadge}>+120 נק׳</Text>
          </View>
        </View>
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
  activityDate: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: spacing.xs,
  },
  activityPoints: {
    marginLeft: spacing.md,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  pointsBadge: {
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.primary,
    textAlign: 'right',
  },
});
