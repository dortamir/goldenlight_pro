import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { Image, Modal, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, spacing } from '../../theme';
import ZoomableImage from './ZoomableImage';

// STAGE 28.9: extracted from PurchaseReportDetailsScreen.js's own fullscreen
// receipt-image viewer so AdminReportDetailScreen.js could render the exact
// same, proven structure instead of its own separately-built one (which had
// a suspected outer-GestureHandlerRootView freeze on a physical iPhone -
// fixed, and MUST NOT return: there is still only one GestureHandlerRootView
// anywhere, ZoomableImage's own internal one, unchanged this stage).
//
// STAGE 28.10/28.11 both tried to give ZoomableImage a small, image-fitted
// box and let backdrop taps "fall through" a `pointerEvents="box-none"`
// wrapper around it - sized either via a Yoga `aspectRatio` style or via
// pixel math applied to that same box. Both were physically tested and
// still failed (no visible backdrop, X not usable, tap-outside not
// closing). Rather than patch that architecture again, STAGE 28.13 replaces
// it entirely with the simpler, deterministic structure below.
//
// Layer model (each a direct, absolutely-positioned child of `root`):
//   1. `root` ITSELF paints the dark fullscreen background (a semi
//      -transparent dark rgba, see its own style comment) - not a sibling
//      Pressable. Every other layer sits on top of this; anywhere nothing
//      else is drawn, root's own color is what's visible.
//   2. Four separate, plain, transparent backdrop Pressables - one each for
//      the screen area above/below/left-of/right-of the image rectangle.
//      Each is a simple absolutely-positioned rectangle computed from the
//      SAME numbers used to place the image (see `fitted`/`imageLeft`/
//      `imageTop` below) - there is no fullscreen gesture surface for a tap
//      to "fall through"; a tap in any of these four bands is a real,
//      independent Pressable hit, and a tap on the image lands on
//      ZoomableImage instead because the four bands are geometrically
//      defined to never overlap the image rectangle. No touch bubbling or
//      pointerEvents trickery is involved.
//   3. The image region - a plain View sized to the receipt's own fitted
//      width/height IN PIXELS (not flex:1, not aspectRatio, not a
//      percentage) - see `fitted` below - containing ZoomableImage. This is
//      the one and only GestureHandlerRootView in the tree, and its bounds
//      are exactly the visible receipt rectangle, nothing more.
//   4. The close X - a fixed top-right Pressable, rendered LAST (topmost
//      paint order) with a high zIndex/elevation, entirely outside
//      ZoomableImage's own subtree so it is never part of its zoom/pan
//      transform. Rendered unconditionally - it does not depend on the
//      image having loaded, its dimensions having resolved, or anything
//      else - so there is always a way out even if the receipt itself never
//      loads.
//
// Natural size bootstrap: rather than only learning the image's real pixel
// size from ZoomableImage's own onLoad (which would mean the FIRST frame
// has no correct rectangle to compute the backdrop bands from), this
// resolves the size UP FRONT via React Native's own `Image.getSize` -
// works directly against the already-resolved https signed URL (no local
// asset involved here), the standard, dependency-free API for exactly this
// case. Until it resolves (typically near-instant - imageUrl is only ever
// passed once already fetched), a neutral default aspect ratio is used so
// there is still a valid, small, non-fullscreen rectangle - and therefore
// working backdrop bands and a usable X - from the very first frame.
const HORIZONTAL_MARGIN = spacing.lg;
const VERTICAL_MARGIN = spacing.xxl;
const DEFAULT_ASPECT_WIDTH = 3;
const DEFAULT_ASPECT_HEIGHT = 4;

function fitContain(naturalWidth, naturalHeight, maxWidth, maxHeight) {
  const scale = Math.min(maxWidth / naturalWidth, maxHeight / naturalHeight);
  return { width: naturalWidth * scale, height: naturalHeight * scale };
}

