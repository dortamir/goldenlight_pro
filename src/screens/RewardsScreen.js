import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Image, Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import AppScreen from '../components/common/AppScreen';
import PointsBalanceCard from '../components/common/PointsBalanceCard';
import PrimaryButton from '../components/common/PrimaryButton';
import { GOLDEN_LIGHT_WEBSITE_URL, POINTS_REDEMPTION_URL } from '../constants/externalLinks';
import { useAuth } from '../context/AuthContext';
import { getProfile } from '../services/profileService';
import { colors, radius, shadows, spacing, typography } from '../theme';
import { isolateLTR } from '../utils/bidiText';

// Opens an external link through the same safe canOpenURL-gated mechanism
// already used elsewhere in the app (see HelpSupportScreen's
// openUrlSafely), plus an explicit guard for the not-yet-configured
// placeholder URLs in constants/externalLinks.js: a null/empty url means
// "this destination isn't ready yet" and is intentionally a no-op, never a
// navigation to a fake/invented destination.
async function openExternalLinkSafely(url) {
  if (!url) {
    if (__DEV__) {
      console.warn('[Rewards] Tried to open a link before its real URL was configured in constants/externalLinks.js.');
    }
    return;
  }

  try {
    const canOpen = await Linking.canOpenURL(url);
    if (canOpen) {
      await Linking.openURL(url);
    }
  } catch (err) {
    if (__DEV__) {
      console.warn('[Rewards] Failed to open URL', url, err);
    }
  }
}

// A clearly labeled placeholder "asset slot" for a Golden Light
// promotional/product photo that doesn't exist in the repo yet - never
// invented stock photography, never a remote placeholder-image service,
// just a dashed box marking exactly where a real image belongs and which
// file to add. Once that file exists at src/assets/images/<fileName>,
// replace this component's contents with
// `<Image source={require('../assets/images/<fileName>')} style={styles.imageSlotPhoto} resizeMode="cover" />`.
function BrandImageSlot({ label, fileName, style }) {
  return (
    <View style={[styles.imageSlot, style]}>
      <Ionicons name="image-outline" size={22} color={colors.textMuted} />
      <Text style={styles.imageSlotLabel}>{label}</Text>
      <Text style={styles.imageSlotFileName}>{isolateLTR(fileName)}</Text>
    </View>
  );
}

