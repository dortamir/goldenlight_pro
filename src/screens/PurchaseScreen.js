import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import AppScreen from '../components/common/AppScreen';
import { useAuth } from '../context/AuthContext';
import { submitPurchaseReceipt } from '../services/purchaseReportService';
import { colors, shadows, spacing, typography } from '../theme';

const uploadOptions = [
  {
    key: 'camera',
    title: 'צילום חשבונית',
    subtitle: 'פתחו מצלמה וצילמו את החשבונית',
    icon: 'camera-outline',
  },
  {
    key: 'gallery',
    title: 'בחירת תמונה',
    subtitle: 'בחרו תמונה קיימת מהמכשיר',
    icon: 'images-outline',
  },
];

const tips = [
  'צלמו את כל החשבונית',
  'ודאו שהטקסט ברור ולא מטושטש',
  'הימנעו מצללים והשתקפויות',
];

const supportedReceiptTypes = ['image/jpeg', 'image/png', 'image/webp'];

function isSupportedReceiptAsset(asset) {
  const mimeType = asset?.mimeType || asset?.type || '';
  if (!mimeType) {
    const name = String(asset?.fileName || asset?.name || '').toLowerCase();
    return name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png') || name.endsWith('.webp');
  }

  return supportedReceiptTypes.includes(mimeType.toLowerCase());
}

export default function PurchaseScreen() {
  const { user } = useAuth();
  const [selectedReceipt, setSelectedReceipt] = useState(null);
  const [status, setStatus] = useState('מוכן לשליחה');
  const [error, setError] = useState('');
  const [isUploading, setIsUploading] = useState(false);

  const handlePickReceipt = async (mode) => {
    try {
      setError('');

      if (mode === 'camera') {
        const cameraPermission = await ImagePicker.requestCameraPermissionsAsync();
        if (!cameraPermission.granted) {
          setError('לא ניתנה הרשאה למצלמה');
          return;
        }

        const result = await ImagePicker.launchCameraAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.Images,
          quality: 0.8,
          allowsEditing: false,
        });

        if (result.canceled) {
          return;
        }

        const asset = result.assets?.[0];
        if (!asset) {
          return;
        }

        if (!isSupportedReceiptAsset(asset)) {
          setError('פורמט תמונה לא נתמך. בחרו JPG, PNG או WEBP.');
          return;
        }

        setSelectedReceipt({
          uri: asset.uri,
          name: asset.fileName || 'receipt.jpg',
          type: asset.mimeType || 'image/jpeg',
        });
        setStatus('מוכן לשליחה');
        return;
      }

      const photoPermission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!photoPermission.granted) {
        setError('לא ניתנה הרשאה לגישה לתמונות');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.8,
        allowsEditing: false,
      });

      if (result.canceled) {
        return;
      }

      const asset = result.assets?.[0];
      if (!asset) {
        return;
      }

      if (!isSupportedReceiptAsset(asset)) {
        setError('פורמט תמונה לא נתמך. בחרו JPG, PNG או WEBP.');
        return;
      }

      setSelectedReceipt({
        uri: asset.uri,
        name: asset.fileName || 'receipt.jpg',
        type: asset.mimeType || 'image/jpeg',
      });
      setStatus('מוכן לשליחה');
    } catch (err) {
      console.warn('[Purchase] Failed to pick receipt', err);
      setError('לא הצלחנו לבחור את החשבונית');
    }
  };

  const handleSubmit = async () => {
    if (!selectedReceipt || !user?.id || isUploading) {
      return;
    }

    try {
      setIsUploading(true);
      setError('');
      setStatus('מעלה את החשבונית...');
      await submitPurchaseReceipt({ file: selectedReceipt, userId: user.id });
      setStatus('החשבונית נשלחה לבדיקה');
    } catch (err) {
      console.warn('[Purchase] Failed to submit receipt', err);
      setStatus('מוכן לשליחה');
      setError('לא הצלחנו לשלוח את החשבונית. נסו שוב.');
    } finally {
      setIsUploading(false);
    }
  };

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

        <Text style={styles.receiptName}>{selectedReceipt.name}</Text>
        <Text style={styles.receiptMeta}>מוכן לשליחה</Text>

        {status === 'החשבונית נשלחה לבדיקה' ? (
          <View style={styles.successBox}>
            <Text style={styles.successText}>נעדכן אתכם כשהנקודות יתווספו לחשבון</Text>
          </View>
        ) : (
          <Pressable style={[styles.submitButton, isUploading && styles.submitButtonDisabled]} onPress={handleSubmit} disabled={isUploading}>
            {isUploading ? <ActivityIndicator color={colors.white} /> : <Text style={styles.submitButtonText}>שליחה לסריקה</Text>}
          </Pressable>
        )}

        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </View>
    );
  }, [error, handleSubmit, isUploading, selectedReceipt, status]);

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
                style={({ pressed }) => [
                  styles.optionCard,
                  pressed && !isUploading && styles.optionCardPressed,
                  isUploading && styles.optionCardDisabled,
                ]}
                onPress={() => handlePickReceipt(option.key === 'camera' ? 'camera' : 'gallery')}
                disabled={isUploading}>
                <View style={styles.optionIconWrap}>
                  <Ionicons name={option.icon} size={20} color={colors.primary} />
                </View>
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
    ...shadows.softCard,
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
    backgroundColor: colors.white,
    borderRadius: 14,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'flex-end',
    minHeight: 84,
    justifyContent: 'center',
    ...shadows.softCard,
  },
  optionCardPressed: {
    backgroundColor: colors.primarySoft,
    borderColor: colors.primary,
  },
  optionCardDisabled: {
    opacity: 0.7,
  },
  optionIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 11,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
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
    ...shadows.softCard,
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
  submitButtonDisabled: {
    opacity: 0.7,
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
  errorText: {
    fontSize: typography.caption.fontSize,
    fontWeight: '600',
    color: colors.error,
    textAlign: 'right',
    marginTop: spacing.sm,
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
