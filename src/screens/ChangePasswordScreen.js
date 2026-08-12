import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import AppBackButton from '../components/common/AppBackButton';
import AppCard from '../components/common/AppCard';
import AppInput from '../components/common/AppInput';
import AppScreen from '../components/common/AppScreen';
import PrimaryButton from '../components/common/PrimaryButton';
import { MIN_PASSWORD_LENGTH, PASSWORD_TOO_SHORT_MESSAGE } from '../constants/validation';
import { supabase } from '../services/supabase';
import { colors, spacing, typography } from '../theme';

export default function ChangePasswordScreen() {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitError, setSubmitError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (submitting) {
      return;
    }

    const nextFieldErrors = {};

    if (!newPassword) {
      nextFieldErrors.newPassword = 'יש להזין סיסמה חדשה';
    } else if (newPassword.length < MIN_PASSWORD_LENGTH) {
      nextFieldErrors.newPassword = PASSWORD_TOO_SHORT_MESSAGE;
    }

    if (!confirmPassword) {
      nextFieldErrors.confirmPassword = 'יש להזין את הסיסמה שוב';
    } else if (!nextFieldErrors.newPassword && newPassword !== confirmPassword) {
      nextFieldErrors.confirmPassword = 'הסיסמאות אינן תואמות';
    }

    setFieldErrors(nextFieldErrors);
    setSubmitError('');
    setSuccessMessage('');

    if (Object.keys(nextFieldErrors).length > 0) {
      return;
    }

    if (!supabase) {
      setSubmitError('לא הצלחנו לעדכן את הסיסמה. נסו שוב.');
      return;
    }

    try {
      setSubmitting(true);

      // Uses the current authenticated session's access token - Supabase
      // Auth's updateUser() is the standard, sufficient mechanism for a
      // signed-in user to change their own password. No service_role, no
      // direct auth.users writes, and no additional reauthentication step is
      // configured anywhere in this project (no AAL2/MFA enforcement is set
      // up), so the existing session is enough here.
      const { error } = await supabase.auth.updateUser({ password: newPassword });

      if (error) {
        throw error;
      }

      setNewPassword('');
      setConfirmPassword('');
      setSuccessMessage('הסיסמה עודכנה בהצלחה');
      setTimeout(() => {
        if (router.canGoBack()) {
          router.back();
        } else {
          router.replace('/(tabs)/profile');
        }
      }, 700);
    } catch (err) {
      if (__DEV__) {
        // Never log the password itself or any session/access/refresh token
        // - only a safe error code/message for debugging.
        console.warn('[Auth] Failed to update password', { code: err?.code, message: err?.message });
      }

      const message = String(err?.message || '').toLowerCase();
      if (message.includes('password') && (message.includes('weak') || message.includes('short') || message.includes('at least'))) {
        setSubmitError('הסיסמה אינה עומדת בדרישות האבטחה. בחרו סיסמה חזקה יותר.');
      } else {
        setSubmitError('לא הצלחנו לעדכן את הסיסמה. נסו שוב.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AppScreen backgroundColor={colors.background} contentContainerStyle={styles.screenContent}>
      <View style={styles.container}>
        <View style={styles.header}>
          <AppBackButton fallbackRoute="/(tabs)/profile" style={styles.headerBackButton} />
          <View style={styles.headerTextBlock}>
            <Text style={styles.title}>שינוי סיסמה</Text>
            <Text style={styles.subtitle}>עדכנו את הסיסמה לחשבון שלכם</Text>
          </View>
        </View>

        <AppCard style={styles.card}>
          <View style={styles.passwordFieldWrapper}>
            <AppInput
              label="סיסמה חדשה"
              placeholder="לפחות 8 תווים"
              secureTextEntry={!showNewPassword}
              value={newPassword}
              onChangeText={setNewPassword}
              style={styles.input}
              inputStyle={styles.passwordInput}
            />
            <Pressable
              style={styles.passwordToggle}
              onPress={() => setShowNewPassword((value) => !value)}
              accessibilityRole="button"
              accessibilityLabel={showNewPassword ? 'הסתר סיסמה' : 'הצג סיסמה'}
              hitSlop={8}>
              <Ionicons
                name={showNewPassword ? 'eye-outline' : 'eye-off-outline'}
                size={20}
                color={colors.textMuted}
              />
            </Pressable>
          </View>
          {fieldErrors.newPassword ? <Text style={styles.fieldErrorText}>{fieldErrors.newPassword}</Text> : null}

          <View style={styles.passwordFieldWrapper}>
            <AppInput
              label="וידוא סיסמה חדשה"
              placeholder="הזינו שוב את הסיסמה"
              secureTextEntry={!showConfirmPassword}
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              style={styles.input}
              inputStyle={styles.passwordInput}
            />
            <Pressable
              style={styles.passwordToggle}
              onPress={() => setShowConfirmPassword((value) => !value)}
              accessibilityRole="button"
              accessibilityLabel={showConfirmPassword ? 'הסתר סיסמה' : 'הצג סיסמה'}
              hitSlop={8}>
              <Ionicons
                name={showConfirmPassword ? 'eye-outline' : 'eye-off-outline'}
                size={20}
                color={colors.textMuted}
              />
            </Pressable>
          </View>
          {fieldErrors.confirmPassword ? (
            <Text style={styles.fieldErrorText}>{fieldErrors.confirmPassword}</Text>
          ) : null}

          {submitError ? <Text style={styles.submitErrorText}>{submitError}</Text> : null}
          {successMessage ? <Text style={styles.successText}>{successMessage}</Text> : null}

          <PrimaryButton
            title={submitting ? 'מעדכן...' : 'עדכון סיסמה'}
            onPress={handleSubmit}
            loading={submitting}
            disabled={submitting}
            style={styles.button}
          />
        </AppCard>
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  screenContent: {
    justifyContent: 'flex-start',
    alignItems: 'stretch',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xl,
    paddingBottom: spacing.huge,
  },
  container: {
    width: '100%',
    gap: spacing.md,
  },
  header: {
    position: 'relative',
    alignItems: 'flex-end',
    paddingTop: 2,
    paddingBottom: 2,
  },
  headerBackButton: {
    position: 'absolute',
    top: 0,
    right: 0,
    zIndex: 1,
  },
  headerTextBlock: {
    width: '100%',
    alignItems: 'flex-end',
    paddingEnd: 56,
  },
  title: {
    fontSize: typography.title.fontSize,
    fontWeight: typography.title.fontWeight,
    color: colors.text,
    textAlign: 'right',
  },
  subtitle: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: spacing.xs,
    lineHeight: 18,
  },
  card: {
    width: '100%',
  },
  input: {
    marginBottom: spacing.md,
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
  fieldErrorText: {
    fontSize: typography.caption.fontSize,
    fontWeight: '600',
    color: colors.error,
    textAlign: 'right',
    marginTop: -spacing.sm,
    marginBottom: spacing.sm,
  },
  submitErrorText: {
    fontSize: typography.caption.fontSize,
    fontWeight: '600',
    color: colors.error,
    textAlign: 'right',
    marginBottom: spacing.sm,
  },
  successText: {
    fontSize: typography.caption.fontSize,
    fontWeight: '600',
    color: colors.success,
    textAlign: 'right',
    marginBottom: spacing.sm,
  },
  button: {
    marginTop: spacing.xs,
  },
});
