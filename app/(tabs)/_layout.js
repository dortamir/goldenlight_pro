import { Ionicons } from '@expo/vector-icons';
import { Redirect, Tabs } from 'expo-router';
import { Platform, StyleSheet, Text } from 'react-native';

import { useAuth } from '../../src/context/AuthContext';
import { colors } from '../../src/theme';

function renderTabLabel(label) {
  return ({ focused }) => (
    <Text
      style={[
        styles.tabBarLabel,
        { color: focused ? colors.primary : colors.grayDark },
      ]}
      numberOfLines={1}
      adjustsFontSizeToFit={false}>
      {label}
    </Text>
  );
}

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
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.grayDark,
        tabBarStyle: styles.tabBar,
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
  tabBar: {
    backgroundColor: colors.white,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    height: 68,
    paddingTop: 8,
    paddingBottom: Platform.OS === 'ios' ? 10 : 10,
    paddingHorizontal: 6,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#0B0B0B',
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -4 },
    elevation: 8,
  },
  tabBarLabel: {
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
    lineHeight: 18,
    includeFontPadding: false,
    writingDirection: 'rtl',
    color: colors.grayDark,
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
