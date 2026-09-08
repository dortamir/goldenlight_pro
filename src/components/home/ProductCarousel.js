import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Image, StyleSheet, Text, View } from 'react-native';

import { colors, radius, shadows, spacing } from '../../theme';
import { isolateLTR } from '../../utils/bidiText';

// STAGE 28.14: replaces the old "gifts/points" promotional banner below the
// Home purchase-history hero with a rotating Golden Light product-category
// showcase - ONE carousel whose content slides horizontally between slides.
// Built entirely from primitives already used elsewhere in this app
// (FlatList, LinearGradient, expo-router's own useFocusEffect) - no new
// dependency, no carousel library.
//
// STAGE 28.14.1: the gifts/points promo is folded in as a FIFTH slide inside
// this same carousel (see SLIDES below) rather than a separate card
// anywhere else on Home.
//
// STAGE 28.14.4: EVERY visual layer (gradient, decorative aqua shapes,
// border, shadow, image, text) now lives INSIDE each individual FlatList
// item (see ProductSlide/GiftsSlide below), not on a shared container
// behind the FlatList. Earlier versions (28.14.1-28.14.3) painted the
// gradient/decorative shapes on the outer wrapper ONCE, behind the
// scrolling FlatList - which meant that background never actually moved: a
// swipe visibly carried the text/image content across a background that
// stayed put, since the background wasn't part of any FlatList item at all,
// just a static layer sitting underneath the whole scroll view. Now each
// slide is a fully self-contained card (its own shadow wrapper, its own
// clipped/bordered card, its own gradient + decorative shapes, its own
// content) sized to exactly one FlatList page, so scrolling from slide A to
// slide B visibly carries slide A's entire card off-screen while slide B's
// entire card - background included - scrolls in. The outer `wrap` View
// left behind is now purely structural (measures the available width via
// onLayout, hosts the FlatList, hosts the pagination overlay) - it paints
// nothing itself.
//
// RTL note: this app deliberately never calls I18nManager.forceRTL() (see
// src/utils/bidiText.js's own comment for why) - native layout direction
// stays plain LTR, and every RTL *look* elsewhere in this codebase comes
// from `flexDirection:'row-reverse'` + `textAlign:'right'` on top of that,
// never from OS-level RTL flipping. That matters here specifically: because
// I18nManager.isRTL is false, this horizontal FlatList's own scroll geometry
// is completely standard - scrolling in the positive x direction always
// advances to the NEXT item in `SLIDES` (index 0 -> 1 -> ... -> 4), exactly
// like any LTR carousel, and the pagination dots below are laid out in that
// same plain left-to-right order so a dot's position always matches the
// scroll offset that activates it. Only the CONTENT inside each slide (the
// title/description Text, and which side the image/text sit on, and - as of
// this stage - which corner each decorative aqua shape leans toward) uses
// the row-reverse/right-align RTL treatment - the carousel's own swipe/
// scroll/pagination mechanics are never touched by it.
const SLIDES = [
  {
    key: 'glight',
    type: 'product',
    image: require('../../assets/images/product-glight.png'),
    title: `גופי תאורה ${isolateLTR('GLIGHT')}`,
    description: 'פתרונות תאורה LED איכותיים לכל פרויקט — עמידות, חיסכון באנרגיה ועיצוב נקי.',
  },
  {
    key: 'gswitch',
    type: 'product',
    image: require('../../assets/images/product-gswitch.jpg'),
    title: `שקעים ומפסקים ${isolateLTR('GSWITCH')}`,
    description: 'סדרות מיתוג ושקעים בעיצוב מודרני — בטיחות, סטנדרט ואסתטיקה בכל מגע.',
  },
  {
    key: 'gbox',
    type: 'product',
    image: require('../../assets/images/product-gbox.jpg'),
    title: `לוחות חשמל ${isolateLTR('GBOX')}`,
    description: 'לוחות חשמל מודולריים איכותיים, מוכנים להתקנה מהירה ועמידה לאורך שנים.',
  },
  {
    key: 'gtech',
    type: 'product',
    image: require('../../assets/images/product-gtech.png'),
    title: `מגני חשמל ${isolateLTR('GTECH')}`,
    description: 'מגני זרם ואביזרי הגנה מתקדמים לאמינות, בטיחות ושקט נפשי.',
  },
  {
    key: 'gifts',
    type: 'gifts',
    description: `רוכשים מוצרי ${isolateLTR('Golden Light')}, מצלמים חשבונית וצוברים נקודות למגוון מתנות והטבות.`,
  },
];

