import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import AppInput from '../components/common/AppInput';
import AppScreen from '../components/common/AppScreen';
import AuthScreenShell from '../components/common/AuthScreenShell';
import PrimaryButton from '../components/common/PrimaryButton';
import { MIN_PASSWORD_LENGTH, PASSWORD_TOO_SHORT_MESSAGE } from '../constants/validation';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../services/supabase';
import { colors, spacing, typography } from '../theme';

// How long this screen waits for the recovery link to finish being
// processed (see AuthContext's deep-link effect) before concluding no valid
// recovery link is actually present, rather than merely still loading.
const RECOVERY_VALIDATION_TIMEOUT_MS = 4000;

export default function ResetPasswordScreen() {
  const {
    session,
    loading: authLoading,
    passwordRecovery,
    recoveryError,
    clearPasswordRecovery,
  } = useAuth();

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitError, setSubmitError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [validationTimedOut, setValidationTimedOut] = useState(false);

  // If neither a recovery session nor a recovery error shows up within a
  // few seconds, this route was opened without a valid recovery link at all
  // (e.g. visited directly) - treat that the same as an invalid link rather
  // than showing a form or a loading state forever.
  useEffect(() => {
    if (authLoading || passwordRecovery || recoveryError) {
      return undefined;
    }

    const timer = setTimeout(() => setValidationTimedOut(true), RECOVERY_VALIDATION_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [authLoading, passwordRecovery, recoveryError]);

  const handleRequestNewLink = () => {
    clearPasswordRecovery();
    router.replace('/(auth)/forgot-password');
  };

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

      // Uses the recovery session established by AuthContext from the
      // email link - the standard Supabase mechanism for completing a
      // password reset. No service_role, no direct auth.users writes.
      const { error } = await supabase.auth.updateUser({ password: newPassword });

      if (error) {
        throw error;
      }

      setNewPassword('');
      setConfirmPassword('');
      setSuccessMessage('הסיסמה עודכנה בהצלחה');

      setTimeout(() => {
        clearPasswordRecovery();
        // updateUser() does not invalidate the current session - if one is
        // still present, the user can go straight into the app; otherwise
        // fall back to login. AuthContext's session state is the source of
        // truth for this, not an assumption.
        router.replace(session ? '/(tabs)' : '/(auth)/login');
      }, 700);
    } catch (err) {
      if (__DEV__) {
        // Never log the password itself or any session/access/refresh token
        // - only a safe error code/message for debugging.
        console.warn('[Auth] Failed to reset password', { code: err?.code, message: err?.message });
      }
      setSubmitError('לא הצלחנו לעדכן את הסיסמה. נסו שוב.');
    } finally {
      setSubmitting(false);
    }
  };

  const stillValidating = !authLoading && !passwordRecovery && !recoveryError && !validationTimedOut;

  if (authLoading || stillValidating) {
    // Bare, card-less state (no title/form to anchor a full AuthScreenShell
    // around yet) - still sits on the same shared dark gradient background
    // as Login/Register/ForgotPassword (see app/(auth)/_layout.js) via
    // AppScreen's transparent background, so there is no light flash before
    // the recovery link finishes validating.
    return (
      <AppScreen backgroundColor="transparent">
        <View style={styles.loadingState}>
          <Text style={styles.loadingText}>מאמת קישור...</Text>
        </View>
      </AppScreen>
    );
  }

  if (recoveryError || (validationTimedOut && !passwordRecovery)) {
    return (
      <AuthScreenShell title="איפוס סיסמה" showTabs={false}>
        <Text style={styles.invalidText}>קישור איפוס הסיסמה אינו תקין או שפג תוקפו.</Text>
        <PrimaryButton title="שליחת קישור חדש" onPress={handleRequestNewLink} style={styles.button} />
      </AuthScreenShell>
    );
  }

  return (
    <AuthScreenShell title="איפוס סיסמה" subtitle="הגדירו סיסמה חדשה לחשבון" showTabs={false}>
      <View style={styles.passwordFieldWrapper}>
        <AppInput
          label="סיסמה חדשה"
          placeholder="לפחות 8 תווים"
          secureTextEntry={!showNewPassword}
          value={newPassword}
          onChangeText={setNewPassword}
          style={styles.input}
          inputStyle={styles.passwordInput}
          editable={!submitting}
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
          editable={!submitting}
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
    </AuthScreenShell>
  );
}

const styles = StyleSheet.create({
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
  invalidText: {
    fontSize: typography.body.fontSize,
    lineHeight: typography.body.lineHeight,
    color: colors.textMuted,
    textAlign: 'right',
    writingDirection: 'rtl',
    marginBottom: spacing.md,
  },
  button: {
    marginTop: spacing.xs,
  },
  loadingState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    color: colors.textOnDark,
    fontSize: typography.body.fontSize,
    textAlign: 'center',
  },
});
