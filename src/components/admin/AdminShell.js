import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

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
      {/* STAGE 17.2: Stage 17.1's fix (useSafeAreaInsets() + manual
          paddingTop) did not clear the status bar/Dynamic Island on the
          physical iPhone. Replaced with the SAME structural pattern this
          codebase already proves works on that exact device -
          AppScreen.js's own <SafeAreaView> (the COMPONENT, not the hook)
          from react-native-safe-area-context, used by every customer
          screen. The dark background lives on this OUTER plain View (so it
          still paints all the way behind the status bar/island - no gap),
          while <SafeAreaView edges={['top']}> is the ONE place that owns
          top safe-area padding, pushing headerInner's actual content
          (brand/nav/sign-out) below the inset. `edges={['top']}` only -
          left/right/bottom are never padded here (this isn't a full-screen
          safe area, only the header needs it), so there is no double
          safe-area application anywhere in the admin tree. AdminShell is
          still the ONE component every admin screen (Home, History,
          Detail) gets its header from, so this remains the single owner
          for the whole admin area.  */}
      <View style={styles.headerBackground}>
        <SafeAreaView edges={['top']}>
          <View style={styles.headerInner}>
            <View style={styles.headerTopRow}>
              <Text style={styles.brand}>{`${isolateLTR('GOLDEN+')} · מערכת ניהול`}</Text>

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

            {/* STAGE 17.2: nav pills moved onto their own row (previously
                shared one flex-wrap row with the brand text and sign-out
                button, whose wrap order on a narrow physical iPhone width
                was not reliably predictable). Two explicit rows - title+
                sign-out, then nav - are always readable and never clip,
                on every width, without relying on flex-wrap reflow. */}
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
  headerInner: {
    width: '100%',
    maxWidth: 1100,
    alignSelf: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  headerTopRow: {
    flexDirection: 'row-reverse',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
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
