import { Image } from 'expo-image';
import { StyleSheet } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

const MIN_SCALE = 1;
const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2;

// STAGE 16.1: pinch-to-zoom/pan/double-tap for a full-screen image viewer,
// built entirely on react-native-gesture-handler + react-native-reanimated
// - both ALREADY installed (peer dependencies of expo-router/
// react-native-screens for their own stack-transition gestures) and already
// at their expected SDK-57-compatible versions, but never previously
// imported directly by this app's own code. No new dependency was added -
// this is the standard, well-tested Gesture-API pattern for exactly this
// use case (the same composition react-native-gesture-handler's own docs
// use for an image-zoom viewer), safer and more reliable than hand-rolling
// multi-touch distance math with PanResponder.
//
// Wrapped in its own GestureHandlerRootView: React Native's <Modal> renders
// its children in a separate native window outside the app's normal view
// hierarchy, and gesture-handler needs a root inside THAT window to
// recognize gestures correctly there - a well-documented gesture-handler +
// Modal requirement, independent of any root-level GestureHandlerRootView
// the rest of the app may or may not have.
//
// The transform is applied to a wrapping Animated.View, not the <Image>
// itself - expo-image is a separate native component, and animating a
// plain View's transform is the more robust, universally-supported
// pattern. contentFit="contain" + cachePolicy/recyclingKey are unchanged
// from the non-zoomable usage this replaces, so image quality/caching
// behavior is identical - only pan/zoom is new.
export default function ZoomableImage({ uri, recyclingKey }) {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);

  const resetZoom = () => {
    'worklet';
    scale.value = withTiming(MIN_SCALE);
    translateX.value = withTiming(0);
    translateY.value = withTiming(0);
    savedScale.value = MIN_SCALE;
    savedTranslateX.value = 0;
    savedTranslateY.value = 0;
  };

  const pinchGesture = Gesture.Pinch()
    .onUpdate((event) => {
      scale.value = Math.max(MIN_SCALE, Math.min(savedScale.value * event.scale, MAX_SCALE));
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      if (scale.value <= MIN_SCALE) {
        resetZoom();
      }
    });

  const panGesture = Gesture.Pan()
    .onUpdate((event) => {
      // Only pans while zoomed in - an unzoomed image shouldn't drift when
      // dragged, matching a normal photo viewer's behavior.
      if (savedScale.value <= MIN_SCALE) {
        return;
      }
      translateX.value = savedTranslateX.value + event.translationX;
      translateY.value = savedTranslateY.value + event.translationY;
    })
    .onEnd(() => {
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    });

  const doubleTapGesture = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      if (savedScale.value > MIN_SCALE) {
        resetZoom();
      } else {
        scale.value = withTiming(DOUBLE_TAP_SCALE);
        savedScale.value = DOUBLE_TAP_SCALE;
      }
    });

  // Pinch and pan run together (pinch-while-panning is normal photo-viewer
  // behavior); double-tap races against that combined gesture rather than
  // being composed with it - a genuine double-tap involves negligible
  // finger movement, so Pan's own minimum-distance activation naturally
  // never wins that race, letting both gestures coexist correctly (the
  // same composition pattern used in gesture-handler's own official
  // image-zoom example).
  const zoomGesture = Gesture.Simultaneous(pinchGesture, panGesture);
  const gesture = Gesture.Race(doubleTapGesture, zoomGesture);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  return (
    <GestureHandlerRootView style={styles.root}>
      <GestureDetector gesture={gesture}>
        <Animated.View style={[styles.root, animatedStyle]}>
          <Image
            source={{ uri }}
            style={styles.image}
            contentFit="contain"
            cachePolicy="memory-disk"
            recyclingKey={recyclingKey}
            transition={100}
          />
        </Animated.View>
      </GestureDetector>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: {
    width: '100%',
    height: '100%',
  },
});