const AUTO_ADVANCE_INTERVAL_MS = 4500;
const CARD_HEIGHT = 188;

// STAGE 28.14.5: a richer 4-stop base wash - aqua at BOTH ends (not just
// one), a near-white and a solid-white stop in between, so the decorative
// washes below (see DecorativeAqua) have a continuously-blended surface to
// sit on rather than flat white. This alone covers a meaningfully larger
// share of the card in a soft aqua tint than Stage 28.14.4's 3-stop,
// mostly-white version did.
const BASE_GRADIENT_COLORS = [
  'rgba(46, 196, 199, 0.10)',
  'rgba(46, 196, 199, 0.04)',
  '#FFFFFF',
  'rgba(46, 196, 199, 0.07)',
];
const BASE_GRADIENT_LOCATIONS = [0, 0.35, 0.65, 1];

// STAGE 28.14.5: replaces Stage 28.14.4's three smaller, more sharply
// -edged circles with four MUCH larger, lower-opacity, heavily-overlapping
// washes. The key change is scale: each wash is now large enough that only
// a small, gently-curved fraction of its edge ever falls inside the card -
// at this size:card ratio the visible boundary reads as a soft gradient,
// not a circle's rim - and where two washes overlap (all four cluster
// toward the left/bottom, per this stage's brief), their opacities stack
// into a continuous density gradient rather than one shape's hard edge
// meeting flat white. Lower per-wash opacity than Stage 28.14.4 (max 0.11
// here vs 0.14 there) is more than offset by the much larger covered area,
// matching the "more area, less hardness" direction. `strength` scales
// every wash's opacity so the gifts slide can read ~10-15% richer without
// duplicating the whole set.
function DecorativeAqua({ strength = 1 }) {
  return (
    <>
      <View
        pointerEvents="none"
        style={[styles.decorativeUpperLeft, { opacity: 0.11 * strength }]}
      />
      <View
        pointerEvents="none"
        style={[styles.decorativeLowerLeft, { opacity: 0.08 * strength }]}
      />
      <View
        pointerEvents="none"
        style={[styles.decorativeLowerRight, { opacity: 0.05 * strength }]}
      />
      <View
        pointerEvents="none"
        style={[styles.decorativeUpperRight, { opacity: 0.025 * strength }]}
      />
    </>
  );
}

function ProductSlide({ item, cardWidth }) {
  return (
    <View
      style={[styles.itemShadowWrap, { width: cardWidth || undefined, height: CARD_HEIGHT }]}
      accessible
      accessibilityLabel={item.title}>
      <View style={styles.card}>
        <LinearGradient
          colors={BASE_GRADIENT_COLORS}
          locations={BASE_GRADIENT_LOCATIONS}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0.75 }}
          style={StyleSheet.absoluteFillObject}
          pointerEvents="none"
        />
        <DecorativeAqua />

        <View style={styles.slideRow}>
          <View style={styles.slideTextArea}>
            <Text style={styles.slideTitle} numberOfLines={2}>
              {item.title}
            </Text>
            <Text style={styles.slideDescription} numberOfLines={3}>
              {item.description}
            </Text>
          </View>
          {/* A white rounded "chip" behind the product photo, opaque on top
              of the decorative aqua layers above - keeps light/white
              products (GLIGHT's fixture, GBOX/GTECH's white plastic
              housings) clearly separated from the background no matter
              where a decorative shape happens to sit underneath it. */}
          <View style={styles.slideImageArea}>
            <View style={styles.slideImageChip}>
              <Image source={item.image} style={styles.slideImage} resizeMode="contain" />
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}

