import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import AppCard from '../components/common/AppCard';
import AppInput from '../components/common/AppInput';
import AppScreen from '../components/common/AppScreen';
import AuthSegmentedControl from '../components/common/AuthSegmentedControl';
import PrimaryButton from '../components/common/PrimaryButton';
import { MIN_PASSWORD_LENGTH, PASSWORD_TOO_SHORT_MESSAGE } from '../constants/validation';
import { useAuth } from '../context/AuthContext';
import { colors, radius, spacing, typography } from '../theme';

export default function RegisterScreen() {
  const router = useRouter();
  const { signUp, session, loading: authLoading } = useAuth();
  const [showPassword, setShowPassword] = useState(false);
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [profession, setProfession] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (session) {
      router.replace('/(tabs)');
    }
  }, [router, session]);

  const handleRegister = async () => {
    setErrorMessage('');
    setSuccessMessage('');

    if (!fullName.trim() || !phone.trim() || !email.trim() || !password) {
      setErrorMessage('אנא מלאו את כל השדות הנדרשים');
      return;
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      setErrorMessage(PASSWORD_TOO_SHORT_MESSAGE);
      return;
    }

    try {
      setLoading(true);
      const result = await signUp({
        email: email.trim(),
        password,
        fullName: fullName.trim(),
        phone: phone.trim(),
        profession: profession.trim(),
      });

      if (result.session) {
        setSuccessMessage('ההרשמה הושלמה');
      } else {
        setSuccessMessage('ההרשמה הושלמה. שלחנו אליכם אימייל לאישור החשבון.');
      }
    } catch (error) {
      if (error?.message?.includes('already registered')) {
        setErrorMessage('כתובת האימייל כבר רשומה');
      } else {
        setErrorMessage('לא הצלחנו ליצור את החשבון. נסו שוב.');
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
              value={fullName}
              onChangeText={setFullName}
            />

            <AppInput
              label="טלפון *"
              placeholder="050-1234567"
              keyboardType="phone-pad"
              style={styles.input}
              value={phone}
              onChangeText={setPhone}
            />

            <View style={styles.professionWrapper}>
              <Text style={styles.professionLabel}>מקצוע</Text>
              <Pressable style={styles.professionField} accessibilityRole="button">
                <TextInput
                  placeholder="בחרו מקצוע..."
                  value={profession}
                  onChangeText={setProfession}
                  style={styles.professionPlaceholder}
                  placeholderTextColor={colors.textMuted}
                />
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
              value={email}
              onChangeText={setEmail}
            />

            <View style={styles.passwordFieldWrapper}>
              <AppInput
                label="סיסמה *"
                placeholder="לפחות 8 תווים"
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

            {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
            {successMessage ? <Text style={styles.successText}>{successMessage}</Text> : null}

            <PrimaryButton title="פתיחת חשבון" onPress={handleRegister} loading={loading} disabled={loading} style={styles.button} />

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
  button: {
    marginTop: spacing.xs,
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
    marginBottom: spacing.sm,
  },
  successText: {
    color: colors.primary,
    fontSize: typography.caption.fontSize,
    lineHeight: typography.caption.lineHeight,
    textAlign: 'right',
    writingDirection: 'rtl',
    marginBottom: spacing.sm,
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
