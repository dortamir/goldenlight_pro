import { router } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { colors } from '../../theme';

// Hand-drawn outline chevron (no icon library is installed in this project).
// A square with only its top+right borders visible, rotated 45°, forms a
// "›" shape. Unlike a text glyph, this is immune to any bidi/mirroring
// behavior that could flip its direction in an RTL text run - it always
// points visually right, which is what "back" means in this RTL interface.
function ChevronRightIcon({ size, color }) {
  const squareSize = size * 0.42;
  const thickness = Math.max(2, size * 0.09);

  return (
    <View
      style={{
        width: squareSize,
        height: squareSize,
        borderTopWidth: thickness,
        borderRightWidth: thickness,
        borderColor: color,
        transform: [{ rotate: '45deg' }],
      }}
    />
  );
}

export default function AppBackButton({
  fallbackRoute,
  deterministicRoute,
  size = 28,
  color = colors.textMuted,
  style,
}) {
  const handlePress = () => {
    // Opt-in only (used by screens that must always land on one specific
    // route regardless of how the user arrived, e.g. PurchaseHistoryScreen
    // returning to Home) - deliberately skips router.canGoBack()/back(),
    // since navigation history can otherwise send the user somewhere other
    // than the screen that's conceptually "back" for this entry point.
    // Every other screen leaves this unset and keeps the default
    // back()-then-fallbackRoute behavior below, unchanged.
    if (deterministicRoute) {
      router.replace(deterministicRoute);
      return;
    }

    if (router.canGoBack()) {
      router.back();
      return;
    }

    if (fallbackRoute) {
      router.replace(fallbackRoute);
    }
  };

  return (
    <Pressable
      onPress={handlePress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel="חזרה"
      style={({ pressed }) => [styles.touchArea, pressed && styles.touchAreaPressed, style]}>
      <ChevronRightIcon size={size} color={color} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  touchArea: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    borderRadius: 12,
  },
  touchAreaPressed: {
    backgroundColor: colors.surfaceMuted,
  },
});
