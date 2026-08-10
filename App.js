import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import AppScreen from './src/components/common/AppScreen';
import { colors, spacing, typography } from './src/theme';

export default function App() {
  return (
    <AppScreen>
      <View style={styles.previewCard}>
        <Text style={styles.title}>Golden Pro</Text>
        <Text style={styles.subtitle}>Mobile foundation</Text>
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  previewCard: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.xl,
    borderRadius: 20,
    backgroundColor: colors.surface,
  },
  title: {
    fontSize: typography.display.fontSize,
    lineHeight: typography.display.lineHeight,
    fontWeight: typography.display.fontWeight,
    color: colors.text,
    textAlign: 'center',
  },
  subtitle: {
    marginTop: spacing.sm,
    fontSize: typography.body.fontSize,
    lineHeight: typography.body.lineHeight,
    color: colors.textMuted,
    textAlign: 'center',
  },
});