export default function RewardsScreen() {
  const { user } = useAuth();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [rootHeight, setRootHeight] = useState(0);
  const [heroHeight, setHeroHeight] = useState(0);

  // Same measured-minHeight approach as HomeScreen/ProfileScreen/
  // PurchaseScreen's dark hero + light sheet (see HomeScreen for the full
  // explanation) - guarantees the light sheet reaches the bottom of the
  // real screen regardless of the flex-grow chain between here and the
  // ScrollView.
  const onRootLayout = useCallback((event) => {
    setRootHeight(event.nativeEvent.layout.height);
  }, []);
  const onHeroLayout = useCallback((event) => {
    setHeroHeight(event.nativeEvent.layout.height);
  }, []);
  const sheetMinHeight =
    rootHeight > 0 && heroHeight > 0 ? rootHeight - heroHeight + radius.xl : undefined;

  // STAGE 9: useFocusEffect, not a plain mount-only useEffect - see the
  // identical reasoning on HomeScreen's own profile load. A customer
  // returning to this tab after a receipt is approved elsewhere must see
  // their real points_balance, not a stale value from first mount. The
  // backend profile/ledger remains authoritative - this only re-fetches it.
  useFocusEffect(
    useCallback(() => {
      let isActive = true;

      async function loadProfile() {
        if (!user?.id) {
          setProfile(null);
          setLoading(false);
          setError('');
          return;
        }

        try {
          setLoading(true);
          setError('');
          const data = await getProfile(user.id);

          if (isActive) {
            setProfile(data);
          }
        } catch (err) {
          if (isActive) {
            setProfile(null);
            setError('לא הצלחנו לטעון את יתרת הנקודות');
          }
        } finally {
          if (isActive) {
            setLoading(false);
          }
        }
      }

      loadProfile();

      return () => {
        isActive = false;
      };
    }, [user?.id]),
  );

  const pointsBalance = profile?.points_balance ?? 0;

  return (
    <View style={styles.root} onLayout={onRootLayout}>
      {/* Full-bleed dark hero, same technique/tokens as HomeScreen/
          ProfileScreen/PurchaseScreen's own hero (see HomeScreen for the
          full explanation) - keeps every premium dark surface visually
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
        // No bottom edge - same reasoning as the other tab screens (nested
        // under the (tabs) bottom bar, which already provides its own
        // clearance).
        edges={['top', 'left', 'right']}>
        <View style={styles.heroSection} onLayout={onHeroLayout}>
          <View style={styles.heroInner}>
            <Text style={styles.title}>מתנות</Text>
            <Text style={styles.subtitle}>
              {`ממשו את הנקודות שצברתם וגלו את העולם של ${isolateLTR('Golden Light')}`}
            </Text>

            <PointsBalanceCard
              pointsBalance={pointsBalance}
              meta="זמינות למימוש"
              loading={loading}
              error={error}
              onRetry={() =>
                user?.id &&
                getProfile(user.id)
                  .then((data) => {
                    setProfile(data);
                    setError('');
                  })
                  .catch(() => setError('לא הצלחנו לטעון את יתרת הנקודות'))
              }
              style={styles.pointsCard}
            />
          </View>
        </View>

        {/* Light content sheet - same full-bleed/rounded-top/measured-
            minHeight pattern as HomeScreen/ProfileScreen/PurchaseScreen's
            own sheet. */}
        <View style={[styles.sheet, sheetMinHeight ? { minHeight: sheetMinHeight } : null]}>
          <View style={styles.sheetInner}>
            {/* Point redemption CTA - near the top of the sheet, directly
                under the real points balance above. The destination URL
                isn't available yet - see POINTS_REDEMPTION_URL in
                constants/externalLinks.js, the one place to insert it once
                it exists. openExternalLinkSafely no-ops on a missing URL,
                so this never navigates anywhere fake in the meantime. No
                internal points formula/calculation is shown or referenced
                here - only the real balance already displayed above. */}
            <Pressable
              style={({ pressed }) => [styles.redeemCard, pressed && styles.redeemCardPressed]}
              onPress={() => openExternalLinkSafely(POINTS_REDEMPTION_URL)}
              accessibilityRole="button"
              accessibilityLabel="למימוש הנקודות שלך לחץ כאן">
              <View style={styles.redeemIconWrap}>
                <Ionicons name="wallet-outline" size={20} color={colors.primary} />
              </View>
              <Text style={styles.redeemText}>למימוש הנקודות שלך לחץ כאן</Text>
              <Ionicons name="chevron-back" size={18} color={colors.primary} />
            </Pressable>

            {/* Golden Light brand section - replaces the old per-benefit
                progress list entirely (no more "X points remaining until
                Y" cards). A premium branded landing block instead: a dark
                hero-style card (logo + headline + supporting copy + website
                CTA) followed by promotional-image slots. The CTA's
                destination isn't available yet - see
                GOLDEN_LIGHT_WEBSITE_URL in constants/externalLinks.js, the
                one place to insert it once it exists; openExternalLinkSafely
                no-ops until then. */}
            <View style={styles.brandSection}>
              <LinearGradient
                colors={[colors.gradientDarkStart, colors.gradientDarkEnd]}
                start={{ x: 0.1, y: 0 }}
                end={{ x: 0.9, y: 1 }}
                style={styles.brandCard}>
                <Image
                  source={require('../assets/images/golden-light-logo-white.png')}
                  style={styles.brandLogo}
                  resizeMode="contain"
                />
                <Text style={styles.brandHeadline}>{`גלו את העולם של ${isolateLTR('Golden Light')}`}</Text>
                <Text style={styles.brandSubtext}>
                  הכירו את המוצרים, הקולקציות והפתרונות שלנו — וקבלו השראה לפרויקט הבא שלכם.
                </Text>
                <PrimaryButton
                  title={`לעולם של ${isolateLTR('Golden Light')}`}
                  onPress={() => openExternalLinkSafely(GOLDEN_LIGHT_WEBSITE_URL)}
                  style={styles.brandButton}
                />
              </LinearGradient>

              {/* Promotional-image slots - see BrandImageSlot above for
                  exactly how/where to swap each one for a real asset. */}
              <BrandImageSlot
                label="באנר ראשי - קולקציה או פרויקט לדוגמה"
                fileName="golden-light-hero-banner.jpg"
                style={styles.imageSlotWide}
              />

              <View style={styles.imageSlotRow}>
                <BrandImageSlot
                  label="תמונת מוצר"
                  fileName="golden-light-showcase-1.jpg"
                  style={styles.imageSlotSquare}
                />
                <BrandImageSlot
                  label="תמונת מוצר"
                  fileName="golden-light-showcase-2.jpg"
                  style={styles.imageSlotSquare}
                />
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
  // Same cancel-AppScreen's-own-wrapper technique as HomeScreen/
  // ProfileScreen/PurchaseScreen (see HomeScreen's screenInner comment for
  // the full flex-chain explanation).
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
    // below (see `sheet`), so the rounded corners never cut into the
    // points card.
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
  pointsCard: {
    width: '100%',
    marginTop: spacing.xl,
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
    gap: spacing.xl,
  },
  // The redemption CTA - a single, elegant row rather than a full card, so
  // it reads as an action, not another content block competing with the
  // brand section below.
  redeemCard: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    minHeight: 64,
    ...shadows.softCard,
  },
  redeemCardPressed: {
    opacity: 0.85,
  },
  redeemIconWrap: {
    width: 38,
    height: 38,
    borderRadius: 13,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  redeemText: {
    flex: 1,
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  brandSection: {
    gap: spacing.md,
  },
  brandCard: {
    borderRadius: radius.xl,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xxl,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.charcoalBorder,
    ...shadows.glow,
  },
  // Same aspect ratio as the real logo file (see AuthScreenShell's own
  // 220x110 usage) - only scaled down for this smaller card context, never
  // stretched/cropped.
  brandLogo: {
    width: 120,
    height: 60,
    marginBottom: spacing.md,
  },
  brandHeadline: {
    fontSize: typography.heading.fontSize,
    lineHeight: typography.heading.lineHeight,
    fontWeight: typography.heading.fontWeight,
    color: colors.textOnDark,
    textAlign: 'center',
  },
  brandSubtext: {
    marginTop: spacing.sm,
    fontSize: typography.body.fontSize,
    lineHeight: typography.body.lineHeight,
    color: colors.mutedOnDark,
    textAlign: 'center',
    maxWidth: 320,
  },
  brandButton: {
    marginTop: spacing.xl,
  },
  // Dashed border + muted fill deliberately reads as "placeholder", never
  // mistakeable for a finished design - see BrandImageSlot above.
  imageSlot: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: colors.border,
    backgroundColor: colors.surfaceMuted,
    padding: spacing.md,
  },
  imageSlotWide: {
    width: '100%',
    aspectRatio: 16 / 9,
  },
  imageSlotRow: {
    flexDirection: 'row-reverse',
    gap: spacing.md,
  },
  imageSlotSquare: {
    flex: 1,
    aspectRatio: 1,
  },
  imageSlotLabel: {
    fontSize: typography.caption.fontSize,
    fontWeight: '600',
    color: colors.textMuted,
    textAlign: 'center',
  },
  imageSlotFileName: {
    fontSize: 10,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'center',
    opacity: 0.8,
  },
});