export default function ReceiptImageViewerModal({ visible, onClose, imageUrl, recyclingKey, cacheKey }) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [naturalSize, setNaturalSize] = useState(null);

  // A fresh open should size itself from THIS image's own real dimensions,
  // not whatever a previously-viewed receipt reported.
  useEffect(() => {
    if (!visible || !imageUrl) {
      setNaturalSize(null);
      return undefined;
    }

    let cancelled = false;
    Image.getSize(
      imageUrl,
      (width, height) => {
        if (!cancelled && width && height) {
          setNaturalSize({ width, height });
        }
      },
      () => {
        // Left as null - the default aspect ratio box below still gives a
        // valid, centered, non-fullscreen rectangle, and ZoomableImage's own
        // contentFit="contain" still displays the image correctly inside
        // it; only the fit is less tight than usual.
      },
    );

    return () => {
      cancelled = true;
    };
  }, [visible, imageUrl]);

  const availableWidth = windowWidth - HORIZONTAL_MARGIN * 2;
  const availableHeight = windowHeight - insets.top - insets.bottom - VERTICAL_MARGIN * 2;

  const fitted = fitContain(
    naturalSize?.width || DEFAULT_ASPECT_WIDTH,
    naturalSize?.height || DEFAULT_ASPECT_HEIGHT,
    availableWidth,
    availableHeight,
  );
  const imageLeft = (windowWidth - fitted.width) / 2;
  const imageTop = (windowHeight - fitted.height) / 2;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.root}>
        {/* Four backdrop bands around the image rectangle - see the file
            -level comment above for why this replaces the earlier
            fullscreen-gesture-surface-plus-box-none approach. */}
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="סגירת תמונת חשבונית"
          style={{ position: 'absolute', top: 0, left: 0, right: 0, height: imageTop }}
        />
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="סגירת תמונת חשבונית"
          style={{
            position: 'absolute',
            top: imageTop + fitted.height,
            left: 0,
            right: 0,
            bottom: 0,
          }}
        />
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="סגירת תמונת חשבונית"
          style={{ position: 'absolute', top: imageTop, left: 0, width: imageLeft, height: fitted.height }}
        />
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="סגירת תמונת חשבונית"
          style={{
            position: 'absolute',
            top: imageTop,
            left: imageLeft + fitted.width,
            right: 0,
            height: fitted.height,
          }}
        />

        {visible && imageUrl ? (
          <View
            style={{
              position: 'absolute',
              top: imageTop,
              left: imageLeft,
              width: fitted.width,
              height: fitted.height,
            }}>
            <ZoomableImage uri={imageUrl} recyclingKey={recyclingKey} cacheKey={cacheKey} />
          </View>
        ) : null}

        {/* Fixed top-right, rendered last (topmost), never part of
            ZoomableImage's own transformed subtree, and rendered
            unconditionally - always present, even before the image loads
            or if it never does, so there is always a way to exit. */}
        <SafeAreaView edges={['top', 'right']} style={styles.closeSafeArea} pointerEvents="box-none">
          <Pressable
            onPress={onClose}
            style={styles.closeButton}
            accessibilityRole="button"
            accessibilityLabel="סגירת תמונת חשבונית"
            hitSlop={12}>
            <Ionicons name="close" size={24} color={colors.white} />
          </Pressable>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // The root itself paints the dark fullscreen background - not a sibling
  // Pressable - so anywhere nothing else is drawn (including under the
  // four transparent backdrop bands above), this color is what's visible.
  // STAGE 28.13.1: a semi-transparent dark rgba (not the fully opaque
  // colors.bgDark) - the underlying screen is subtly visible behind the
  // Modal, a deliberately "dimmed" premium look rather than a fully solid
  // backdrop. Purely visual - none of the four backdrop Pressables, the
  // image sizing, or onRequestClose behavior changed.
  root: {
    flex: 1,
    backgroundColor: 'rgba(10, 14, 14, 0.88)',
  },
  closeSafeArea: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 20,
    elevation: 20,
  },
  // STAGE 28.13.1: top nudged down (12 -> 24, +12px). STAGE 28.13.2: nudged
  // down again (24 -> 44, +20px) - still top-right, still safe-area aware
  // via the enclosing SafeAreaView, same size/touch target/zIndex/close
  // behavior.
  closeButton: {
    position: 'absolute',
    top: 44,
    right: 16,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});