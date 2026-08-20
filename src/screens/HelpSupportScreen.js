import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import AppBackButton from '../components/common/AppBackButton';
import AppScreen from '../components/common/AppScreen';
import { colors, radius, shadows, spacing, typography } from '../theme';
import { isolateLTR } from '../utils/bidiText';

const PHONE_NUMBER = '08-8695112';
const FAX_NUMBER = '08-8695110';
const EMAIL_ADDRESS = 'sales@golden-light.co.il';

const faqItems = [
  {
    key: 'report',
    question: 'איך מדווחים על רכישה?',
    answer: "בעמוד 'דיווח רכישה' ניתן לצלם חשבונית או לבחור תמונה קיימת ולהעלות אותה לבדיקה.",
  },
  {
    key: 'points',
    question: 'מתי אקבל את הנקודות?',
    answer: 'הנקודות יתווספו לחשבון לאחר שהחשבונית תיבדק ותאושר.',
  },
  {
    key: 'status',
    question: 'איך אדע מה סטטוס החשבונית?',
    answer: 'ניתן לעקוב אחר החשבוניות והסטטוס שלהן דרך היסטוריית הרכישות.',
  },
  {
    key: 'unidentified',
    question: 'מה עושים אם החשבונית לא זוהתה?',
    answer: 'חשבונית שלא ניתן לזהות באופן מלא תועבר לבדיקה, והסטטוס שלה יתעדכן בהתאם.',
  },
];

async function openUrlSafely(url) {
  try {
    const canOpen = await Linking.canOpenURL(url);
    if (canOpen) {
      await Linking.openURL(url);
    }
  } catch (err) {
    if (__DEV__) {
      console.warn('[HelpSupport] Failed to open URL', url, err);
    }
  }
}

