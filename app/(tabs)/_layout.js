import { Ionicons } from '@expo/vector-icons';
import { Redirect, Tabs } from 'expo-router';

import GoldenBottomTabBar from '../../src/components/navigation/GoldenBottomTabBar';
import { useAuth } from '../../src/context/AuthContext';

function renderTabIcon(outlineName, filledName) {
  return ({ focused, color, size }) => (
    <Ionicons name={focused ? filledName : outlineName} size={size} color={color} />
  );
}

export default function TabsLayout() {
  const { session, loading } = useAuth();

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
      // STAGE 15.3: a fully custom tab bar (src/components/navigation/
      // GoldenBottomTabBar.js) replaces React Navigation's own default one
      // entirely - see that file's own comment for the full history of why
      // (every previous label-rendering fix relied on the library's
      // internal label renderer, which proved unreliable on the physical
      // iPhone despite tracing it correct in both SDK versions' bundled
      // source). tabBarActiveTintColor/tabBarInactiveTintColor/tabBarStyle/
      // tabBarItemStyle/tabBarLabel/tabBarShowLabel/tabBarHideOnKeyboard are
      // therefore no longer set here at all - the custom component now owns
      // every one of those concerns directly (colors, height/safe-area,
      // label text, hide-on-keyboard). Each screen below still supplies its
      // own `tabBarIcon` and `title` - GoldenBottomTabBar reads both
      // directly from each route's own options rather than duplicating
      // that knowledge.
      tabBar={(props) => <GoldenBottomTabBar {...props} />}
      screenOptions={{
        headerShown: false,
      }}>
      <Tabs.Screen
        name="profile"
        options={{
          title: 'אזור אישי',
          tabBarIcon: renderTabIcon('person-outline', 'person'),
        }}
      />
      <Tabs.Screen
        name="rewards"
        options={{
          title: 'מתנות',
          tabBarIcon: renderTabIcon('gift-outline', 'gift'),
        }}
      />
      <Tabs.Screen
        name="purchase"
        options={{
          title: 'דיווח רכישה',
          tabBarIcon: renderTabIcon('receipt-outline', 'receipt'),
        }}
      />
      <Tabs.Screen
        name="index"
        options={{
          title: 'בית',
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