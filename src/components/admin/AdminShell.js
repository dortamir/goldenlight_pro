import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '../../context/AuthContext';
import { colors, radius, spacing, typography } from '../../theme';
import { isolateLTR } from '../../utils/bidiText';

// Deliberately just two real destinations. A third item ("חשבוניות לבדיקה")
// that pointed at this same dashboard route was removed as redundant: the
// dashboard (AdminHomeScreen) already opens directly onto the active review
// queue, so a second nav entry pointing at the identical route added a
// choice with no actual difference. "כל החשבוניות" (AdminReportsHistoryScreen)
// remains the one real second destination, covering every status including
// approved/rejected reports the active queue intentionally drops.
const NAV_ITEMS = [
  { key: 'dashboard', label: 'ראשי', route: '/admin' },
  { key: 'history', label: 'כל החשבוניות', route: '/admin/reports' },
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
      <View style={styles.header}>
        <View style={styles.headerInner}>
          <Text style={styles.brand}>{`${isolateLTR('GOLDEN+')} · מערכת ניהול`}</Text>

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
                  <Text style={[styles.navText, isActive && styles.navTextActive]}>{item.label}</Text>
                </Pressable>
              );
            })}
          </View>

          <Pressable
            onPress={handleSignOut}
            style={({ pressed, hovered }) => [
              styles.signOutButton,
              hovered && styles.signOutButtonHovered,
              pressed && styles.navItemPressed,
            ]}
            accessibilityRole="button">
            <Text style={styles.signOutText}>יציאה</Text>
          </Pressable>
        </View>
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
  header: {
    backgroundColor: colors.bgDark,
    borderBottomWidth: 1,
    borderBottomColor: colors.charcoalBorder,
  },
  headerInner: {
    width: '100%',
    maxWidth: 1100,
    alignSelf: 'center',
    flexDirection: 'row-reverse',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  brand: {
    ...typography.body,
    fontWeight: '700',
    color: colors.textOnDark,
    textAlign: 'right',
  },
  nav: {
    flexDirection: 'row-reverse',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  navItem: {
    paddingHorizontal: spacing.md,
    paddingVertical: 9,
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
    ...typography.caption,
    fontWeight: '600',
    color: colors.mutedOnDark,
    textAlign: 'center',
  },
  navTextActive: {
    color: colors.primary,
    fontWeight: '700',
  },
  signOutButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: 9,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.charcoalBorder,
    cursor: 'pointer',
  },
  signOutButtonHovered: {
    borderColor: colors.mutedOnDark,
  },
  signOutText: {
    ...typography.caption,
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
