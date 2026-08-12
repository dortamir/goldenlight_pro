import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import AppBackButton from '../components/common/AppBackButton';
import AppScreen from '../components/common/AppScreen';
import { colors, spacing, typography } from '../theme';

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
    <AppScreen backgroundColor={colors.background} contentContainerStyle={styles.screenContent}>
      <View style={styles.container}>
        <View style={styles.header}>
          <AppBackButton fallbackRoute="/(tabs)/profile" style={styles.headerBackButton} />
          <View style={styles.headerTextBlock}>
            <Text style={styles.title}>עזרה ותמיכה</Text>
            <Text style={styles.subtitle}>אנחנו כאן כדי לעזור</Text>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>צרו איתנו קשר</Text>

          <Pressable style={styles.contactRow} onPress={handleCall} accessibilityRole="button">
            <View style={styles.contactIconWrap}>
              <Ionicons name="call-outline" size={20} color={colors.primary} />
            </View>
            <View style={styles.contactTextWrap}>
              <Text style={styles.contactLabel}>טלפון</Text>
              <Text style={styles.contactValue}>{PHONE_NUMBER}</Text>
            </View>
          </Pressable>

          <Pressable style={styles.contactRow} onPress={handleEmail} accessibilityRole="button">
            <View style={styles.contactIconWrap}>
              <Ionicons name="mail-outline" size={20} color={colors.primary} />
            </View>
            <View style={styles.contactTextWrap}>
              <Text style={styles.contactLabel}>אימייל</Text>
              <Text style={styles.contactValue}>{EMAIL_ADDRESS}</Text>
            </View>
          </Pressable>

          <View style={[styles.contactRow, styles.contactRowLast]}>
            <View style={styles.contactIconWrap}>
              <Ionicons name="document-text-outline" size={20} color={colors.primary} />
            </View>
            <View style={styles.contactTextWrap}>
              <Text style={styles.contactLabel}>פקס</Text>
              <Text style={styles.contactValue}>{FAX_NUMBER}</Text>
            </View>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>קצת על Golden Light</Text>
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
    backgroundColor: colors.white,
    borderRadius: 16,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: colors.black,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.04,
    shadowRadius: 6,
    elevation: 2,
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
    borderTopWidth: 1,
    borderTopColor: colors.surfaceMuted,
  },
  contactRowLast: {
    paddingBottom: 0,
  },
  contactIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
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
