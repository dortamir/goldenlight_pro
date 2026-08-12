import * as Linking from 'expo-linking';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import AppBackButton from '../components/common/AppBackButton';
import AppCard from '../components/common/AppCard';
import AppInput from '../components/common/AppInput';
import AppScreen from '../components/common/AppScreen';
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
    <AppScreen backgroundColor={colors.background} contentContainerStyle={styles.screenContent}>
      <View style={styles.container}>
        <View style={styles.header}>
          <AppBackButton fallbackRoute="/(auth)/login" style={styles.headerBackButton} />
          <View style={styles.headerTextBlock}>
            <Text style={styles.title}>שכחתי סיסמה</Text>
            <Text style={styles.subtitle}>הזינו את כתובת האימייל שלכם ונשלח לכם קישור לאיפוס הסיסמה</Text>
          </View>
        </View>

        <AppCard style={styles.card}>
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
