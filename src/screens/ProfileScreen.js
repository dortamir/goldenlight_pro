import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import AppScreen from '../components/common/AppScreen';
import { useAuth } from '../context/AuthContext';
import { getCachedAvatarUrl, getProfile, getProfileAvatarSignedUrl } from '../services/profileService';
import { colors, radius, shadows, spacing, typography } from '../theme';

const AVATAR_SIZE = 88;

// Same real, currently-reachable tiers as PointsBalanceCard's own
// TIER_COLORS map (see src/components/common/PointsBalanceCard.js) -
// duplicated here rather than imported since that map isn't exported, and
// this is just a plain color lookup, not shared logic.
const TIER_COLORS = {
  BRONZE: colors.tierBronze,
  SILVER: colors.tierSilver,
  GOLD: colors.tierGold,
  PLATINUM: colors.tierPlatinum,
};

const accountActions = [
  { label: 'עריכת פרטים אישיים', icon: 'create-outline', route: '/(tabs)/profile/edit' },
  { label: 'שינוי סיסמה', icon: 'lock-closed-outline', route: '/(tabs)/profile/change-password' },
  { label: 'עזרה ותמיכה', icon: 'help-circle-outline', route: '/(tabs)/profile/help-support' },
];

export default function ProfileScreen() {
  const router = useRouter();
  const { signOut, user } = useAuth();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // status: 'loading' | 'none' | 'ready' | 'error'. Starts as 'loading' so the
  // avatar circle never falls back to the initial-letter placeholder while we
  // don't yet know whether this profile has an avatar_path — that fallback
  // is reserved for the 'none'/'error' states once we actually know.
  const [avatarState, setAvatarState] = useState({ status: 'loading', url: null });
  // Mirrors the URL currently shown on screen (only while status === 'ready').
  // Avatar uploads reuse the same storage path (upsert), so avatar_path
  // staying the same string does NOT mean the underlying image is
  // unchanged — only comparing against the URL we're actually displaying
  // does. Using a ref (not state) avoids a stale closure inside the
  // useFocusEffect callback below, which is only recreated when user?.id
  // changes.
  const currentAvatarUrlRef = useRef(null);
  const [rootHeight, setRootHeight] = useState(0);
  const [heroHeight, setHeroHeight] = useState(0);
  // View-only full-size preview - never opened for the loading/none/error
  // avatar states (see canPreviewAvatar below), only for a real resolved URL.
  const [avatarPreviewVisible, setAvatarPreviewVisible] = useState(false);
  const { width: windowWidth } = useWindowDimensions();
  // Responsive circle diameter: ~240-280px on normal phones, but shrinks on
  // very narrow screens (clamped to a 200px floor) instead of a fixed value
  // that could overflow at 360px width.
  const avatarPreviewSize = Math.round(Math.max(200, Math.min(280, windowWidth - 96)));

  // Same measured-minHeight approach as HomeScreen's dark hero + light sheet
  // (see that file for the full explanation) - guarantees the light sheet
  // reaches the bottom of the real screen regardless of the flex-grow chain
  // between here and the ScrollView, rather than trusting it to always
  // resolve identically on every device.
  const onRootLayout = useCallback((event) => {
    setRootHeight(event.nativeEvent.layout.height);
  }, []);
  const onHeroLayout = useCallback((event) => {
    setHeroHeight(event.nativeEvent.layout.height);
  }, []);
  const sheetMinHeight =
    rootHeight > 0 && heroHeight > 0 ? rootHeight - heroHeight + radius.xl : undefined;

  const handleLogout = async () => {
    try {
      await signOut();
      router.replace('/(auth)/login');
    } catch (error) {
      console.warn('[Auth] Logout failed', error);
    }
  };

  useFocusEffect(
    useCallback(() => {
      let isActive = true;

      async function loadProfile() {
        if (!user?.id) {
          setProfile(null);
          setLoading(false);
          setError('');
          currentAvatarUrlRef.current = null;
          setAvatarState({ status: 'none', url: null });
          return;
        }

        try {
          setLoading(true);
          setError('');
          const data = await getProfile(user.id);
          if (isActive) {
            setProfile(data);
          }

          const avatarPath = data?.avatar_path || null;

          if (!avatarPath) {
            currentAvatarUrlRef.current = null;
            if (isActive) {
              setAvatarState({ status: 'none', url: null });
            }
          } else {
            // Always re-check the shared cache, even when avatar_path itself
            // is unchanged from before: avatar uploads use upsert against a
            // stable "<userId>/avatar.<ext>" path, so replacing the photo
            // does not change this string. uploadProfileAvatar() invalidates
            // the cache entry for that path on a successful upload, so a
            // fresh call here will correctly pick up the new signed URL
            // instead of never even looking (which was the bug: skipping
            // this check whenever the path string matched the previous one).
            const cachedUrl = getCachedAvatarUrl(avatarPath);

            if (cachedUrl) {
              if (cachedUrl !== currentAvatarUrlRef.current) {
                // Either the very first resolution, or the cache now holds a
                // newer URL than what's on screen (post-replacement) - swap
                // straight to it, no loading state needed since we already
                // have the value synchronously.
                currentAvatarUrlRef.current = cachedUrl;
                if (isActive) {
                  setAvatarState({ status: 'ready', url: cachedUrl });
                }
              }
              // else: identical to what's already displayed - no-op, avoids
              // any unnecessary re-render/flicker.
            } else {
              // Genuine cache miss: a brand-new avatar we've never resolved,
              // or an entry invalidated after a same-path replacement that
              // hasn't been re-populated yet. Only show the loading
              // placeholder if nothing valid is currently on screen -
              // otherwise keep the current avatar visible until the fresh
              // URL resolves, then swap directly.
              if (!currentAvatarUrlRef.current && isActive) {
                setAvatarState({ status: 'loading', url: null });
              }

              getProfileAvatarSignedUrl(avatarPath)
                .then((url) => {
                  if (isActive) {
                    if (url) {
                      currentAvatarUrlRef.current = url;
                      setAvatarState({ status: 'ready', url });
                    } else {
                      setAvatarState({ status: 'error', url: null });
                    }
                  }
                })
                .catch(() => {
                  if (isActive) {
                    setAvatarState({ status: 'error', url: null });
                  }
                });
            }
          }
        } catch (err) {
          if (isActive) {
            setError('לא הצלחנו לטעון את פרטי החשבון');
            setProfile(null);
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

  const avatarLetter = (() => {
    const source = profile?.full_name || user?.user_metadata?.full_name || user?.email || 'G';
    const visible = String(source).trim();
    return visible ? visible[0] : 'G';
  })();

  // Only a real resolved signed URL is previewable - the loading/none/error
  // states never open the preview modal (see spec section 5).
  const canPreviewAvatar = avatarState.status === 'ready' && Boolean(avatarState.url);

  const formatNumber = (value) => {
    const numericValue = Number.isFinite(value) ? value : 0;
    return numericValue.toLocaleString('he-IL');
  };

  // Same safe-default/validation pattern as HomeScreen's own
  // safeMembershipLevel - a real profile.membership_level, defaulted to
  // BRONZE only when missing/unrecognized, never invented beyond that.
  const membershipLevel = String(profile?.membership_level || 'BRONZE').toUpperCase();
  const tierKey = ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM'].includes(membershipLevel)
    ? membershipLevel
    : 'BRONZE';
  const tierColor = TIER_COLORS[tierKey];

  // Real phone/email only, joined into one compact identity line; omitted
  // entirely (not shown as "—") when neither is set, rather than reserving
  // hero space for two empty placeholder rows.
  const contactLine = [profile?.phone, user?.email].filter(Boolean).join('   ·   ');

  return (
    <View style={styles.root} onLayout={onRootLayout}>
      {/* Full-bleed dark hero, same technique/tokens as HomeScreen's own
          hero (see that file) - keeps the two premium dark surfaces
          visually identical across screens. */}
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
        // No bottom edge - same reasoning as HomeScreen (nested under the
        // (tabs) bottom bar, which already provides its own clearance).
        edges={['top', 'left', 'right']}>
        <View style={styles.heroSection} onLayout={onHeroLayout}>
          <View style={styles.heroInner}>
            <Text style={styles.eyebrow}>אזור אישי</Text>

            <Pressable
              style={styles.avatarRing}
              disabled={!canPreviewAvatar}
              onPress={() => setAvatarPreviewVisible(true)}
              accessibilityRole={canPreviewAvatar ? 'imagebutton' : undefined}
              accessibilityLabel={canPreviewAvatar ? 'הצגת תמונת הפרופיל בגודל מלא' : undefined}>
              <View style={styles.avatarCircle}>
                {avatarState.status === 'ready' && avatarState.url ? (
                  <Image
                    source={{ uri: avatarState.url }}
                    style={styles.avatarImage}
                    resizeMode="cover"
                    fadeDuration={200}
                  />
                ) : avatarState.status === 'loading' ? (
                  <View style={styles.avatarLoadingWrap}>
                    <ActivityIndicator color={colors.primary} size="small" />
                  </View>
                ) : (
                  <Text style={styles.avatarText}>{avatarLetter}</Text>
                )}
              </View>
            </Pressable>

            {loading ? (
              <View style={styles.identityLoadingWrap}>
                <ActivityIndicator color={colors.primary} size="small" />
              </View>
            ) : error ? (
              <Text style={styles.identityErrorText}>{error}</Text>
            ) : (
              <>
                <Text style={styles.profileName} numberOfLines={2}>
                  {profile?.full_name || 'לא הוגדר שם'}
                </Text>
                <Text style={styles.profileRole} numberOfLines={1}>
                  {profile?.profession || 'לא הוגדר מקצוע'}
                </Text>
                {contactLine ? (
                  <Text style={styles.contactMeta} numberOfLines={1}>
                    {contactLine}
                  </Text>
                ) : null}
                <View style={[styles.tierPill, { borderColor: tierColor }]}>
                  <Text style={[styles.tierPillText, { color: tierColor }]}>{tierKey}</Text>
                </View>
              </>
            )}
          </View>
        </View>

        {/* Light content sheet - same full-bleed/rounded-top/measured-
            minHeight pattern as HomeScreen's own sheet. */}
        <View style={[styles.sheet, sheetMinHeight ? { minHeight: sheetMinHeight } : null]}>
          <View style={styles.sheetInner}>
            <View style={styles.summaryCard}>
              {loading ? (
                <View style={styles.summaryLoading}>
                  <ActivityIndicator color={colors.primary} size="small" />
                </View>
              ) : error ? (
                <View style={styles.summaryErrorWrap}>
                  <Text style={styles.errorText}>{error}</Text>
                  <Pressable onPress={() => user?.id && getProfile(user.id).then(setProfile).catch(() => setError('לא הצלחנו לטעון את פרטי החשבון'))}>
                    <Text style={styles.retryText}>נסו שוב</Text>
                  </Pressable>
                </View>
              ) : (
                <View style={styles.summaryGrid}>
                  <View style={styles.summaryItem}>
                    <Text style={styles.summaryValue} numberOfLines={1}>
                      {formatNumber(profile?.points_balance ?? 0)}
                    </Text>
                    <Text style={styles.summaryLabel}>נקודות</Text>
                  </View>
                  <View style={styles.summaryDivider} />
                  <View style={styles.summaryItem}>
                    <Text style={[styles.summaryValue, { color: tierColor }]} numberOfLines={1}>
                      {tierKey}
                    </Text>
                    <Text style={styles.summaryLabel}>דרגה</Text>
                  </View>
                  <View style={styles.summaryDivider} />
                  <View style={styles.summaryItem}>
                    <Text style={styles.summaryValue} numberOfLines={1}>
                      {formatNumber(profile?.approved_purchases_count ?? 0)}
                    </Text>
                    <Text style={styles.summaryLabel}>רכישות מאושרות</Text>
                  </View>
                </View>
              )}
            </View>

            <View style={styles.section}>
              <View style={styles.sectionHeaderRow}>
                <View style={styles.sectionHeadingGroup}>
                  <Text style={styles.sectionTitle}>הגדרות וחשבון</Text>
                  <View style={styles.sectionAccentDot} />
                </View>
              </View>
              <View style={styles.actionsCard}>
                {accountActions.map((action, index) => (
                  <Pressable
                    key={action.label}
                    style={({ pressed }) => [
                      styles.actionRow,
                      index === 0 && styles.actionRowFirst,
                      pressed && styles.actionRowPressed,
                    ]}
                    onPress={() => router.push(action.route)}
                    accessibilityRole="button"
                    accessibilityLabel={action.label}>
                    <View style={styles.actionIconWrap}>
                      <Ionicons name={action.icon} size={18} color={colors.primary} />
                    </View>
                    <Text style={styles.actionText}>{action.label}</Text>
                    <Ionicons name="chevron-back" size={16} color={colors.textMuted} />
                  </Pressable>
                ))}
              </View>
            </View>

            <Pressable
              style={({ pressed }) => [styles.logoutButton, pressed && styles.logoutButtonPressed]}
              onPress={handleLogout}
              accessibilityRole="button"
              accessibilityLabel="התנתקות">
              <Ionicons name="log-out-outline" size={18} color={colors.textMuted} />
              <Text style={styles.logoutText}>התנתקות</Text>
            </Pressable>
          </View>
        </View>
      </AppScreen>

      {/* View-only avatar preview - no edit/upload/download controls, no
          navigation, just a larger look at the same real avatar image.
          backdrop and the ring/circle/close-button are SIBLINGS under
          previewRoot, not parent/child - the backdrop's dim color must
          never be able to cascade an opacity onto the image the way a
          shared parent `opacity` would. */}
      <Modal
        visible={avatarPreviewVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setAvatarPreviewVisible(false)}>
        <View style={styles.previewRoot}>
          <Pressable
            style={styles.previewBackdrop}
            onPress={() => setAvatarPreviewVisible(false)}
            accessibilityRole="button"
            accessibilityLabel="סגירה"
          />

          {/* Renders after (on top of) the backdrop in the same stacking
              context, so it fully occludes the backdrop wherever it draws -
              a tap here is claimed by this Pressable, never bubbling to the
              backdrop's onPress underneath. */}
          <Pressable
            style={[
              styles.previewRing,
              { width: avatarPreviewSize + 8, height: avatarPreviewSize + 8 },
            ]}
            onPress={() => {}}>
            <View style={[styles.previewCircle, { width: avatarPreviewSize, height: avatarPreviewSize }]}>
              {avatarState.url ? (
                <Image source={{ uri: avatarState.url }} style={styles.previewImage} resizeMode="cover" />
              ) : null}
            </View>
          </Pressable>

          <Pressable
            style={styles.previewCloseButton}
            onPress={() => setAvatarPreviewVisible(false)}
            accessibilityRole="button"
            accessibilityLabel="סגירה"
            hitSlop={10}>
            <Ionicons name="close" size={22} color={colors.textOnDark} />
          </Pressable>
        </View>
      </Modal>
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
  // Same cancel-AppScreen's-own-wrapper technique as HomeScreen (see that
  // file's screenInner comment for the full flex-chain explanation).
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
    // below (see `sheet`), so the rounded corners never cut into the tier
    // pill.
    paddingBottom: spacing.xxl + radius.xl,
  },
  heroInner: {
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
  },
  eyebrow: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.mutedOnDark,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  avatarRing: {
    width: AVATAR_SIZE + 8,
    height: AVATAR_SIZE + 8,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    // Very subtle turquoise glow, not a heavy shadow - low opacity, soft
    // blur, no offset.
    shadowColor: colors.primary,
    shadowOpacity: 0.18,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 0 },
    elevation: 4,
  },
  avatarCircle: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: 999,
    // Bright/neutral, not the dark hero-adjacent tone - this sits directly
    // behind the real avatar photo, so a dark background here was tinting
    // the image at its clipped circular edges instead of showing pure
    // photo. Also used by the loading spinner and letter-fallback states,
    // where a bright turquoise-tinted background reads as intentional
    // (not "broken/dark"), matching actionIconWrap's same token elsewhere
    // on this screen.
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  // Absolute-fill (not percentage width/height) - guarantees the photo
  // covers the entire circle with no gap at the rounded edges regardless of
  // any flex-layout rounding, so none of avatarCircle's own background can
  // ever show through/tint the image.
  avatarImage: {
    ...StyleSheet.absoluteFillObject,
  },
  avatarLoadingWrap: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: 34,
    fontWeight: '700',
    color: colors.primary,
    textAlign: 'center',
  },
  identityLoadingWrap: {
    minHeight: 40,
    justifyContent: 'center',
    marginTop: spacing.md,
  },
  identityErrorText: {
    fontSize: typography.caption.fontSize,
    fontWeight: '600',
    // errorOnDark, not error - error's ~3.7:1 contrast on this dark hero
    // falls below WCAG AA (see colors.js), errorOnDark is calibrated for
    // exactly this surface.
    color: colors.errorOnDark,
    textAlign: 'center',
    marginTop: spacing.md,
  },
  profileName: {
    ...typography.title,
    color: colors.textOnDark,
    textAlign: 'center',
    marginTop: spacing.md,
  },
  profileRole: {
    ...typography.caption,
    fontWeight: '500',
    color: colors.mutedOnDark,
    textAlign: 'center',
    marginTop: 2,
  },
  contactMeta: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.mutedOnDark,
    textAlign: 'center',
    marginTop: spacing.sm,
    writingDirection: 'ltr',
  },
  tierPill: {
    marginTop: spacing.md,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
  },
  tierPillText: {
    ...typography.micro,
  },
  errorText: {
    fontSize: typography.caption.fontSize,
    fontWeight: '600',
    color: colors.error,
    textAlign: 'right',
    writingDirection: 'rtl',
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
  summaryCard: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.softCard,
  },
  summaryLoading: {
    minHeight: 64,
    justifyContent: 'center',
    alignItems: 'center',
  },
  summaryErrorWrap: {
    minHeight: 64,
    justifyContent: 'center',
    alignItems: 'flex-end',
    gap: spacing.sm,
  },
  retryText: {
    fontSize: typography.caption.fontSize,
    fontWeight: '600',
    color: colors.primary,
    textAlign: 'right',
  },
  summaryGrid: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
  },
  summaryItem: {
    flex: 1,
    alignItems: 'center',
  },
  summaryDivider: {
    width: 1,
    alignSelf: 'stretch',
    marginVertical: 2,
    backgroundColor: colors.border,
  },
  summaryLabel: {
    fontSize: 11,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: 4,
  },
  summaryValue: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
  },
  actionsCard: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    ...shadows.softCard,
  },
  actionRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.surfaceMuted,
    paddingVertical: spacing.md,
    minHeight: 56,
  },
  actionRowFirst: {
    borderTopWidth: 0,
  },
  actionRowPressed: {
    opacity: 0.7,
  },
  actionIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 12,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionText: {
    flex: 1,
    fontSize: typography.caption.fontSize,
    fontWeight: '600',
    color: colors.text,
    textAlign: 'right',
  },
  logoutButton: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    backgroundColor: colors.white,
  },
  logoutButtonPressed: {
    opacity: 0.85,
  },
  logoutText: {
    fontSize: typography.button.fontSize,
    fontWeight: typography.button.fontWeight,
    color: colors.textMuted,
    textAlign: 'center',
  },
  previewRoot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Absolutely positioned, not flex:1-wrapping-its-siblings - this View's
  // own dim color must only ever paint its own pixels, never something a
  // sibling could inherit (only a shared PARENT's `opacity` can do that,
  // which is exactly why the ring/circle/close-button below are its
  // siblings, not its children).
  previewBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(6, 10, 10, 0.9)',
  },
  previewRing: {
    borderRadius: 999,
    borderWidth: 2,
    borderColor: colors.primary,
    padding: 4,
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 1,
    shadowColor: colors.primary,
    shadowOpacity: 0.3,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 0 },
    elevation: 10,
  },
  // Bright/neutral background (matching avatarCircle's own fix above), not
  // a dark tone - this sits directly behind the real photo, and a dark
  // background here would tint it at the clipped circular edges the same
  // way avatarCircle's did before that fix.
  previewCircle: {
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: colors.primarySoft,
    opacity: 1,
  },
  previewImage: {
    ...StyleSheet.absoluteFillObject,
    opacity: 1,
  },
  previewCloseButton: {
    position: 'absolute',
    top: spacing.xxl,
    right: spacing.lg,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
