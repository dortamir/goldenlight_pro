import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Keyboard, Platform, Pressable, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import AppInput from '../components/common/AppInput';
import AppScreen from '../components/common/AppScreen';
import AuthScreenShell from '../components/common/AuthScreenShell';
import DateOfBirthPicker from '../components/common/DateOfBirthPicker';
import PrimaryButton from '../components/common/PrimaryButton';
import { MIN_PASSWORD_LENGTH, PASSWORD_TOO_SHORT_MESSAGE } from '../constants/validation';
import { useAuth } from '../context/AuthContext';
import { colors, radius, spacing, typography } from '../theme';
import { isolateLTR } from '../utils/bidiText';

// STAGE 26.2: today's Israel-local calendar date as 'YYYY-MM-DD', matching
// claim_my_birthday_bonus()'s own (now() at time zone 'Asia/Jerusalem')::date
// (see supabase/migrations/028_birthday_bonus.sql) as closely as a client
// can. This is UX-only - the database CHECK constraint remains the real
// authority on "not a future date," so a mismatch here can at most produce
// a confusing client-side error message, never a security or data-integrity
// issue - but it should still agree with the server's notion of "today"
// rather than silently drifting by a UTC-normalized or device-local value
// near midnight. 'en-CA' is a deliberate locale choice, not a leftover -
// Intl.DateTimeFormat formats that locale as YYYY-MM-DD, exactly the stored
// date_of_birth format, with no manual field reassembly needed. Falls back
// to a UTC-normalized date only if this JS engine's Intl build lacks the
// 'Asia/Jerusalem' timezone data - never throws.
function getIsraelTodayIso() {
  try {
    const formatted = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Jerusalem',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());

    if (/^\d{4}-\d{2}-\d{2}$/.test(formatted)) {
      return formatted;
    }
  } catch {
    // Intl, or 'Asia/Jerusalem' specifically, isn't available in this JS
    // engine - fall through to the UTC-based approximation below.
  }

  return new Date().toISOString().slice(0, 10);
}

