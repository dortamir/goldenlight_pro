import {
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    StyleSheet,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, spacing } from '../../theme';

export default function AppScreen({
  children,
  scrollable = true,
  contentContainerStyle,
  style,
  keyboardAware = true,
  backgroundColor,
  // Optional - forwarded to SafeAreaView as-is. Every existing caller
  // leaves this unset, which keeps SafeAreaView's own default (all four
  // edges), so this is fully non-breaking. A screen nested under a bottom
  // tab bar (which already provides its own bottom safe-area clearance)
  // can pass e.g. ['top', 'left', 'right'] to avoid double-padding the
  // bottom safe-area inset on notched/home-indicator devices.
  edges,
}) {
  const resolvedBackground = backgroundColor || colors.background;

  const content = (
    <View style={[styles.inner, style]}>
      {children}
    </View>
  );

  // STAGE 16.1: keyboard-dismiss-on-tap used to be a TouchableWithoutFeedback
  // wrapping the entire ScrollView. That's a well-known source of unreliable
  // scroll-gesture recognition on iOS: TouchableWithoutFeedback claims the
  // JS touch responder on every touch-start and only releases it once a
  // scroll is detected, via the same responder-negotiation path that made
  // scrolling feel inconsistent on the physical device - a real touch has
  // latency a simulator/web preview doesn't reproduce the same way.
  // `keyboardDismissMode="on-drag"` is ScrollView's own native prop (no JS
  // responder involved at all) and dismisses the keyboard as soon as a
  // scroll drag starts - the same practical behavior, without ever
  // competing with the ScrollView's own gesture recognizer.
  const scrollViewProps = {
    keyboardShouldPersistTaps: 'handled',
    keyboardDismissMode: 'on-drag',
    contentContainerStyle: [styles.contentContainer, contentContainerStyle],
    showsVerticalScrollIndicator: false,
  };

  return (
    <SafeAreaView edges={edges} style={[styles.safeArea, { backgroundColor: resolvedBackground }]}>
      {keyboardAware ? (
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.flex}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}>
          {scrollable ? <ScrollView {...scrollViewProps}>{content}</ScrollView> : content}
        </KeyboardAvoidingView>
      ) : scrollable ? (
        <ScrollView {...scrollViewProps}>{content}</ScrollView>
      ) : (
        content
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  contentContainer: {
    flexGrow: 1,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xl,
    justifyContent: 'center',
    alignItems: 'center',
  },
  inner: {
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.lg,
  },
});
