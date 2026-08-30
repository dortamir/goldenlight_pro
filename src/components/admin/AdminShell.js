import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '../../context/AuthContext';
import { colors, radius, spacing } from '../../theme';
import { isolateLTR } from '../../utils/bidiText';

// Deliberately just two real destinations. A third item ("חשבוניות לבדיקה")
// that pointed at this same dashboard route was removed as redundant: the
// dashboard (AdminHomeScreen) already opens directly onto the active review
// queue, so a second nav entry pointing at the identical route added a
// choice with no actual difference. "כל החשבוניות" (AdminReportsHistoryScreen)
// remains the one real second destination, covering every status including
// approved/rejected reports the active queue intentionally drops.
// STAGE 17.4: rendered in this exact array order (history before dashboard)
// inside `nav`'s plain `flexDirection: 'row'` - see the mirrored headerRow
// render below for why this order (not the array order alone) is what
// actually determines the visual left-to-right result.
const NAV_ITEMS = [
  { key: 'history', label: 'כל החשבוניות', route: '/admin/reports' },
  { key: 'dashboard', label: 'ראשי', route: '/admin' },
];

// Shared web-first admin chrome: a dark header (brand + minimal nav + sign
// out) over a light scrollable content area. Intentionally not a copy of
// the customer app's tab bar - this is a compact, desktop-oriented
// management surface, not a mobile screen stretched onto desktop.
export default function AdminShell({ activeKey = 'dashboard', children }) {
  const router = useRouter();
  const { signOut } = useAuth();

  const handleSignOut = async () => {
    try {
      await signOut();
      router.replace('/(auth)/login');
    } catch (error) {
      if (__DEV__) {
        console.warn('[Admin] Sign out failed', error);
      }
    }
  };

  return (
    <View style={styles.root}>
      {/* STAGE 17.4: same single-row layout/safe-area handling as Stage 17.3
          (dark background on this outer plain View, <SafeAreaView
          edges={['top']}> as the one and only owner of top safe-area
          padding) - only the horizontal ORDER of the three siblings
          changed. headerRow is still plain `flexDirection: 'row'` (never
          'row-reverse', never toggled by RTL/I18nManager) - the visual
          left-to-right order is entirely determined by JSX source order,
          explicitly reversed here: sign-out first (leftmost), then nav
          (כל החשבוניות before ראשי - see NAV_ITEMS' own order above), then
          brand last (rightmost). This is a pure mirror of Stage 17.3's
          render order - no styling, sizing, or safe-area behavior changed. */}
      <View style={styles.headerBackground}>
        <SafeAreaView edges={['top']}>
          <View style={styles.headerRow}>
            <Pressable
              onPress={handleSignOut}
              style={({ pressed, hovered }) => [
                styles.signOutButton,
                hovered && styles.signOutButtonHovered,
                pressed && styles.navItemPressed,
              ]}
              accessibilityRole="button">
              <Text style={styles.signOutText} numberOfLines={1}>
                יציאה
              </Text>
            </Pressable>

            <View style={styles.nav}>
              {NAV_ITEMS.map((item) => {
                const isActive = activeKey === item.key;
                return (
                  <Pressable
                    key={item.key}
                    onPress={() => router.push(item.route)}
                    style={({ pressed, hovered }) => [
                      styles.navItem,
                      isActive && styles.navItemActive,
                      !isActive && hovered && styles.navItemHovered,
                      pressed && styles.navItemPressed,
                    ]}
                    accessibilityRole="link"
                    accessibilityState={{ selected: isActive }}>
                    <Text style={[styles.navText, isActive && styles.navTextActive]} numberOfLines={1}>
                      {item.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={styles.brand} numberOfLines={1}>{`${isolateLTR('GOLDEN+')} · מערכת ניהול`}</Text>
          </View>
        </SafeAreaView>
      </View>

      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
        showsVerticalScrollIndicator={false}>
        {children}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  headerBackground: {
    backgroundColor: colors.bgDark,
    borderBottomWidth: 1,
    borderBottomColor: colors.charcoalBorder,
  },
  // STAGE 17.3: one row, no flexWrap anywhere - width budget is tight on a
  // narrow physical iPhone, so every piece below is deliberately more
  // compact than the old two-row layout (smaller gaps/padding/font sizes),
  // and the brand title is allowed to shrink/truncate (flexShrink +
  // numberOfLines on the Text itself) before nav/sign-out ever would - see
  // the render above's own comment for why 'row' (not 'row-reverse').
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    maxWidth: 1100,
    alignSelf: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  brand: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '700',
    color: colors.textOnDark,
    textAlign: 'left',
    flexShrink: 1,
    minWidth: 0,
  },
  nav: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    flexShrink: 0,
  },
  navItem: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'transparent',
    cursor: 'pointer',
  },
  navItemHovered: {
    backgroundColor: colors.glassFill,
  },
  navItemPressed: {
    opacity: 0.85,
  },
  navItemActive: {
    backgroundColor: colors.glassFill,
    borderColor: colors.primary,
  },
  navText: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '600',
    color: colors.mutedOnDark,
    textAlign: 'center',
  },
  navTextActive: {
    color: colors.primary,
    fontWeight: '700',
  },
  signOutButton: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.charcoalBorder,
    cursor: 'pointer',
    flexShrink: 0,
  },
  signOutButtonHovered: {
    borderColor: colors.mutedOnDark,
  },
  signOutText: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '600',
    color: colors.mutedOnDark,
    textAlign: 'center',
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    width: '100%',
    maxWidth: 1100,
    alignSelf: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xxl,
    gap: spacing.xxl,
  },
});
