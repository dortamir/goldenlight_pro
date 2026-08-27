import { useEffect, useState } from 'react';
import { Keyboard, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors } from '../../theme';

// STAGE 15.3: a fully custom bottom tab bar, replacing React Navigation's
// own default BottomTabBar entirely. Every previous attempt to get Hebrew
// labels to render reliably on the physical iPhone - title fallback,
// explicit tabBarLabel strings, tabBarShowLabel: true, a custom
// tabBarLabel render function using the renderer's own `color` argument,
// increased tab-bar height, the safe-area fix - relied on React
// Navigation's internal BottomTabItem/Label rendering for the label itself.
// That was traced directly in this project's SDK 57 expo-router (which
// vendors @react-navigation/bottom-tabs internally) and, read-only, the
// SDK 54 iPhone test shell's own standalone @react-navigation/bottom-tabs
// package - both resolve a label through the same standard code path with
// no code-level defect found in either, yet labels still didn't reliably
// render on-device. This component removes that dependency entirely: every
// pixel of every tab button - icon AND label - is explicit JSX this app
// owns, with nothing left to a library-internal renderer that has proven
// unreliable in this exact configuration.
//
// Rendering reuses each Tabs.Screen's own existing `tabBarIcon` render
// function and `title` (see app/(tabs)/_layout.js) rather than duplicating
// icon-name/label knowledge here - this component is purely a rendering
// shell around that same per-screen configuration.

// Mirrors expo-router's own href:null -> tabBarButton:()=>null convention
// (see app/(tabs)/_layout.js's "activity" screen, reachable via
// router.push from Home/History but never shown as a tab button) -
// TabsClient.js sets tabBarItemStyle:{display:'none'} for such routes, so
// checking that here skips them exactly like the default tab bar does.
function isHiddenRoute(options) {
  return options.tabBarItemStyle?.display === 'none';
}

// Simple, self-contained keyboard-visibility tracker (RN's own public
// Keyboard API - no expo-router internals) - reproduces the
// tabBarHideOnKeyboard:true behavior the default tab bar previously
// provided, so this bar still gets out of the way of an open keyboard on
// nested screens (e.g. profile/edit's text inputs) instead of overlapping
// it. Native only - there's no comparable soft-keyboard overlay concern on
// web.
function useIsKeyboardVisible() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (Platform.OS === 'web') {
      return undefined;
    }

    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showSubscription = Keyboard.addListener(showEvent, () => setVisible(true));
    const hideSubscription = Keyboard.addListener(hideEvent, () => setVisible(false));

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  return visible;
}

export default function GoldenBottomTabBar({ state, descriptors, navigation, insets }) {
  const isKeyboardVisible = useIsKeyboardVisible();

  if (isKeyboardVisible) {
    return null;
  }

  // `insets` comes from BottomTabView's own SafeAreaInsetsContext.Consumer
  // wiring (the same react-native-safe-area-context this app uses
  // elsewhere via useSafeAreaInsets()) - never a hardcoded/model-specific
  // number, and 0 on platforms/devices that don't need extra clearance
  // (older iPhones, most Android phones, web).
  const bottomInset = insets?.bottom ?? 0;

  return (
    <View style={[styles.tabBar, { height: 82 + bottomInset, paddingBottom: 10 + bottomInset }]}>
      {state.routes.map((route, index) => {
        const descriptor = descriptors[route.key];
        const { options } = descriptor;

        if (isHiddenRoute(options)) {
          return null;
        }

        const isFocused = state.index === index;
        const color = isFocused ? colors.primary : colors.grayDark;
        const label = options.title ?? route.name;

        const onPress = () => {
          const event = navigation.emit({
            type: 'tabPress',
            target: route.key,
            canPreventDefault: true,
          });

          if (!isFocused && !event.defaultPrevented) {
            navigation.navigate(route.name, route.params);
          }
        };

        const onLongPress = () => {
          navigation.emit({
            type: 'tabLongPress',
            target: route.key,
          });
        };

        return (
          <Pressable
            key={route.key}
            onPress={onPress}
            onLongPress={onLongPress}
            accessibilityRole="button"
            accessibilityState={{ selected: isFocused }}
            accessibilityLabel={options.tabBarAccessibilityLabel ?? label}
            testID={options.tabBarButtonTestID}
            style={styles.tabItem}>
            {typeof options.tabBarIcon === 'function'
              ? options.tabBarIcon({ focused: isFocused, color, size: 24 })
              : null}
            <Text style={[styles.tabLabel, { color }]} numberOfLines={1} adjustsFontSizeToFit={false}>
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    flexDirection: 'row',
    backgroundColor: colors.white,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 8,
    paddingHorizontal: 6,
    alignItems: 'center',
    shadowColor: '#0B0B0B',
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -4 },
    elevation: 8,
  },
  tabItem: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 0,
    paddingHorizontal: 2,
    gap: 4,
  },
  tabLabel: {
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
    lineHeight: 16,
    includeFontPadding: false,
    writingDirection: 'rtl',
  },
});