// STAGE 28.14.1: reconstructs the gift-badge + sparkle-badge visual the old
// (pre-28.14) Home promo used (Ionicons "gift"/"sparkles" over plain styled
// Views, no image asset, no emoji anywhere).
// STAGE 28.14.4: enlarged and given its own soft aqua halo so it reads as
// more intentional/special than a normal small utility icon, and the title
// is now two lines (dark first line, turquoise second line) for stronger
// hierarchy than the product slides' single-line titles. The CTA that used
// to sit below the description (Stage 28.14.1) was removed in Stage 28.14.3
// and stays removed - this slide is informational only, no Pressable
// anywhere in it.
function GiftsSlide({ item, cardWidth }) {
  return (
    <View
      style={[styles.itemShadowWrap, { width: cardWidth || undefined, height: CARD_HEIGHT }]}
      accessible
      accessibilityLabel="צוברים נקודות ומקבלים מתנות">
      <View style={styles.card}>
        <LinearGradient
          colors={BASE_GRADIENT_COLORS}
          locations={BASE_GRADIENT_LOCATIONS}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0.75 }}
          style={StyleSheet.absoluteFillObject}
          pointerEvents="none"
        />
        {/* strength > 1: the gifts slide's decorative washes read ~10-15%
            richer than the product slides' - not darker, just a bit more
            aqua coverage - per this stage's explicit ratio. */}
        <DecorativeAqua strength={1.15} />

        <View style={styles.slideRow}>
          <View style={styles.slideTextArea}>
            <Text style={styles.giftsTitle} numberOfLines={2}>
              {'צוברים נקודות\n'}
              <Text style={styles.giftsTitleAccent}>ומקבלים מתנות</Text>
            </Text>
            <Text style={styles.slideDescription} numberOfLines={2}>
              {item.description}
            </Text>
          </View>
          <View style={styles.slideImageArea}>
            {/* Soft circular aqua halo behind the gift badge - larger and
                lower-opacity than the badge itself, giving it a bit of
                ambient "glow" without being a hard-edged shape. */}
            <View style={styles.giftsHalo} pointerEvents="none" />
            <View style={styles.giftsBadgeWrap}>
              <View style={styles.giftsBadge}>
                <Ionicons name="gift" size={34} color={colors.primary} />
              </View>
              <View style={styles.giftsSparkleBadge}>
                <Ionicons name="sparkles" size={11} color={colors.primaryPressed} />
              </View>
              {/* A second, smaller, fainter sparkle floating near the
                  badge's opposite corner - a subtle decorative accent, not
                  an emoji, not interactive. */}
              <Ionicons
                name="sparkles"
                size={9}
                color={colors.primary}
                style={styles.giftsSparkleFloating}
              />
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}