// STAGE 19.2: Login and Register used to be two separate Stack routes
// (app/(auth)/login.js -> LoginScreen, app/(auth)/register.js ->
// RegisterScreen), each independently rendering its own <AuthScreenShell>.
// Stage 19.1 tried to make switching between them feel seamless by using
// router.replace() with animation:'none' - on a physical iPhone this still
// produced a real Stack navigation with a brief moment where the outgoing
// and incoming screens (each with their OWN AuthScreenShell/logo/segmented
// control) were both mounted and visible, overlapping.
//
// The actual fix: there is only ONE persistent auth presentation. This
// component is mounted by BOTH app/(auth)/login.js and
// app/(auth)/register.js (each passing a different `initialMode`, so deep
// links to either URL still land on the correct starting mode) - but once
// mounted, switching modes is a plain local `authMode` state update, never
// a router call. Exactly one <AuthScreenShell> ever exists; the segmented
// control, logo, heading area, and the form card's own position never
// unmount or move - only the fields INSIDE the card swap based on
// `authMode`. The URL bar (whichever of /login or /register the user
// actually navigated to) is deliberately left as-is when toggling modes
// locally - keeping it in sync would require a router call on every
// toggle, which is exactly the mechanism that caused the original overlap
// artifact on native, so this is an intentional tradeoff, not an oversight.
export default function AuthScreen({ initialMode }) {
  const router = useRouter();
  const { signIn, signUp, session, loading: authLoading, isAdmin, adminLoading } = useAuth();
  const [authMode, setAuthMode] = useState(initialMode);
  const isLogin = authMode === 'login';

  // Shared between both modes - the same real-world value either way, so
  // there is no reason to keep two separate copies (and it means anything
  // already typed survives a mode switch instead of being silently
  // discarded).
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // Login-only state.
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  // Register-only state.
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [profession, setProfession] = useState('');
  // STAGE 26: 'YYYY-MM-DD' or '' - never defaults to today, see
  // DateOfBirthPicker's own comment. dateOfBirthError is a dedicated field
  // error (distinct from the generic registerError banner) so the picker
  // itself can show its own inline error, matching AppInput's convention
  // for fullName/phone/email/password.
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [dateOfBirthError, setDateOfBirthError] = useState('');
  const [registerError, setRegisterError] = useState('');
  const [registerSuccess, setRegisterSuccess] = useState('');
  const [registerLoading, setRegisterLoading] = useState(false);

  // STAGE 17: waits for adminLoading too, not just `session` - navigating
  // the instant `session` becomes truthy (the previous behavior) sent every
  // login to /(tabs) first, since the admin_users check hadn't resolved
  // yet; app/admin/_layout.js would then redirect an admin away from the
  // customer Home it had just shown, a visible flash of the wrong app. This
  // makes the redirect itself wait for the same role resolution app/
  // index.js's own cold-start routing already waits for, landing an admin
  // on /admin directly. Shared by both a successful login and a successful
  // registration that returns a real session (see handleRegister below).
  useEffect(() => {
    if (session && !adminLoading) {
      router.replace(isAdmin ? '/admin' : '/(tabs)');
    }
  }, [router, session, isAdmin, adminLoading]);

  // STAGE 19.2: the ONLY thing that changes on a mode switch - a plain
  // local state update. No router.push/replace/navigate of any kind.
  // Keyboard.dismiss() runs synchronously first (no delay, no animation of
  // our own) so a focused input's keyboard doesn't linger oddly across the
  // swap, but the mode switch itself is never gated behind it.
  const switchToLogin = () => {
    Keyboard.dismiss();
    setAuthMode('login');
  };

  const switchToRegister = () => {
    Keyboard.dismiss();
    setAuthMode('register');
  };

  const handleLogin = async () => {
    setLoginError('');

    if (!email.trim() || !password) {
      setLoginError('אימייל או סיסמה שגויים');
      return;
    }

    try {
      setLoginLoading(true);
      await signIn(email.trim(), password);
    } catch (error) {
      if (error?.message?.includes('Invalid login credentials')) {
        setLoginError('אימייל או סיסמה שגויים');
      } else {
        setLoginError('לא הצלחנו להתחבר. נסו שוב.');
      }
    } finally {
      setLoginLoading(false);
    }
  };

  const handleRegister = async () => {
    setRegisterError('');
    setRegisterSuccess('');
    setDateOfBirthError('');

    if (!fullName.trim() || !phone.trim() || !email.trim() || !password) {
      setRegisterError('אנא מלאו את כל השדות הנדרשים');
      return;
    }

    // STAGE 26: date of birth is required at the application level (the
    // database column itself stays nullable, for existing customers who
    // registered before this stage - see
    // supabase/migrations/028_birthday_bonus.sql). DateOfBirthPicker only
    // ever produces a real, already-clamped calendar date (its own
    // day-count math prevents e.g. Feb 30) or an empty string, so "real
    // calendar date" only needs a presence check here - but "not a future
    // date" is checked explicitly below, since the picker's year range
    // alone doesn't stop e.g. a month/day later than today within the
    // current year.
    if (!dateOfBirth) {
      setDateOfBirthError('יש לבחור תאריך לידה');
      return;
    }

    const todayIso = getIsraelTodayIso();
    if (dateOfBirth > todayIso) {
      setDateOfBirthError('תאריך הלידה אינו יכול להיות בעתיד');
      return;
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      setRegisterError(PASSWORD_TOO_SHORT_MESSAGE);
      return;
    }

    try {
      setRegisterLoading(true);
      const result = await signUp({
        email: email.trim(),
        password,
        fullName: fullName.trim(),
        phone: phone.trim(),
        profession: profession.trim(),
        dateOfBirth,
      });

      if (result.session) {
        setRegisterSuccess('ההרשמה הושלמה');
      } else {
        setRegisterSuccess('ההרשמה הושלמה. שלחנו אליכם אימייל לאישור החשבון.');
      }
    } catch (error) {
      if (error?.message?.includes('already registered')) {
        setRegisterError('כתובת האימייל כבר רשומה');
      } else {
        setRegisterError('לא הצלחנו ליצור את החשבון. נסו שוב.');
      }
    } finally {
      setRegisterLoading(false);
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
      title={isLogin ? 'ברוכים הבאים' : 'פתיחת חשבון'}
      subtitle={
        isLogin
          ? `התחברו ל ${isolateLTR('GOLDEN+')} והמשיכו לצבור נקודות`
          : `הצטרפו ל ${isolateLTR('GOLDEN+')} והתחילו לצבור נקודות`
      }
      activeTab={authMode}
      onRegisterPress={switchToRegister}
      onLoginPress={switchToLogin}>
      {isLogin ? (
        <>
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

          {loginError ? <Text style={styles.loginErrorText}>{loginError}</Text> : null}

          <PrimaryButton
            title="התחברות"
            onPress={handleLogin}
            loading={loginLoading}
            disabled={loginLoading}
            style={styles.loginButton}
          />

          <View style={styles.registerRow}>
            <Text style={styles.registerPrompt}>עדיין אין לכם חשבון?</Text>
            <TouchableOpacity onPress={switchToRegister} accessibilityRole="link" activeOpacity={0.8}>
              <Text style={styles.registerAction}>להרשמה</Text>
            </TouchableOpacity>
          </View>
        </>
      ) : (
        <>
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
            textAlign="left"
            writingDirection="ltr"
            style={styles.input}
            value={phone}
            onChangeText={setPhone}
          />

          <DateOfBirthPicker
            label="תאריך לידה *"
            value={dateOfBirth}
            onChange={setDateOfBirth}
            error={dateOfBirthError}
            style={styles.input}
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
              placeholder={`לפחות ${isolateLTR(MIN_PASSWORD_LENGTH)} תווים`}
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

          {registerError ? <Text style={styles.registerErrorText}>{registerError}</Text> : null}
          {registerSuccess ? <Text style={styles.successText}>{registerSuccess}</Text> : null}

          <PrimaryButton
            title="פתיחת חשבון"
            onPress={handleRegister}
            loading={registerLoading}
            disabled={registerLoading}
            style={styles.registerButton}
          />

          <View style={styles.registerRow}>
            <Text style={styles.registerPrompt}>כבר רשומים?</Text>
            <TouchableOpacity onPress={switchToLogin} accessibilityRole="link" activeOpacity={0.8}>
              <Text style={styles.registerAction}>התחברו</Text>
            </TouchableOpacity>
          </View>
        </>
      )}
    </AuthScreenShell>
  );
}

const styles = StyleSheet.create({
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
    // Same web-only browser-focus-ring suppression as AppInput - this field
    // renders a raw TextInput directly rather than going through AppInput.
    ...Platform.select({ web: { outlineStyle: 'none' } }),
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
  loginButton: {
    marginBottom: spacing.xl,
  },
  registerButton: {
    marginTop: spacing.xs,
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
  loginErrorText: {
    color: colors.error,
    fontSize: typography.caption.fontSize,
    lineHeight: typography.caption.lineHeight,
    textAlign: 'right',
    writingDirection: 'rtl',
    marginBottom: spacing.md,
  },
  registerErrorText: {
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