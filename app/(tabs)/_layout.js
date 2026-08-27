import { Ionicons } from '@expo/vector-icons';
import { Redirect, Tabs } from 'expo-router';
import { StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '../../src/context/AuthContext';
import { colors } from '../../src/theme';

function renderTabIcon(outlineName, filledName) {
  return ({ focused, color, size }) => (
    <Ionicons name={focused ? filledName : outlineName} size={size} color={color} />
  );
}

export default function TabsLayout() {
  const { session, loading } = useAuth();
  // STAGE 15.1: real-device fix - the tab bar's own paddingBottom was a
  // hardcoded `10` for both iOS and Android (the `Platform.OS === 'ios' ?
  // 10 : 10` ternary always evaluated to the same literal either way - a
  // stale leftover, not an actual platform split), so it never accounted
  // for the iPhone home-indicator safe area (~34px on any notched/Dynamic-
  // Island iPhone, i.e. effectively every current iPhone) and clipped the
  // tab bar's icons/labels underneath it. `insets.bottom` is 0 on devices
  // that don't need extra clearance (older iPhones, most Android phones,
  // web), so adding it unconditionally never adds unwanted blank space
  // there - no Platform branch or magic number needed.
  const insets = useSafeAreaInsets();

  if (loading) {
    return null;
  }

  if (!session) {
    return <Redirect href="/(auth)/login" />;
  }

  return (
    <Tabs
      // Default bottom-tabs backBehavior is 'firstRoute', which makes
      // goBack()/router.back() always jump to the first-declared
      // Tabs.Screen below ("profile") no matter which tab was actually
      // visited before - the cause of PurchaseScreen's back arrow always
      // landing on "אזור אישי" regardless of real navigation history.
      // 'history' makes back navigation follow the tabs actually visited,
      // in visitation order - only affects tab-level back navigation (this
      // Tabs navigator itself); each tab's own nested Stack (e.g.
      // profile/edit, profile/change-password) still governs its own back
      // button via its own Stack navigator, unaffected by this.
      backBehavior="history"
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.grayDark,
        // Base height raised from 68 to 76 (STAGE 15.1 FOLLOW-UP): the
        // previous 68px, minus this bar's own paddingTop(8)/paddingBottom(10),
        // left only ~50px for icon+label content - close enough to the
        // actual icon(28) + label(~18) + the tab item's own internal
        // padding that a few extra device/version-dependent pixels could
        // push the label out of the visible row. The extra headroom costs
        // no visual redesign (background/border/shadow all unchanged) and
        // removes that margin entirely.
        tabBarStyle: [styles.tabBar, { height: 76 + insets.bottom, paddingBottom: 10 + insets.bottom }],
        tabBarItemStyle: styles.tabBarItem,
        // STAGE 15.1 FOLLOW-UP: a per-screen `tabBarLabel` render FUNCTION
        // used to be set on every Tabs.Screen below (rendering a custom
        // <Text> ourselves). That takes a different, far less-exercised
        // internal render path than a plain string label - it renders fine
        // on web but was found to render no visible label at all on a
        // physical iPhone. `tabBarLabelStyle` only carries this app's
        // RTL/sizing tweaks, not color - color comes from
        // tabBarActiveTintColor/tabBarInactiveTintColor above, applied
        // automatically by the library's own label element for a plain
        // string label (STAGE 15.2: each Tabs.Screen below now sets its own
        // explicit `tabBarLabel` string rather than only relying on `title`
        // - traced this exact rendering path in both this project's SDK 57
        // expo-router (vendors @react-navigation/bottom-tabs internally)
        // and, read-only, the SDK 54 iPhone test shell's standalone
        // @react-navigation/bottom-tabs@7 package: both resolve a string
        // `tabBarLabel` (or `title` as fallback) through the identical
        // standard <Label> element, so `title`-only should already have
        // worked - this makes the label source fully explicit as well,
        // removing any dependency on that fallback resolution).
        tabBarLabelStyle: styles.tabBarLabel,
        tabBarHideOnKeyboard: true,
        tabBarShowLabel: true,
      }}>
      <Tabs.Screen
        name="profile"
        options={{
          title: 'אזור אישי',
          tabBarLabel: 'אזור אישי',
          tabBarIcon: renderTabIcon('person-outline', 'person'),
        }}
      />
      <Tabs.Screen
        name="rewards"
        options={{
          title: 'מתנות',
          tabBarLabel: 'מתנות',
          tabBarIcon: renderTabIcon('gift-outline', 'gift'),
        }}
      />
      <Tabs.Screen
        name="purchase"
        options={{
          title: 'דיווח רכישה',
          tabBarLabel: 'דיווח רכישה',
          tabBarIcon: renderTabIcon('receipt-outline', 'receipt'),
        }}
      />
      <Tabs.Screen
        name="index"
        options={{
          title: 'בית',
          tabBarLabel: 'בית',
          tabBarIcon: renderTabIcon('home-outline', 'home'),
        }}
      />
      <Tabs.Screen
        name="activity"
        options={{
          href: null,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  // height/paddingBottom are intentionally NOT set here any more - both are
  // computed per-render from useSafeAreaInsets() above (base 68/10 plus the
  // real device inset) and applied via the inline tabBarStyle array, so
  // this base style only carries what never needs to vary by device.
  tabBar: {
    backgroundColor: colors.white,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 8,
    paddingHorizontal: 6,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#0B0B0B',
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -4 },
    elevation: 8,
  },
  // No `color` here - the library's own Label element applies
  // tabBarActiveTintColor/tabBarInactiveTintColor (set above) automatically
  // based on focus state.
  tabBarLabel: {
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
    lineHeight: 18,
    includeFontPadding: false,
    writingDirection: 'rtl',
    marginTop: 0,
  },
  tabBarItem: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 0,
    paddingHorizontal: 2,
  },
});
