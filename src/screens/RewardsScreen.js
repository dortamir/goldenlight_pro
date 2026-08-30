import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
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

export default function RewardsScreen() {
  const { user } = useAuth();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [rootHeight, setRootHeight] = useState(0);
  const [heroHeight, setHeroHeight] = useState(0);
  // STAGE 15.3: see HomeScreen.js's own hasLoadedProfileRef for the full
  // explanation - distinguishes the true first load (full-screen spinner)
  // from a background refresh-on-focus (last-good points stay visible).
  const hasLoadedProfileRef = useRef(false);

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
          hasLoadedProfileRef.current = false;
          setProfile(null);
          setLoading(false);
          setError('');
          return;
        }

        // STAGE 15.3: only the true first load blocks with the spinner - a
        // background refresh-on-focus keeps the last-good points balance
        // visible the whole time instead of flashing to a spinner on every
        // tab revisit.
        const isInitialLoad = !hasLoadedProfileRef.current;

        try {
          if (isInitialLoad) {
            setLoading(true);
          }
          setError('');
          const data = await getProfile(user.id);

          if (isActive) {
            setProfile(data);
            hasLoadedProfileRef.current = true;
          }
        } catch (err) {
          if (isActive && isInitialLoad) {
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
            <Text style={styles.subtitle}>{`עקבו אחרי הנקודות שצברתם כחברי ${isolateLTR('GOLDEN+')}`}</Text>

            <PointsBalanceCard
              pointsBalance={pointsBalance}
              meta="יתרת הנקודות שלך"
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
            {/* STAGE 18.1: point redemption CTA - hidden entirely for V1
                (POINTS_REDEMPTION_URL is not yet set - see
                constants/externalLinks.js). Conditionally rendered rather
                than deleted, so setting a real URL there is the ONLY change
                needed to bring this row back - no screen-architecture
                rebuild required. openExternalLinkSafely also no-ops on a
                missing URL as defense in depth, but the row is kept out of
                the tree entirely while null so nothing tappable-looking with
                no real action is ever shown to a real customer. */}
            {POINTS_REDEMPTION_URL ? (
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
            ) : null}

            {/* STAGE 18.1: V1 "coming soon" state, replacing the previous
                "explore Golden Light's world" marketing card and its
                dashed-placeholder promotional-image slots (dev-only asset
                markers that must never reach a real customer). Reuses the
                exact same dark gradient brand card/logo treatment as
                before - same GOLDEN+ visual language, only the copy and the
                (now-conditional) CTA changed. The website button only
                renders once GOLDEN_LIGHT_WEBSITE_URL is set - see
                constants/externalLinks.js - so this card upgrades itself
                automatically the moment a real URL is added, no rebuild. */}
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
                <Text style={styles.brandHeadline}>המתנות בדרך</Text>
                <Text style={styles.brandSubtext}>
                  {`בקרוב תוכלו לממש את הנקודות שצברתם למגוון מתנות והטבות לחברי ${isolateLTR('GOLDEN+')}.`}
                </Text>
                {GOLDEN_LIGHT_WEBSITE_URL ? (
                  <PrimaryButton
                    title={`לעולם של ${isolateLTR('Golden Light')}`}
                    onPress={() => openExternalLinkSafely(GOLDEN_LIGHT_WEBSITE_URL)}
                    style={styles.brandButton}
                  />
                ) : null}
              </LinearGradient>
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
});