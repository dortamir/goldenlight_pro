import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import AppScreen from '../components/common/AppScreen';
import { colors, spacing, typography } from '../theme';

const uploadOptions = [
  {
    key: 'camera',
    title: 'צילום חשבונית',
    subtitle: 'פתחו מצלמה וצילמו את החשבונית',
  },
  {
    key: 'gallery',
    title: 'בחירת תמונה',
    subtitle: 'בחרו תמונה קיימת מהמכשיר',
  },
];

const tips = [
  'צלמו את כל החשבונית',
  'ודאו שהטקסט ברור ולא מטושטש',
  'הימנעו מצללים והשתקפויות',
];

export default function PurchaseScreen() {
  const [selectedReceipt, setSelectedReceipt] = useState(false);
  const [status, setStatus] = useState('מוכן לסריקה');

  const receiptCard = useMemo(() => {
    if (!selectedReceipt) {
      return null;
    }

    return (
      <View style={styles.receiptCard}>
        <View style={styles.receiptHeader}>
          <Text style={styles.receiptTitle}>חשבונית נבחרה</Text>
          <Text style={styles.receiptStatus}>{status}</Text>
        </View>

        <Text style={styles.receiptName}>receipt_1248.jpg</Text>
        <Text style={styles.receiptMeta}>סטטוס: {status}</Text>

        {status === 'מוכן לסריקה' ? (
          <Pressable style={styles.submitButton} onPress={() => setStatus('החשבונית נשלחה לבדיקה')}>
            <Text style={styles.submitButtonText}>שליחה לסריקה</Text>
          </Pressable>
        ) : (
          <View style={styles.successBox}>
            <Text style={styles.successText}>נעדכן אתכם כשהנקודות יתווספו לחשבון</Text>
          </View>
        )}
      </View>
    );
  }, [selectedReceipt, status]);

  return (
    <AppScreen backgroundColor={colors.background} contentContainerStyle={styles.screenContent}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>דיווח רכישה</Text>
          <Text style={styles.subtitle}>צלמו או העלו חשבונית ואנחנו נחשב את הנקודות שלכם</Text>
        </View>

        <View style={styles.uploadCard}>
          <View style={styles.uploadHeader}>
            <Text style={styles.cardTitle}>העלאת חשבונית</Text>
            <Text style={styles.cardSubtitle}>ניתן לצלם חשבונית חדשה או לבחור תמונה קיימת</Text>
          </View>

          <View style={styles.actionsStack}>
            {uploadOptions.map((option) => (
              <Pressable
                key={option.key}
                style={styles.optionCard}
                onPress={() => {
                  setSelectedReceipt(true);
                  setStatus('מוכן לסריקה');
                }}>
                <View style={styles.optionAccent} />
                <Text style={styles.optionTitle}>{option.title}</Text>
                <Text style={styles.optionSubtitle}>{option.subtitle}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        {receiptCard}

        <View style={styles.infoCard}>
          <Text style={styles.infoTitle}>מה קורה אחרי ההעלאה?</Text>
          <View style={styles.stepsList}>
            <Text style={styles.stepItem}>1. אנחנו סורקים את החשבונית</Text>
            <Text style={styles.stepItem}>2. מזהים את מוצרי Golden Light</Text>
            <Text style={styles.stepItem}>3. מחשבים ומעדכנים את הנקודות</Text>
          </View>
        </View>

        <View style={styles.tipsCard}>
          <Text style={styles.tipsTitle}>כדי שנוכל לזהות את החשבונית</Text>
          <View style={styles.tipsList}>
            {tips.map((tip) => (
              <Text key={tip} style={styles.tipItem}>• {tip}</Text>
            ))}
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
  },
  container: {
    width: '100%',
    gap: spacing.lg,
  },
  header: {
    alignItems: 'flex-end',
    paddingBottom: spacing.xs,
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
  uploadCard: {
    backgroundColor: colors.white,
    borderRadius: 20,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: colors.black,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 10,
    elevation: 2,
  },
  uploadHeader: {
    alignItems: 'flex-end',
    marginBottom: spacing.md,
  },
  cardTitle: {
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  cardSubtitle: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: spacing.xs,
  },
  actionsStack: {
    gap: spacing.sm,
  },
  optionCard: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: 14,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'flex-end',
    minHeight: 84,
    justifyContent: 'center',
  },
  optionAccent: {
    width: 24,
    height: 3,
    borderRadius: 999,
    backgroundColor: colors.primary,
    marginBottom: spacing.xs,
  },
  optionTitle: {
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  optionSubtitle: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: 4,
  },
  receiptCard: {
    backgroundColor: colors.white,
    borderRadius: 18,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.primarySoft,
    shadowColor: colors.black,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  receiptHeader: {
    flexDirection: 'row-reverse',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  receiptTitle: {
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  receiptStatus: {
    fontSize: typography.caption.fontSize,
    fontWeight: '700',
    color: colors.primary,
    textAlign: 'right',
  },
  receiptName: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: spacing.sm,
  },
  receiptMeta: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: 2,
  },
  submitButton: {
    marginTop: spacing.md,
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  submitButtonText: {
    fontSize: typography.button.fontSize,
    fontWeight: typography.button.fontWeight,
    color: colors.white,
    textAlign: 'center',
  },
  successBox: {
    marginTop: spacing.md,
    backgroundColor: colors.primarySoft,
    borderRadius: 12,
    padding: spacing.md,
  },
  successText: {
    fontSize: typography.caption.fontSize,
    fontWeight: '600',
    color: colors.text,
    textAlign: 'right',
  },
  infoCard: {
    backgroundColor: colors.white,
    borderRadius: 18,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  infoTitle: {
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  stepsList: {
    gap: 8,
    marginTop: spacing.sm,
  },
  stepItem: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
    lineHeight: 18,
  },
  tipsCard: {
    backgroundColor: colors.surfaceElevated,
    borderRadius: 16,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tipsTitle: {
    fontSize: typography.caption.fontSize,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  tipsList: {
    gap: 6,
    marginTop: spacing.xs,
  },
  tipItem: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
    lineHeight: 18,
  },
});
