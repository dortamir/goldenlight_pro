import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import AppInput from '../components/common/AppInput';
import AppScreen from '../components/common/AppScreen';
import AuthScreenShell from '../components/common/AuthScreenShell';
import PrimaryButton from '../components/common/PrimaryButton';
import { useAuth } from '../context/AuthContext';
import { colors, spacing, typography } from '../theme';

export default function LoginScreen() {
  const router = useRouter();
  const { signIn, session, loading: authLoading } = useAuth();
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (session) {
      router.replace('/(tabs)');
    }
  }, [router, session]);

  const handleLogin = async () => {
    setErrorMessage('');

    if (!email.trim() || !password) {
      setErrorMessage('אימייל או סיסמה שגויים');
      return;
    }

    try {
      setLoading(true);
      await signIn(email.trim(), password);
    } catch (error) {
      if (error?.message?.includes('Invalid login credentials')) {
        setErrorMessage('אימייל או סיסמה שגויים');
      } else {
        setErrorMessage('לא הצלחנו להתחבר. נסו שוב.');
      }
    } finally {
      setLoading(false);
    }
  };

  if (authLoading) {
    return (
      <AppScreen backgroundColor={colors.bgDark}>
        <View style={styles.loadingState}><Text style={styles.loadingText}>טוען...</Text></View>
      </AppScreen>
    );
  }

  return (
    <AuthScreenShell
      title="ברוכים הבאים"
      subtitle="התחברו ל +GOLDEN והמשיכו לצבור נקודות"
      activeTab="login"
      onRegisterPress={() => router.push('/(auth)/register')}
      onLoginPress={() => undefined}>
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
      />

      <View style={styles.passwordFieldWrapper}>
        <AppInput
          label="סיסמה"
          placeholder="הכניסו סיסמה"
          secureTextEntry={!showPassword}
          style={styles.input}
          inputStyle={styles.passwordInput}
          value={password}
          onChangeText={setPassword}
        />
        <TouchableOpacity
          style={styles.passwordToggle}
          onPress={() => setShowPassword((value) => !value)}
          accessibilityRole="button"
          accessibilityLabel={showPassword ? 'הסתר סיסמה' : 'הצג סיסמה'}
          activeOpacity={0.8}>
          <Ionicons
            name={showPassword ? 'eye-outline' : 'eye-off-outline'}
            size={20}
            color={colors.textMuted}
          />
        </TouchableOpacity>
      </View>

      <View style={styles.forgotRow}>
        <Pressable onPress={() => router.push('/(auth)/forgot-password')} accessibilityRole="link">
          <Text style={styles.forgotText}>שכחתי סיסמה?</Text>
        </Pressable>
      </View>

      {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}

      <PrimaryButton
        title="התחברות"
        onPress={handleLogin}
        loading={loading}
        disabled={loading}
        style={styles.button}
      />

      <View style={styles.registerRow}>
        <Text style={styles.registerPrompt}>עדיין אין לכם חשבון?</Text>
        <TouchableOpacity
          onPress={() => router.push('/(auth)/register')}
          accessibilityRole="link"
          activeOpacity={0.8}>
          <Text style={styles.registerAction}>להרשמה</Text>
        </TouchableOpacity>
      </View>
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
  forgotRow: {
    alignItems: 'flex-end',
    marginBottom: spacing.lg,
  },
  forgotText: {
    color: colors.primary,
    fontSize: typography.caption.fontSize,
    lineHeight: typography.caption.lineHeight,
    fontWeight: '600',
  },
  button: {
    marginBottom: spacing.xl,
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
  // The form card is light again (colors.cardLight) - back to the standard
  // light-surface error color.
  errorText: {
    color: colors.error,
    fontSize: typography.caption.fontSize,
    lineHeight: typography.caption.lineHeight,
    textAlign: 'right',
    writingDirection: 'rtl',
    marginBottom: spacing.md,
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
