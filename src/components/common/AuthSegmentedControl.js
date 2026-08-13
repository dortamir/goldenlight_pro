import { I18nManager, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { colors, spacing, typography } from '../../theme';

export default function AuthSegmentedControl({
  activeTab = 'login',
  onRegisterPress,
  onLoginPress,
}) {
  const isRegisterActive = activeTab === 'register';

  return (
    <View style={styles.segmentedControl}>
      <TouchableOpacity
        style={[styles.segmentTab, isRegisterActive && styles.activeTab]}
        onPress={onRegisterPress}
        activeOpacity={0.9}>
        <Text style={[styles.segmentText, isRegisterActive && styles.activeSegmentText]}>הרשמה</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.segmentTab, !isRegisterActive && styles.activeTab]}
        onPress={onLoginPress}
        activeOpacity={0.9}>
        <Text style={[styles.segmentText, !isRegisterActive && styles.activeSegmentText]}>התחברות</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  // This control is only ever rendered on the dark auth-screen gradient (see
  // AuthScreenShell) - styled for that context specifically, not as a
  // general-purpose light-background component.
  segmentedControl: {
    flexDirection: I18nManager.isRTL ? 'row-reverse' : 'row',
    width: '100%',
    maxWidth: 380,
    alignSelf: 'center',
    borderWidth: 1,
    borderColor: 'rgba(245, 247, 247, 0.16)',
    borderRadius: 20,
    padding: 4,
    backgroundColor: 'rgba(245, 247, 247, 0.08)',
    marginBottom: spacing.lg,
  },
  segmentTab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
    borderRadius: 16,
    backgroundColor: 'transparent',
    paddingHorizontal: spacing.md,
  },
  // Turquoise is the only active-state indicator, matching every other
  // active-state treatment in the app (active tab, primary CTA) - no glow
  // added here, it stays a plain, clear fill.
  activeTab: {
    backgroundColor: colors.primary,
    marginHorizontal: 2,
  },
  segmentText: {
    fontSize: typography.button.fontSize,
    lineHeight: typography.button.lineHeight,
    fontWeight: '600',
    color: colors.mutedOnDark,
  },
  activeSegmentText: {
    color: colors.black,
  },
});
