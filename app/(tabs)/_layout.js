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
          tabBarIcon: () => null,
        }}
      />
      <Tabs.Screen
        name="rewards"
        options={{
          title: 'הטבות',
          tabBarLabel: renderTabLabel('הטבות'),
          tabBarIcon: () => null,
        }}
      />
      <Tabs.Screen
        name="purchase"
        options={{
          title: 'דיווח רכישה',
          tabBarLabel: renderTabLabel('דיווח רכישה'),
          tabBarIcon: () => null,
        }}
      />
      <Tabs.Screen
        name="index"
        options={{
          title: 'בית',
          tabBarLabel: renderTabLabel('בית'),
          tabBarIcon: () => null,
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
