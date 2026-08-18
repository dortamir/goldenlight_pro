import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '../../context/AuthContext';
import { colors, radius, spacing, typography } from '../../theme';

const NAV_ITEMS = [
  { key: 'dashboard', label: 'ראשי', route: '/admin' },
  { key: 'queue', label: 'חשבוניות לבדיקה', route: '/admin' },
  { key: 'history', label: 'כל החשבוניות', route: '/admin/reports' },
];

// Shared web-first admin chrome: a dark header (brand + minimal nav + sign
// out) over a light scrollable content area. "ראשי"/"חשבוניות לבדיקה" both
// point at the same dashboard route, since the review queue lives directly
// on that screen (see AdminHomeScreen) - kept as two labeled entries per the
// requested nav structure so real, separate destinations can be wired in
// later without a nav redesign. "כל החשבוניות" is a real, separate
// destination (see AdminReportsHistoryScreen) covering every status,
// including approved/rejected reports the active queue intentionally drops.
// Intentionally not a copy of the customer app's tab bar - this is a
// desktop-oriented management surface.
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
          <Text style={styles.brand}>GOLDEN+ · מערכת ניהול</Text>

          <View style={styles.nav}>
            {NAV_ITEMS.map((item) => (
              <Pressable
                key={item.key}
                onPress={() => router.push(item.route)}
                style={[styles.navItem, activeKey === item.key && styles.navItemActive]}
                accessibilityRole="link">
                <Text style={[styles.navText, activeKey === item.key && styles.navTextActive]}>{item.label}</Text>
              </Pressable>
            ))}
          </View>

          <Pressable onPress={handleSignOut} style={styles.signOutButton} accessibilityRole="button">
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
    gap: spacing.sm,
  },
  navItem: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
  },
  navItemActive: {
    backgroundColor: colors.glassFill,
  },
  navText: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.mutedOnDark,
    textAlign: 'center',
  },
  navTextActive: {
    color: colors.primary,
  },
  signOutButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.charcoalBorder,
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
