import { Ionicons } from '@expo/vector-icons';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import AppScreen from '../components/common/AppScreen';
import PrimaryButton from '../components/common/PrimaryButton';
import { useAuth } from '../context/AuthContext';
import { submitPurchaseReceipt } from '../services/purchaseReportService';
import { colors, radius, shadows, spacing, typography } from '../theme';
import { isolateLTR } from '../utils/bidiText';
import { detectImageFormat } from '../utils/receiptImageFormat';

const UNSUPPORTED_IMAGE_FORMAT_MESSAGE = `פורמט תמונה לא נתמך. בחרו ${isolateLTR('JPG, PNG')} או ${isolateLTR('WEBP')}.`;

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

const DETECTED_FORMAT_MIME_TYPES = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

function isSupportedReceiptAsset(asset) {
  const mimeType = asset?.mimeType || asset?.type || '';
  if (!mimeType) {
    const name = String(asset?.fileName || asset?.name || '').toLowerCase();
    return name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png') || name.endsWith('.webp');
  }

  return supportedReceiptTypes.includes(mimeType.toLowerCase());
}

// STAGE 15.1 FOLLOW-UP: since Expo SDK 54, ImagePicker (used here with
// `allowsEditing: false`) can return an asset's ORIGINAL file untouched -
// including native HEIC photos, the iPhone Camera app's default capture
// format - while `asset.mimeType`/`asset.fileName` may be missing or not
// reflect that. Trusting those fields alone (the previous behavior) could
// silently upload real HEIC bytes labeled as JPEG, which most image
// decoders then refuse to render - a successful upload with a permanently
// blank thumbnail.
//
// This reads the asset's real file signature first. When it can be
// determined AND is already one of this app's supported formats, that
// verified format is used directly (skipping the metadata-based guess
// entirely - no re-encoding, so receipt quality for OCR is untouched).
// When the real format is HEIC, the file is converted to JPEG via
// expo-image-manipulator before upload - the smallest change that makes a
// same format actually renderable, since there's no way to store or display
// the original HEIC bytes correctly otherwise. When the real format can't
// be determined (e.g. running on web, or a native read failure), this falls
// back to the original metadata-based check unchanged, exactly as before.
// STAGE 15.2: `sourceLabel` ('camera' | 'library') is only used for the
// DEV-only diagnostic log below - side-by-side timing/metadata for both
// picker paths, to compare a working library pick against a camera capture
// without ever logging image bytes/contents or secrets.
async function resolveReceiptAsset(asset, sourceLabel) {
  const detectedFormat = await detectImageFormat(asset.uri);
  let result;
  let converted = null;

  if (detectedFormat === 'heic') {
    const rendered = await ImageManipulator.manipulate(asset.uri).renderAsync();
    converted = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 1 });
    result = { uri: converted.uri, name: 'receipt.jpg', type: 'image/jpeg' };
  } else if (detectedFormat === 'jpeg' || detectedFormat === 'png' || detectedFormat === 'webp') {
    result = {
      uri: asset.uri,
      name: asset.fileName || 'receipt.jpg',
      type: DETECTED_FORMAT_MIME_TYPES[detectedFormat],
    };
  } else if (isSupportedReceiptAsset(asset)) {
    result = {
      uri: asset.uri,
      name: asset.fileName || 'receipt.jpg',
      type: asset.mimeType || 'image/jpeg',
    };
  } else {
    result = null;
  }

  if (__DEV__) {
    console.log('[Purchase] Receipt asset resolved', {
      source: sourceLabel,
      uriScheme: String(asset.uri || '').split(':')[0] || null,
      claimedFileName: asset.fileName || null,
      claimedMimeType: asset.mimeType || null,
      detectedFormat,
      convertedToJpeg: Boolean(converted),
      convertedWidth: converted?.width ?? null,
      convertedHeight: converted?.height ?? null,
      resolvedUriScheme: result ? String(result.uri || '').split(':')[0] || null : null,
      resolvedType: result?.type || null,
      supported: Boolean(result),
    });
  }

  return result;
}

