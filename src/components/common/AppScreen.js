import {
    Keyboard,
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    StyleSheet,
    TouchableWithoutFeedback,
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

  return (
    <SafeAreaView edges={edges} style={[styles.safeArea, { backgroundColor: resolvedBackground }]}>
      {keyboardAware ? (
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.flex}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}>
          <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
            <View style={styles.flex}>
              {scrollable ? (
                <ScrollView
                  keyboardShouldPersistTaps="handled"
                  contentContainerStyle={[styles.contentContainer, contentContainerStyle]}
                  showsVerticalScrollIndicator={false}>
                  {content}
                </ScrollView>
              ) : (
                content
              )}
            </View>
          </TouchableWithoutFeedback>
        </KeyboardAvoidingView>
      ) : scrollable ? (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[styles.contentContainer, contentContainerStyle]}
          showsVerticalScrollIndicator={false}>
          {content}
        </ScrollView>
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