export default function ProductCarousel() {
  const [cardWidth, setCardWidth] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isFocused, setIsFocused] = useState(true);
  const listRef = useRef(null);

  // Pauses auto-advance while Home isn't the active tab - the same
  // useFocusEffect this screen already uses for its own profile refresh.
  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);
      return () => setIsFocused(false);
    }, []),
  );

  const onWrapLayout = useCallback((event) => {
    setCardWidth(event.nativeEvent.layout.width);
  }, []);

  // Re-armed on every index change (manual swipe OR auto-advance) - this is
  // what makes a manual swipe naturally "restart" the rotation instead of
  // needing separate tracking: whatever set activeIndex last, the next full
  // interval starts counting fresh from that point.
  useEffect(() => {
    if (!isFocused || cardWidth <= 0) {
      return undefined;
    }

    const timer = setInterval(() => {
      const nextIndex = (activeIndex + 1) % SLIDES.length;
      listRef.current?.scrollToOffset({ offset: nextIndex * cardWidth, animated: true });
      setActiveIndex(nextIndex);
    }, AUTO_ADVANCE_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [activeIndex, cardWidth, isFocused]);

  const onMomentumScrollEnd = useCallback(
    (event) => {
      if (cardWidth <= 0) {
        return;
      }
      const index = Math.round(event.nativeEvent.contentOffset.x / cardWidth);
      const clampedIndex = Math.max(0, Math.min(SLIDES.length - 1, index));
      setActiveIndex(clampedIndex);
    },
    [cardWidth],
  );

  const renderItem = useCallback(
    ({ item }) =>
      item.type === 'gifts' ? (
        <GiftsSlide item={item} cardWidth={cardWidth} />
      ) : (
        <ProductSlide item={item} cardWidth={cardWidth} />
      ),
    [cardWidth],
  );

  return (
    // STAGE 28.14.4: purely structural now - no background/border/shadow of
    // its own. Every visual layer moved inside each FlatList item (see
    // ProductSlide/GiftsSlide above) so a slide's entire designed card,
    // background included, scrolls with it.
    <View style={styles.wrap} onLayout={onWrapLayout}>
      {cardWidth > 0 ? (
        <FlatList
          ref={listRef}
          data={SLIDES}
          keyExtractor={(item) => item.key}
          renderItem={renderItem}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={onMomentumScrollEnd}
          decelerationRate="fast"
        />
      ) : null}

      <View style={styles.pagination} pointerEvents="none">
        {SLIDES.map((item, index) => (
          <View key={item.key} style={[styles.dot, index === activeIndex && styles.dotActive]} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    height: CARD_HEIGHT,
  },
  // STAGE 28.14.4: shadow lives on this wrapper (one per slide item now,
  // not one shared wrapper) - a View's own overflow:'hidden' clips that
  // same view's own shadow (an established finding elsewhere in this
  // codebase), so `card` below (which needs overflow:'hidden' to clip its
  // gradient/decorative shapes to the rounded corners) can't also carry the
  // shadow itself.
  itemShadowWrap: {
    borderRadius: radius.lg,
    ...shadows.sm,
  },
  card: {
    flex: 1,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: 'rgba(46, 196, 199, 0.20)',
    backgroundColor: colors.white,
    overflow: 'hidden',
  },
  // STAGE 28.14.5: four soft aqua washes shared by every slide via
  // <DecorativeAqua/> - each MUCH larger than the card itself (up to ~2.4x
  // the card's own height), with only a small, gently-curved sliver of each
  // one actually falling inside the card's clipped bounds. At this size
  // ratio the visible boundary reads as a soft gradient fade, not a
  // circle's rim - and because upperLeft/lowerLeft both cluster on the left
  // edge and genuinely overlap there, their low opacities stack into one
  // continuous blend rather than two separate shapes meeting at a visible
  // seam.
  decorativeUpperLeft: {
    position: 'absolute',
    top: -320,
    left: -280,
    width: 460,
    height: 460,
    borderRadius: 230,
    backgroundColor: colors.primary,
  },
  decorativeLowerLeft: {
    position: 'absolute',
    bottom: -280,
    left: -250,
    width: 420,
    height: 420,
    borderRadius: 210,
    backgroundColor: colors.primary,
  },
  decorativeLowerRight: {
    position: 'absolute',
    bottom: -240,
    right: -210,
    width: 340,
    height: 340,
    borderRadius: 170,
    backgroundColor: colors.primary,
  },
  decorativeUpperRight: {
    position: 'absolute',
    top: -190,
    right: -170,
    width: 260,
    height: 260,
    borderRadius: 130,
    backgroundColor: colors.primary,
  },
  // row-reverse: first child (text) lands on the right, second child
  // (image/visual) lands on the left - the same RTL-via-row-reverse
  // convention this app uses everywhere else.
  slideRow: {
    flex: 1,
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  slideTextArea: {
    width: '56%',
    gap: 6,
  },
  slideTitle: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: '800',
    color: colors.text,
    textAlign: 'right',
  },
  // STAGE 28.14.4: slightly larger/bolder than the product slides' shared
  // slideTitle, and split across two explicit lines (see the render above)
  // - the accent line uses colors.primaryPressed, matching the exact accent
  // treatment this codebase already uses elsewhere for a Hebrew sentence's
  // one emphasized clause (e.g. the pre-28.14 Home promo's own title
  // accent).
  giftsTitle: {
    fontSize: 19,
    lineHeight: 24,
    fontWeight: '800',
    color: colors.text,
    textAlign: 'right',
  },
  giftsTitleAccent: {
    color: colors.primaryPressed,
  },
  slideDescription: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'right',
  },
  slideImageArea: {
    width: '44%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  slideImageChip: {
    width: '92%',
    height: '84%',
    borderRadius: radius.md,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xs,
  },
  slideImage: {
    width: '100%',
    height: '100%',
  },
  // STAGE 28.14.4: larger than Stage 28.14.1's 84x84 - "should feel
  // larger/more intentional than a normal small utility icon" - with the
  // new giftsHalo sitting behind it for ambient depth.
  giftsBadgeWrap: {
    width: 96,
    height: 96,
    alignItems: 'center',
    justifyContent: 'center',
  },
  giftsHalo: {
    position: 'absolute',
    width: 110,
    height: 110,
    borderRadius: 55,
    backgroundColor: colors.primary,
    opacity: 0.12,
  },
  giftsBadge: {
    width: 80,
    height: 80,
    borderRadius: 30,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(46, 196, 199, 0.28)',
    ...shadows.sm,
  },
  giftsSparkleBadge: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.sm,
  },
  giftsSparkleFloating: {
    position: 'absolute',
    bottom: 4,
    right: -2,
    opacity: 0.6,
  },
  pagination: {
    position: 'absolute',
    bottom: spacing.sm,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.border,
  },
  dotActive: {
    width: 20,
    backgroundColor: colors.primary,
  },
});