export default function HelpSupportScreen() {
  const [expandedKey, setExpandedKey] = useState(null);
  const [rootHeight, setRootHeight] = useState(0);
  const [heroHeight, setHeroHeight] = useState(0);

  // Same measured-minHeight approach as ProfileScreen/EditProfileScreen/
  // ChangePasswordScreen's dark hero + light sheet (see HomeScreen for the
  // full explanation) - guarantees the light sheet reaches the bottom of
  // the real screen regardless of the flex-grow chain between here and the
  // ScrollView.
  const onRootLayout = useCallback((event) => {
    setRootHeight(event.nativeEvent.layout.height);
  }, []);
  const onHeroLayout = useCallback((event) => {
    setHeroHeight(event.nativeEvent.layout.height);
  }, []);
  const sheetMinHeight =
    rootHeight > 0 && heroHeight > 0 ? rootHeight - heroHeight + radius.xl : undefined;

  const handleCall = () => {
    openUrlSafely(`tel:${PHONE_NUMBER}`);
  };

  const handleEmail = () => {
    openUrlSafely(`mailto:${EMAIL_ADDRESS}`);
  };

  const toggleFaq = (key) => {
    setExpandedKey((current) => (current === key ? null : key));
  };

  return (
    <View style={styles.root} onLayout={onRootLayout}>
      {/* Full-bleed dark hero, same technique/tokens as ProfileScreen/
          EditProfileScreen/ChangePasswordScreen's own hero (see HomeScreen
          for the full explanation), kept compact - back button +
          title/subtitle only, no bulky content. */}
      <LinearGradient
        colors={[colors.bgDark, colors.charcoal]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={styles.heroGradient}
      />

      <AppScreen
        backgroundColor="transparent"
        contentContainerStyle={styles.screenContent}
        style={styles.screenInner}
        // No bottom edge - same reasoning as the other tab-adjacent screens
        // (this route lives under (tabs), which already provides its own
        // clearance below the content).
        edges={['top', 'left', 'right']}>
        <View style={styles.heroSection} onLayout={onHeroLayout}>
          <View style={styles.heroInner}>
            <AppBackButton
              fallbackRoute="/(tabs)/profile"
              color={colors.mutedOnDark}
              style={styles.headerBackButton}
            />
            <View style={styles.headerTextBlock}>
              <Text style={styles.title}>עזרה ותמיכה</Text>
              <Text style={styles.subtitle}>אנחנו כאן כדי לעזור</Text>
            </View>
          </View>
        </View>

        {/* Light content sheet - same full-bleed/rounded-top/measured-
            minHeight pattern as the other screens' own sheet. */}
        <View style={[styles.sheet, sheetMinHeight ? { minHeight: sheetMinHeight } : null]}>
          <View style={styles.sheetInner}>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>צרו איתנו קשר</Text>

              <Pressable
                style={({ pressed }) => [styles.contactRow, pressed && styles.contactRowPressed]}
                onPress={handleCall}
                accessibilityRole="button">
                <View style={styles.contactIconWrap}>
                  <Ionicons name="call-outline" size={18} color={colors.primary} />
                </View>
                <View style={styles.contactTextWrap}>
                  <Text style={styles.contactLabel}>טלפון</Text>
                  <Text style={styles.contactValue}>{isolateLTR(PHONE_NUMBER)}</Text>
                </View>
                <Ionicons name="chevron-back" size={16} color={colors.textMuted} />
              </Pressable>

              <Pressable
                style={({ pressed }) => [styles.contactRow, pressed && styles.contactRowPressed]}
                onPress={handleEmail}
                accessibilityRole="button">
                <View style={styles.contactIconWrap}>
                  <Ionicons name="mail-outline" size={18} color={colors.primary} />
                </View>
                <View style={styles.contactTextWrap}>
                  <Text style={styles.contactLabel}>אימייל</Text>
                  <Text style={styles.contactValue}>{isolateLTR(EMAIL_ADDRESS)}</Text>
                </View>
                <Ionicons name="chevron-back" size={16} color={colors.textMuted} />
              </Pressable>

              <View style={[styles.contactRow, styles.contactRowLast]}>
                <View style={styles.contactIconWrap}>
                  <Ionicons name="document-text-outline" size={18} color={colors.primary} />
                </View>
                <View style={styles.contactTextWrap}>
                  <Text style={styles.contactLabel}>פקס</Text>
                  <Text style={styles.contactValue}>{isolateLTR(FAX_NUMBER)}</Text>
                </View>
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>{`קצת על ${isolateLTR('Golden Light')}`}</Text>
              <Text style={styles.aboutText}>
                גולדן לייט מתמחה בייבוא, ייצור ושיווק גופי תאורה ופתרונות תאורה בישראל. החברה מספקת
                פתרונות ללקוחות פרטיים ועסקיים, מוסדות, אדריכלים ומעצבים.
              </Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>שאלות נפוצות</Text>
              <View style={styles.faqList}>
                {faqItems.map((item, index) => {
                  const isExpanded = expandedKey === item.key;
                  return (
                    <View
                      key={item.key}
                      style={[styles.faqItem, index === faqItems.length - 1 && styles.faqItemLast]}>
                      <Pressable
                        style={styles.faqQuestionRow}
                        onPress={() => toggleFaq(item.key)}
                        accessibilityRole="button"
                        accessibilityState={{ expanded: isExpanded }}>
                        <Ionicons
                          name={isExpanded ? 'chevron-up-outline' : 'chevron-down-outline'}
                          size={18}
                          color={colors.textMuted}
                        />
                        <Text style={styles.faqQuestionText}>{item.question}</Text>
                      </Pressable>
                      {isExpanded ? <Text style={styles.faqAnswerText}>{item.answer}</Text> : null}
                    </View>
                  );
                })}
              </View>
            </View>
          </View>
        </View>
      </AppScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  heroGradient: {
    ...StyleSheet.absoluteFillObject,
  },
  // Same cancel-AppScreen's-own-wrapper technique as the other screens (see
  // HomeScreen's screenInner comment for the full flex-chain explanation).
  screenInner: {
    flex: 1,
    width: '100%',
    maxWidth: '100%',
    alignSelf: 'stretch',
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  screenContent: {
    flexGrow: 1,
  },
  // Deliberately short - back button + title/subtitle only, no bulky
  // content, matching ProfileScreen/EditProfileScreen/ChangePasswordScreen's
  // own compact secondary-screen hero.
  heroSection: {
    paddingTop: spacing.sm,
    // Extra bottom padding absorbs the sheet's negative marginTop overlap
    // below (see `sheet`), so the rounded corners never cut into the
    // header text.
    paddingBottom: spacing.xl + radius.xl,
  },
  heroInner: {
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    position: 'relative',
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
    color: colors.textOnDark,
    textAlign: 'right',
  },
  subtitle: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.mutedOnDark,
    textAlign: 'right',
    marginTop: spacing.xs,
    lineHeight: 18,
  },
  sheet: {
    flex: 1,
    backgroundColor: colors.background,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    marginTop: -radius.xl,
  },
  sheetInner: {
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xl,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
  },
  card: {
    width: '100%',
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.softCard,
  },
  cardTitle: {
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
    marginBottom: spacing.sm,
  },
  contactRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    minHeight: 44,
    borderTopWidth: 1,
    borderTopColor: colors.surfaceMuted,
  },
  contactRowPressed: {
    opacity: 0.7,
  },
  contactRowLast: {
    paddingBottom: 0,
  },
  contactIconWrap: {
    width: 34,
    height: 34,
    borderRadius: radius.md,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  contactTextWrap: {
    flex: 1,
    alignItems: 'flex-end',
  },
  contactLabel: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
  },
  contactValue: {
    fontSize: typography.body.fontSize,
    fontWeight: '600',
    color: colors.text,
    textAlign: 'right',
    marginTop: 2,
    writingDirection: 'ltr',
  },
  aboutText: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
    lineHeight: 20,
  },
  faqList: {
    width: '100%',
  },
  faqItem: {
    borderTopWidth: 1,
    borderTopColor: colors.surfaceMuted,
    paddingVertical: spacing.md,
  },
  faqItemLast: {
    paddingBottom: 0,
  },
  faqQuestionRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.sm,
  },
  faqQuestionText: {
    flex: 1,
    fontSize: typography.caption.fontSize,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  faqAnswerText: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
    lineHeight: 20,
    marginTop: spacing.sm,
  },
});
