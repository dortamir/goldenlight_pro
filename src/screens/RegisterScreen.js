import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import AppCard from '../components/common/AppCard';
import AppInput from '../components/common/AppInput';
import AppScreen from '../components/common/AppScreen';
import AuthSegmentedControl from '../components/common/AuthSegmentedControl';
import PrimaryButton from '../components/common/PrimaryButton';
import { colors, radius, spacing, typography } from '../theme';

export default function RegisterScreen() {
  const router = useRouter();
  const [showPassword, setShowPassword] = useState(false);

  return (
    <AppScreen backgroundColor={colors.background}>
      <View style={styles.screenContent}>
        <View style={styles.backgroundGlow} />
        <View style={styles.backgroundGlowSecondary} />

        <View style={styles.heroSection}>
          <Image
            source={require('../assets/images/golden-light-logo-black.png')}
            style={styles.logo}
            resizeMode="contain"
          />
          <Text style={styles.title}>פתיחת חשבון</Text>
          <Text style={styles.subtitle}>הצטרפו ל +GOLDEN והתחילו לצבור נקודות</Text>

          <AuthSegmentedControl
            activeTab="register"
            onRegisterPress={() => undefined}
            onLoginPress={() => router.push('/(auth)/login')}
          />
        </View>

        <AppCard style={styles.card}>
          <View style={styles.formSection}>
            <AppInput
              label="שם מלא *"
              placeholder="הכניסו שם מלא"
              style={styles.input}
            />

            <AppInput
              label="טלפון *"
              placeholder="050-1234567"
              keyboardType="phone-pad"
              style={styles.input}
            />

            <View style={styles.professionWrapper}>
              <Text style={styles.professionLabel}>מקצוע</Text>
              <Pressable style={styles.professionField} accessibilityRole="button">
                <Text style={styles.professionPlaceholder}>בחרו מקצוע...</Text>
              </Pressable>
            </View>

            <AppInput
              label="אימייל *"
              placeholder="you@example.com"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
              textAlign="left"
              writingDirection="ltr"
            />

            <View style={styles.passwordFieldWrapper}>
              <AppInput
                label="סיסמה *"
                placeholder="לפחות 6 תווים"
                secureTextEntry={!showPassword}
                style={styles.input}
                inputStyle={styles.passwordInput}
              />
              <TouchableOpacity
                style={styles.passwordToggle}
                onPress={() => setShowPassword((value) => !value)}
                accessibilityRole="button"
                accessibilityLabel={showPassword ? 'הסתר סיסמה' : 'הצג סיסמה'}
                activeOpacity={0.8}>
                <Text style={styles.passwordTogglePlaceholder}>{showPassword ? '●' : '○'}</Text>
              </TouchableOpacity>
            </View>

            <PrimaryButton title="פתיחת חשבון" onPress={() => undefined} style={styles.button} />

            <View style={styles.registerRow}>
              <Text style={styles.registerPrompt}>כבר רשומים?</Text>
              <TouchableOpacity
                onPress={() => router.push('/(auth)/login')}
                accessibilityRole="link"
                activeOpacity={0.8}>
                <Text style={styles.registerAction}>התחברו</Text>
              </TouchableOpacity>
            </View>
          </View>
        </AppCard>
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  screenContent: {
    flex: 1,
    width: '100%',
    justifyContent: 'center',
    position: 'relative',
  },
  backgroundGlow: {
    position: 'absolute',
    top: -40,
    left: -40,
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: colors.primarySoft,
    opacity: 0.7,
  },
  backgroundGlowSecondary: {
    position: 'absolute',
    top: 80,
    right: -30,
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: colors.surfaceMuted,
    opacity: 0.8,
  },
  heroSection: {
    alignItems: 'center',
    marginBottom: spacing.xxl,
    paddingTop: spacing.lg,
    zIndex: 1,
  },
  logo: {
    width: 420,
    height: 210,
    alignSelf: 'center',
  },
  title: {
    fontSize: typography.heading.fontSize,
    lineHeight: typography.heading.lineHeight,
    fontWeight: typography.heading.fontWeight,
    color: colors.text,
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  subtitle: {
    fontSize: typography.body.fontSize,
    lineHeight: typography.body.lineHeight,
    color: colors.textMuted,
    textAlign: 'center',
    maxWidth: 280,
    marginBottom: spacing.lg,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    alignSelf: 'center',
    borderRadius: radius.xl,
    backgroundColor: colors.surface,
    shadowColor: colors.black,
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  formSection: {
    width: '100%',
    alignItems: 'stretch',
  },
  input: {
    marginBottom: spacing.md,
  },
  professionWrapper: {
    width: '100%',
    marginBottom: spacing.md,
  },
  professionField: {
    minHeight: 52,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    justifyContent: 'center',
  },
  professionLabel: {
    color: colors.text,
    fontSize: typography.caption.fontSize,
    lineHeight: typography.caption.lineHeight,
    fontWeight: '600',
    marginBottom: spacing.xs,
  },
  professionPlaceholder: {
    color: colors.textMuted,
    fontSize: typography.body.fontSize,
    lineHeight: typography.body.lineHeight,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  passwordFieldWrapper: {
    position: 'relative',
  },
  passwordInput: {
    paddingLeft: 52,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  passwordToggle: {
    position: 'absolute',
    left: 16,
    top: 0,
    bottom: 0,
    zIndex: 2,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  passwordTogglePlaceholder: {
    fontSize: 18,
    color: colors.textMuted,
  },
  button: {
    marginTop: spacing.xs,
    marginBottom: spacing.xl,
  },
  registerRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    flexWrap: 'wrap',
    writingDirection: 'rtl',
  },
  registerPrompt: {
    color: colors.textMuted,
    fontSize: typography.body.fontSize,
    lineHeight: typography.body.lineHeight,
    textAlign: 'center',
  },
  registerAction: {
    color: colors.primary,
    fontSize: typography.body.fontSize,
    lineHeight: typography.body.lineHeight,
    fontWeight: '600',
    textAlign: 'center',
    marginStart: 6,
  },
});
