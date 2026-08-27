import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import AppBackButton from '../components/common/AppBackButton';
import AppCard from '../components/common/AppCard';
import AppInput from '../components/common/AppInput';
import AppScreen from '../components/common/AppScreen';
import PrimaryButton from '../components/common/PrimaryButton';
import { useAuth } from '../context/AuthContext';
import {
  getCachedAvatarUrl,
  getProfile,
  getProfileAvatarSignedUrl,
  updateProfile,
  uploadProfileAvatar,
} from '../services/profileService';
import { colors, radius, spacing, typography } from '../theme';
import { isolateLTR } from '../utils/bidiText';

const AVATAR_SIZE = 112;

const supportedAvatarTypes = ['image/jpeg', 'image/png', 'image/webp'];

function isSupportedAvatarAsset(asset) {
  const mimeType = asset?.mimeType || asset?.type || '';
  if (!mimeType) {
    const name = String(asset?.fileName || asset?.name || '').toLowerCase();
    return name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png') || name.endsWith('.webp');
  }

  return supportedAvatarTypes.includes(mimeType.toLowerCase());
}

export default function EditProfileScreen() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [profession, setProfession] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [saveError, setSaveError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [saving, setSaving] = useState(false);
  // status: 'loading' | 'none' | 'ready' | 'error'. Starts as 'loading' so the
  // avatar circle never falls back to the initial-letter placeholder while we
  // don't yet know whether this profile has an avatar_path.
  const [avatarState, setAvatarState] = useState({ status: 'loading', url: null });
  const [localAvatarUri, setLocalAvatarUri] = useState(null);
  const [pickedAsset, setPickedAsset] = useState(null);
  const [avatarError, setAvatarError] = useState('');
  const [rootHeight, setRootHeight] = useState(0);
  const [heroHeight, setHeroHeight] = useState(0);

  // Same measured-minHeight approach as ProfileScreen/PurchaseHistoryScreen/
  // PurchaseReportDetailsScreen's dark hero + light sheet (see HomeScreen
  // for the full explanation) - guarantees the light sheet reaches the
  // bottom of the real screen regardless of the flex-grow chain between
  // here and the ScrollView.
  const onRootLayout = useCallback((event) => {
    setRootHeight(event.nativeEvent.layout.height);
  }, []);
  const onHeroLayout = useCallback((event) => {
    setHeroHeight(event.nativeEvent.layout.height);
  }, []);
  const sheetMinHeight =
    rootHeight > 0 && heroHeight > 0 ? rootHeight - heroHeight + radius.xl : undefined;

  useEffect(() => {
    let isActive = true;

    async function loadProfile() {
      if (!user?.id) {
        setLoading(false);
        setAvatarState({ status: 'none', url: null });
        return;
      }

      try {
        setLoading(true);
        setLoadError('');
        const data = await getProfile(user.id);

        if (!isActive) {
          return;
        }

        setFullName(data?.full_name || '');
        setPhone(data?.phone || '');
        setProfession(data?.profession || '');

        const avatarPath = data?.avatar_path || null;

        if (!avatarPath) {
          setAvatarState({ status: 'none', url: null });
        } else {
          const cachedUrl = getCachedAvatarUrl(avatarPath);

          if (cachedUrl) {
            // Reuse the URL already resolved by ProfileScreen (or an earlier
            // visit to this screen) — appears immediately, no loading state.
            setAvatarState({ status: 'ready', url: cachedUrl });
          } else {
            setAvatarState({ status: 'loading', url: null });

            getProfileAvatarSignedUrl(avatarPath)
              .then((url) => {
                if (isActive) {
                  setAvatarState(url ? { status: 'ready', url } : { status: 'error', url: null });
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
          setLoadError('לא הצלחנו לטעון את פרטי החשבון');
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
  }, [user?.id]);

  const handlePickImage = async () => {
    try {
      setAvatarError('');

      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setAvatarError('לא ניתנה הרשאה לגישה לתמונות');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.8,
        allowsEditing: true,
        aspect: [1, 1],
      });

      if (result.canceled) {
        return;
      }

      const asset = result.assets?.[0];
      if (!asset) {
        return;
      }

      if (!isSupportedAvatarAsset(asset)) {
        setAvatarError(`פורמט תמונה לא נתמך. בחרו ${isolateLTR('JPG, PNG')} או ${isolateLTR('WEBP')}.`);
        return;
      }

      setPickedAsset(asset);
      setLocalAvatarUri(asset.uri);
    } catch (err) {
      if (__DEV__) {
        console.warn('[Profile] Failed to pick avatar image', err);
      }
      setAvatarError('לא הצלחנו לבחור תמונה');
    }
  };

  const handleSave = async () => {
    if (saving) {
      return;
    }

    const trimmedName = fullName.trim();
    const trimmedPhone = phone.trim();
    const trimmedProfession = profession.trim();

    const nextFieldErrors = {};
    if (!trimmedName) {
      nextFieldErrors.fullName = 'יש להזין שם מלא';
    }
    if (!trimmedPhone) {
      nextFieldErrors.phone = 'יש להזין מספר טלפון';
    }

    setFieldErrors(nextFieldErrors);
    setSaveError('');
    setSuccessMessage('');

    if (Object.keys(nextFieldErrors).length > 0) {
      return;
    }

    if (!user?.id) {
      setSaveError('לא הצלחנו לעדכן את הפרטים. נסו שוב.');
      return;
    }

    try {
      setSaving(true);

      const profileUpdates = {
        full_name: trimmedName,
        phone: trimmedPhone,
        profession: trimmedProfession || null,
      };

      if (pickedAsset) {
        const newAvatarPath = await uploadProfileAvatar(user.id, pickedAsset);
        profileUpdates.avatar_path = newAvatarPath;
      }

      await updateProfile(user.id, profileUpdates);

      if (profileUpdates.avatar_path) {
        // uploadProfileAvatar() already invalidated any stale cache entry
        // for this path, so this is guaranteed to fetch a fresh signed URL
        // rather than reuse the one for the photo we just replaced. Warm the
        // shared cache and the native image cache in the background so
        // ProfileScreen (and this screen, if reopened) shows the new photo
        // immediately instead of loading it again. Not awaited - must not
        // delay the success message/navigation; the local picked-image
        // preview keeps covering the display in the meantime.
        getProfileAvatarSignedUrl(profileUpdates.avatar_path, { forceRefresh: true })
          .then((url) => {
            if (url) {
              setAvatarState({ status: 'ready', url });
              Image.prefetch(url).catch(() => {});
            }
          })
          .catch(() => {});
      }

      setSuccessMessage('הפרטים עודכנו בהצלחה');
      setTimeout(() => {
        if (router.canGoBack()) {
          router.back();
        } else {
          router.replace('/(tabs)/profile');
        }
      }, 700);
    } catch (err) {
      if (__DEV__) {
        console.warn('[Profile] Failed to update profile', err);
      }
      setSaveError('לא הצלחנו לעדכן את הפרטים. נסו שוב.');
    } finally {
      setSaving(false);
    }
  };

  const avatarLetter = (() => {
    const source = fullName || user?.email || 'G';
    const visible = String(source).trim();
    return visible ? visible[0] : 'G';
  })();
  const avatarPreviewUri = localAvatarUri || (avatarState.status === 'ready' ? avatarState.url : null);

  return (
    <View style={styles.root} onLayout={onRootLayout}>
      {/* Full-bleed dark hero, same technique/tokens as ProfileScreen/
          PurchaseHistoryScreen/PurchaseReportDetailsScreen's own hero (see
          HomeScreen for the full explanation), kept compact - back button +
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
              <Text style={styles.title}>עריכת פרטים אישיים</Text>
              <Text style={styles.subtitle}>עדכנו את פרטי החשבון שלכם</Text>
            </View>
          </View>
        </View>

        {/* Light content sheet - same full-bleed/rounded-top/measured-
            minHeight pattern as the other screens' own sheet. */}
        <View style={[styles.sheet, sheetMinHeight ? { minHeight: sheetMinHeight } : null]}>
          <View style={styles.sheetInner}>
            {loading ? (
              <View style={styles.loadingState}>
                <ActivityIndicator color={colors.primary} size="small" />
              </View>
            ) : (
              <>
                <View style={styles.avatarSection}>
                  <View style={styles.avatarRing}>
                    <View style={styles.avatarCircle}>
                      {avatarPreviewUri ? (
                        <Image
                          source={{ uri: avatarPreviewUri }}
                          style={styles.avatarImage}
                          contentFit="cover"
                          cachePolicy="memory-disk"
                          recyclingKey={avatarPreviewUri}
                          transition={200}
                        />
                      ) : !localAvatarUri && avatarState.status === 'loading' ? (
                        <View style={styles.avatarLoadingWrap}>
                          <ActivityIndicator color={colors.primary} size="small" />
                        </View>
                      ) : (
                        <Text style={styles.avatarLetter}>{avatarLetter}</Text>
                      )}
                    </View>
                  </View>

                  <Pressable
                    onPress={handlePickImage}
                    disabled={saving}
                    accessibilityRole="button"
                    accessibilityLabel="עריכת תמונה"
                    style={styles.avatarEditAction}>
                    <Text style={styles.avatarEditText}>עריכת תמונה</Text>
                    <Ionicons name="create-outline" size={16} color={colors.primary} />
                  </Pressable>

                  {avatarError ? <Text style={styles.avatarErrorText}>{avatarError}</Text> : null}
                </View>

                <AppCard style={styles.card}>
                  {loadError ? <Text style={styles.loadErrorText}>{loadError}</Text> : null}

                  <AppInput
                    label="שם מלא"
                    placeholder="הכניסו שם מלא"
                    value={fullName}
                    onChangeText={setFullName}
                    error={fieldErrors.fullName}
                    style={styles.input}
                  />

                  <AppInput
                    label="טלפון"
                    placeholder="050-1234567"
                    keyboardType="phone-pad"
                    textAlign="left"
                    writingDirection="ltr"
                    value={phone}
                    onChangeText={setPhone}
                    error={fieldErrors.phone}
                    style={styles.input}
                  />

                  <AppInput
                    label="מקצוע"
                    placeholder="הכניסו מקצוע"
                    value={profession}
                    onChangeText={setProfession}
                    style={styles.input}
                  />

                  {user?.email ? (
                    <View style={styles.emailWrapper}>
                      <Text style={styles.emailLabel}>אימייל</Text>
                      <Text style={styles.emailValue}>{isolateLTR(user.email)}</Text>
                    </View>
                  ) : null}

                  {saveError ? <Text style={styles.saveErrorText}>{saveError}</Text> : null}
                  {successMessage ? <Text style={styles.successText}>{successMessage}</Text> : null}

                  <PrimaryButton
                    title={saving ? 'שומר...' : 'שמירת שינויים'}
                    onPress={handleSave}
                    loading={saving}
                    disabled={saving}
                    style={styles.button}
                  />
                </AppCard>
              </>
            )}
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
  loadingState: {
    minHeight: 200,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Deliberately short - back button + title/subtitle only, no bulky
  // content, matching PurchaseHistoryScreen/PurchaseReportDetailsScreen's
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
    gap: spacing.lg,
  },
  avatarSection: {
    width: '100%',
    alignItems: 'center',
  },
  // Turquoise ring + a very subtle glow (not a heavy shadow) - same
  // treatment as ProfileScreen's own avatar, so both screens' avatars read
  // as the same premium component. The ring is a separate wrapper around
  // avatarCircle (not a border directly on it) so the border never clips
  // into the circular image itself.
  avatarRing: {
    width: AVATAR_SIZE + 8,
    height: AVATAR_SIZE + 8,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
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
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarImage: {
    width: '100%',
    height: '100%',
  },
  avatarLoadingWrap: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: {
    fontSize: 40,
    fontWeight: '700',
    color: colors.primary,
    textAlign: 'center',
  },
  avatarEditAction: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  avatarEditText: {
    fontSize: typography.caption.fontSize,
    fontWeight: '600',
    color: colors.primary,
    textAlign: 'center',
  },
  avatarErrorText: {
    marginTop: spacing.xs,
    fontSize: typography.caption.fontSize,
    fontWeight: '600',
    color: colors.error,
    textAlign: 'center',
  },
  // AppCard's own default is radius.lg - bumped to radius.xl here so the
  // form card reads as an intentionally-designed premium surface, not a
  // generic form container.
  card: {
    width: '100%',
    borderRadius: radius.xl,
  },
  input: {
    marginBottom: spacing.md,
  },
  // Soft muted box (not just a divided row) - subtly distinguishes this
  // read-only field from the editable AppInput fields above it, without
  // reading as a broken/disabled input.
  emailWrapper: {
    alignItems: 'flex-end',
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    marginBottom: spacing.md,
  },
  emailLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    textAlign: 'right',
  },
  emailValue: {
    fontSize: typography.caption.fontSize,
    fontWeight: '600',
    color: colors.textMuted,
    textAlign: 'left',
    writingDirection: 'ltr',
    marginTop: 4,
  },
  loadErrorText: {
    fontSize: typography.caption.fontSize,
    fontWeight: '600',
    color: colors.error,
    textAlign: 'right',
    marginBottom: spacing.sm,
  },
  saveErrorText: {
    fontSize: typography.caption.fontSize,
    fontWeight: '600',
    color: colors.error,
    textAlign: 'right',
    marginBottom: spacing.sm,
  },
  successText: {
    fontSize: typography.caption.fontSize,
    fontWeight: '600',
    color: colors.success,
    textAlign: 'right',
    marginBottom: spacing.sm,
  },
  button: {
    marginTop: spacing.xs,
  },
});
