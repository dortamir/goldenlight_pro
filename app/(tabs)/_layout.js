import { Ionicons } from '@expo/vector-icons';
import { Redirect, Tabs } from 'expo-router';
import { StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '../../src/context/AuthContext';
import { colors } from '../../src/theme';

function renderTabIcon(outlineName, filledName) {
  return ({ focused, color, size }) => (
    <Ionicons name={focused ? filledName : outlineName} size={size} color={color} />
  );
}

// STAGE 15.2 BLOCKING-FIX PASS: back to an explicit custom tabBarLabel
// renderer, this time using the `color` the renderer itself supplies
// (already resolved from tabBarActiveTintColor/tabBarInactiveTintColor
// below per focus state) instead of either a plain string or a
// closure-hardcoded focused/color computation - the most explicit, least
// ambiguous label-rendering path available, with nothing left implicit for
// native rendering to silently drop. `numberOfLines`/`adjustsFontSizeToFit`
// are set directly (not inherited from the library's own <Label> element),
// so this renders identically regardless of platform/library-version
// label-resolution differences.
function renderTabLabel(text) {
  return ({ color }) => (
    <Text style={[styles.tabBarLabel, { color }]} numberOfLines={1} adjustsFontSizeToFit={false}>
      {text}
    </Text>
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
        // Base height raised from 68 (Stage 15.1) to 76 (Stage 15.1
        // follow-up) to 82 (STAGE 15.2 BLOCKING-FIX PASS): the tab item's
        // real content budget is `height - paddingTop(8) - paddingBottom(10)`
        // (insets.bottom is added equally to both height and paddingBottom
        // below, so it cancels out of this interior row height on every
        // device). Content needed: icon(28, the library's own UIKit-variant
        // icon box height) + label(lineHeight 18) + the tab item's own
        // internal vertical padding (5+5=10) = 56px. 76 only left a ~2px
        // margin - not "reasonable" headroom for font-metric/rounding
        // variance across devices. 82 leaves the content row at 64px against
        // a 56px need - real margin, still no per-device magic number, no
        // visual redesign (background/border/shadow all unchanged).
        tabBarStyle: [styles.tabBar, { height: 82 + insets.bottom, paddingBottom: 10 + insets.bottom }],
        tabBarItemStyle: styles.tabBarItem,
        tabBarHideOnKeyboard: true,
        tabBarShowLabel: true,
      }}>
      <Tabs.Screen
        name="profile"
        options={{
          title: 'אזור אישי',
          tabBarLabel: renderTabLabel('אזור אישי'),
          tabBarIcon: renderTabIcon('person-outline', 'person'),
        }}
      />
      <Tabs.Screen
        name="rewards"
        options={{
          title: 'מתנות',
          tabBarLabel: renderTabLabel('מתנות'),
          tabBarIcon: renderTabIcon('gift-outline', 'gift'),
        }}
      />
      <Tabs.Screen
        name="purchase"
        options={{
          title: 'דיווח רכישה',
          tabBarLabel: renderTabLabel('דיווח רכישה'),
          tabBarIcon: renderTabIcon('receipt-outline', 'receipt'),
        }}
      />
      <Tabs.Screen
        name="index"
        options={{
          title: 'בית',
          tabBarLabel: renderTabLabel('בית'),
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
  // No `color` here - renderTabLabel() above applies it inline from the
  // `color` the tabBarLabel renderer itself supplies per focus state.
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