export default function PurchaseScreen() {
  const { user } = useAuth();
  const [selectedReceipt, setSelectedReceipt] = useState(null);
  const [status, setStatus] = useState('מוכן לשליחה');
  const [error, setError] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [rootHeight, setRootHeight] = useState(0);
  const [heroHeight, setHeroHeight] = useState(0);

  // Synchronous re-entrancy guard for handleSubmit, separate from the
  // isUploading STATE above. State updates are batched/async - two rapid
  // taps on the submit button can both read isUploading as still `false`
  // before the first tap's setIsUploading(true) has actually re-rendered
  // the button into its disabled state, which would let both taps start a
  // real upload + purchase_reports insert + OCR dispatch. A ref is read
  // and written synchronously, with no render in between, so the second
  // near-simultaneous call sees the first call's guard immediately.
  const isSubmittingRef = useRef(false);

  // Same measured-minHeight approach as HomeScreen/ProfileScreen's dark
  // hero + light sheet (see HomeScreen for the full explanation) -
  // guarantees the light sheet reaches the bottom of the real screen
  // regardless of the flex-grow chain between here and the ScrollView.
  const onRootLayout = useCallback((event) => {
    setRootHeight(event.nativeEvent.layout.height);
  }, []);
  const onHeroLayout = useCallback((event) => {
    setHeroHeight(event.nativeEvent.layout.height);
  }, []);
  const sheetMinHeight =
    rootHeight > 0 && heroHeight > 0 ? rootHeight - heroHeight + radius.xl : undefined;

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

        const resolvedCamera = await resolveReceiptAsset(asset, 'camera');
        if (!resolvedCamera) {
          setError(UNSUPPORTED_IMAGE_FORMAT_MESSAGE);
          return;
        }

        setSelectedReceipt(resolvedCamera);
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

      const resolvedLibrary = await resolveReceiptAsset(asset, 'library');
      if (!resolvedLibrary) {
        setError(UNSUPPORTED_IMAGE_FORMAT_MESSAGE);
        return;
      }

      setSelectedReceipt(resolvedLibrary);
      setStatus('מוכן לשליחה');
    } catch (err) {
      if (__DEV__) {
        console.warn('[Purchase] Failed to pick receipt', err);
      }
      setError('לא הצלחנו לבחור את החשבונית');
    }
  };

  const handleSubmit = async () => {
    if (!selectedReceipt || !user?.id || isSubmittingRef.current) {
      return;
    }

    isSubmittingRef.current = true;

    try {
      setIsUploading(true);
      setError('');
      setStatus('מעלה את החשבונית...');
      await submitPurchaseReceipt({ file: selectedReceipt, userId: user.id });
      setStatus('החשבונית נשלחה לבדיקה');
    } catch (err) {
      if (__DEV__) {
        console.warn('[Purchase] Failed to submit receipt', err);
      }
      setStatus('מוכן לשליחה');
      setError('לא הצלחנו לשלוח את החשבונית. נסו שוב.');
    } finally {
      isSubmittingRef.current = false;
      setIsUploading(false);
    }
  };

  const receiptCard = useMemo(() => {
    if (!selectedReceipt) {
      return null;
    }

    const isSent = status === 'החשבונית נשלחה לבדיקה';

    return (
      <View style={styles.receiptCard}>
        <View style={styles.receiptHeader}>
          <Text style={styles.receiptTitle}>חשבונית נבחרה</Text>
          <View style={[styles.receiptStatusPill, isSent && styles.receiptStatusPillSent]}>
            <Text style={[styles.receiptStatusText, isSent && styles.receiptStatusTextSent]} numberOfLines={1}>
              {status}
            </Text>
          </View>
        </View>

        <View style={styles.receiptFileRow}>
          <View style={styles.receiptFileIconWrap}>
            <Ionicons name="document-attach-outline" size={18} color={colors.primary} />
          </View>
          <View style={styles.receiptFileInfo}>
            <Text style={styles.receiptName} numberOfLines={1}>
              {isolateLTR(selectedReceipt.name)}
            </Text>
            <Text style={styles.receiptMeta}>מוכן לשליחה</Text>
          </View>
        </View>

        {isSent ? (
          <View style={styles.successBox}>
            <Ionicons name="checkmark-circle-outline" size={18} color={colors.success} />
            <Text style={styles.successText}>נעדכן אתכם כשהנקודות יתווספו לחשבון</Text>
          </View>
        ) : (
          <PrimaryButton
            title="שליחה לסריקה"
            onPress={handleSubmit}
            loading={isUploading}
            disabled={isUploading}
            style={styles.submitButton}
          />
        )}

        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </View>
    );
  }, [error, handleSubmit, isUploading, selectedReceipt, status]);

  return (
    <View style={styles.root} onLayout={onRootLayout}>
      {/* Full-bleed dark hero, same technique/tokens as HomeScreen/
          ProfileScreen's own hero (see HomeScreen for the full
          explanation) - keeps every premium dark surface visually
          identical across screens. */}
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
        // No bottom edge - same reasoning as HomeScreen/ProfileScreen
        // (nested under the (tabs) bottom bar, which already provides its
        // own clearance).
        edges={['top', 'left', 'right']}>
        <View style={styles.heroSection} onLayout={onHeroLayout}>
          <View style={styles.heroInner}>
            <Text style={styles.title}>דיווח רכישה</Text>
            <Text style={styles.subtitle}>צלמו או העלו חשבונית ואנחנו נחשב את הנקודות שלכם</Text>
          </View>
        </View>

        {/* Light content sheet - same full-bleed/rounded-top/measured-
            minHeight pattern as HomeScreen/ProfileScreen's own sheet. */}
        <View style={[styles.sheet, sheetMinHeight ? { minHeight: sheetMinHeight } : null]}>
          <View style={styles.sheetInner}>
            <View style={styles.section}>

              <View style={styles.optionsRow}>
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

            <View style={styles.tipsCard}>
              <Text style={styles.tipsTitle}>כדי שנוכל לזהות את החשבונית</Text>
              <View style={styles.tipsList}>
                {tips.map((tip) => (
                  <Text key={tip} style={styles.tipItem}>• {tip}</Text>
                ))}
              </View>
            </View>

            <View style={styles.infoCard}>
              <View style={styles.infoHeader}>
                <View style={styles.infoIconWrap}>
                  <Ionicons name="information-circle-outline" size={18} color={colors.primary} />
                </View>
                <Text style={styles.infoTitle}>מה קורה אחרי ההעלאה?</Text>
              </View>
              <View style={styles.stepsList}>
                <Text style={styles.stepItem}>{`${isolateLTR('1.')} אנחנו סורקים את החשבונית`}</Text>
                <Text style={styles.stepItem}>
                  {`${isolateLTR('2.')} מזהים את מוצרי ${isolateLTR('Golden Light')}`}
                </Text>
                <Text style={styles.stepItem}>{`${isolateLTR('3.')} מחשבים ומעדכנים את הנקודות`}</Text>
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
  // Same cancel-AppScreen's-own-wrapper technique as HomeScreen/ProfileScreen
  // (see HomeScreen's screenInner comment for the full flex-chain
  // explanation).
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
  heroSection: {
    paddingTop: spacing.sm,
    // Extra bottom padding absorbs the sheet's negative marginTop overlap
    // below (see `sheet`), so the rounded corners never cut into the hero
    // text.
    paddingBottom: spacing.xxl + radius.xl,
  },
  heroInner: {
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    alignItems: 'flex-end',
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
    gap: spacing.lg,
  },
  section: {
    gap: spacing.md,
  },
  sectionHeaderRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
  },
  sectionHeadingGroup: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.xs,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    lineHeight: 24,
    color: colors.text,
    textAlign: 'right',
  },
  sectionAccentDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.primary,
  },
  // Negative marginTop pulls this right under the heading row (matching
  // `section`'s own gap:spacing.md rhythm) instead of stacking an extra
  // gap on top of it, since it isn't part of `section`'s own gap flow.
  sectionSubtitle: {
    fontSize: typography.caption.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: -spacing.sm,
  },
  // Same flex:1-in-a-gap-row pattern as HomeScreen's actionsRow/actionCard -
  // the two upload choices read as one consistent pair of premium action
  // cards, the same visual language as Quick Actions on Home.
  optionsRow: {
    flexDirection: 'row-reverse',
    gap: spacing.md,
    alignItems: 'stretch',
  },
  optionCard: {
    flex: 1,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xl,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.softCard,
    alignItems: 'flex-end',
    minHeight: 132,
    justifyContent: 'center',
  },
  // Subtle turquoise border on press instead of a heavier neon glow/opacity
  // dip - stays premium and restrained (matching actionCardPressed on Home).
  optionCardPressed: {
    borderColor: colors.primary,
    opacity: 0.97,
  },
  optionCardDisabled: {
    opacity: 0.6,
  },
  optionIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 14,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
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
    marginTop: spacing.xs,
  },
  receiptCard: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.softCard,
  },
  receiptHeader: {
    flexDirection: 'row-reverse',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  receiptTitle: {
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  receiptStatusPill: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    backgroundColor: colors.primarySoft,
    flexShrink: 1,
  },
  receiptStatusPillSent: {
    backgroundColor: colors.successSoft,
  },
  receiptStatusText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.primaryPressed,
    textAlign: 'center',
  },
  receiptStatusTextSent: {
    color: colors.success,
  },
  receiptFileRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  receiptFileIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  receiptFileInfo: {
    flex: 1,
    alignItems: 'flex-end',
  },
  receiptName: {
    fontSize: typography.caption.fontSize,
    fontWeight: '600',
    color: colors.text,
    textAlign: 'right',
  },
  receiptMeta: {
    fontSize: 11,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: 2,
  },
  submitButton: {
    marginTop: spacing.lg,
  },
  successBox: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.lg,
    backgroundColor: colors.successSoft,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  successText: {
    flex: 1,
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
  // Light turquoise tint (not a heavy shadowed white card) - reads as the
  // primary explainer, one step more prominent than the neutral tips card
  // below it.
  infoCard: {
    backgroundColor: colors.primarySoft,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  infoHeader: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.xs,
  },
  infoIconWrap: {
    width: 28,
    height: 28,
    borderRadius: 10,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
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
    color: colors.text,
    textAlign: 'right',
    lineHeight: 18,
  },
  // Neutral (not turquoise-tinted) - lower visual priority than infoCard
  // above, matching "do not overload the screen" / clear hierarchy.
  tipsCard: {
    backgroundColor: colors.surfaceElevated,
    borderRadius: radius.md,
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
