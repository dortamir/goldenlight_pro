import * as Linking from 'expo-linking';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import AppInput from '../components/common/AppInput';
import AuthScreenShell from '../components/common/AuthScreenShell';
import PrimaryButton from '../components/common/PrimaryButton';
import { supabase } from '../services/supabase';
import { colors, spacing, typography } from '../theme';

// Deliberately basic - only rejects text with no "@" or no "." after it.
// Real deliverability is Supabase's problem, not this form's.
const EMAIL_FORMAT_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ForgotPasswordScreen() {
  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (submitting) {
      return;
    }

    const trimmedEmail = email.trim();

    setSubmitError('');
    setSuccessMessage('');

    if (!trimmedEmail) {
      setFieldError('יש להזין כתובת אימייל');
      return;
    }

    if (!EMAIL_FORMAT_RE.test(trimmedEmail)) {
      setFieldError('כתובת האימייל אינה תקינה');
      return;
    }

    setFieldError('');

    if (!supabase) {
      setSubmitError('לא הצלחנו לשלוח את הקישור. נסו שוב.');
      return;
    }

    try {
      setSubmitting(true);

      // redirectTo must be an allow-listed URL in the Supabase Dashboard
      // (Authentication -> URL Configuration -> Redirect URLs) - see
      // supabase/README.md for the exact values this project needs there.
      // Linking.createURL() resolves to the right thing per platform: a
      // goldenlightpro:// deep link on native, the current web origin on
      // web.
      const { error } = await supabase.auth.resetPasswordForEmail(trimmedEmail, {
        redirectTo: Linking.createURL('/reset-password'),
      });

      if (error) {
        throw error;
      }

      // Deliberately generic regardless of whether an account exists for
      // this email - never reveal account existence through this message.
      setSuccessMessage('אם קיים חשבון עם כתובת האימייל הזו, נשלח אליו קישור לאיפוס הסיסמה.');
    } catch (err) {
      if (__DEV__) {
        // Never log the email or any raw Supabase error text beyond a safe
        // code/message pair - see the same pattern in ChangePasswordScreen.
        console.warn('[Auth] Failed to send password reset email', { code: err?.code, message: err?.message });
      }
      setSubmitError('לא הצלחנו לשלוח את הקישור. נסו שוב.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthScreenShell
      title="שכחתי סיסמה"
      subtitle="הזינו את כתובת האימייל שלכם ונשלח לכם קישור לאיפוס הסיסמה"
      showTabs={false}
      backFallbackRoute="/(auth)/login">
      <AppInput
        label="אימייל"
        placeholder="הכניסו כתובת אימייל"
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
        textAlign="left"
        writingDirection="ltr"
        value={email}
        onChangeText={setEmail}
        editable={!submitting}
      />
      {fieldError ? <Text style={styles.fieldErrorText}>{fieldError}</Text> : null}

      {submitError ? <Text style={styles.submitErrorText}>{submitError}</Text> : null}
      {successMessage ? <Text style={styles.successText}>{successMessage}</Text> : null}

      <PrimaryButton
        title={submitting ? 'שולח...' : 'שליחת קישור לאיפוס'}
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
