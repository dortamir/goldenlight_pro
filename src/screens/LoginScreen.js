import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { I18nManager, Image, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import AppCard from '../components/common/AppCard';
import AppInput from '../components/common/AppInput';
import AppScreen from '../components/common/AppScreen';
import AuthSegmentedControl from '../components/common/AuthSegmentedControl';
import PrimaryButton from '../components/common/PrimaryButton';
import { useAuth } from '../context/AuthContext';
import { colors, radius, spacing, typography } from '../theme';

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
      <AppScreen backgroundColor={colors.background}>
        <View style={styles.loadingState}><Text style={styles.loadingText}>טוען...</Text></View>
      </AppScreen>
    );
  }

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
          <Text style={styles.title}>ברוכים הבאים</Text>
          <Text style={styles.subtitle}>התחברו ל +GOLDEN והמשיכו לצבור נקודות</Text>

          <AuthSegmentedControl
            activeTab="login"
            onRegisterPress={() => router.push('/(auth)/register')}
            onLoginPress={() => undefined}
          />
        </View>

        <AppCard style={styles.card}>
          <View style={styles.formSection}>
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
                <Text style={styles.passwordTogglePlaceholder}>{showPassword ? '●' : '○'}</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.forgotRow}>
              <Pressable onPress={() => undefined} accessibilityRole="link">
                <Text style={styles.forgotText}>שכחתם סיסמה?</Text>
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
  segmentedControl: {
    flexDirection: I18nManager.isRTL ? 'row-reverse' : 'row',
    width: '100%',
    maxWidth: 380,
    alignSelf: 'center',
    borderWidth: 1,
    borderColor: '#E8ECEF',
    borderRadius: 20,
    padding: 4,
    backgroundColor: 'rgba(255,255,255,0.7)',
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
  activeTab: {
    backgroundColor: colors.primary,
    marginHorizontal: 2,
  },
  segmentText: {
    fontSize: typography.button.fontSize,
    lineHeight: typography.button.lineHeight,
    fontWeight: '600',
    color: colors.textMuted,
  },
  activeSegmentText: {
    color: colors.black,
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
    color: colors.textMuted,
    fontSize: typography.body.fontSize,
    textAlign: 'center',
  },
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
