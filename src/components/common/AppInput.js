import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, radius, spacing, typography } from '../../theme';

export default function AppInput({
  label,
  value,
  onChangeText,
  placeholder,
  secureTextEntry = false,
  error,
  style,
  inputStyle,
  textAlign = 'right',
  writingDirection = 'rtl',
  // Optional overrides for the field's own surface and the label text,
  // e.g. so a screen on a dark background can theme its inputs without
  // this component needing to know it's ever used on anything but a light
  // surface. Both are purely additive - omitted everywhere except the auth
  // screens, so every existing call site renders exactly as before. Applied
  // *after* the focus/error state colors below so a caller's default-state
  // override never accidentally masks the focus/error indicator.
  containerStyle,
  labelStyle,
  // Optional caller-supplied focus/blur callbacks, invoked ALONGSIDE this
  // component's own internal focus-ring tracking below (never instead of
  // it) - purely additive, omitted everywhere except call sites that need
  // to know focus state for their own purposes (e.g. an inline suggestion
  // dropdown that should only show while its input is focused). Every
  // existing call site that doesn't pass these renders exactly as before.
  onFocus,
  onBlur,
  ...props
}) {
  const [isFocused, setIsFocused] = useState(false);

  return (
    <View style={[styles.wrapper, style]}>
      {label ? <Text style={[styles.label, labelStyle]}>{label}</Text> : null}
      <Pressable
        style={[
          styles.container,
          containerStyle,
          isFocused && styles.focused,
          error ? styles.error : null,
        ]}>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.textMuted}
          secureTextEntry={secureTextEntry}
          selectionColor={colors.primary}
          style={[styles.input, inputStyle, { textAlign, writingDirection }]}
          onFocus={(e) => {
            setIsFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setIsFocused(false);
            onBlur?.(e);
          }}
          {...props}
        />
      </Pressable>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    width: '100%',
  },
  label: {
    color: colors.text,
    fontSize: typography.caption.fontSize,
    lineHeight: typography.caption.lineHeight,
    fontWeight: '600',
    marginBottom: spacing.xs,
  },
  container: {
    minHeight: 52,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    justifyContent: 'center',
  },
  input: {
    color: colors.text,
    fontSize: typography.body.fontSize,
    lineHeight: typography.body.lineHeight,
    paddingVertical: spacing.sm,
    textAlign: 'right',
    textAlignVertical: 'center',
    writingDirection: 'rtl',
    // On web, TextInput renders a real DOM <input>, which gets the browser's
    // own square focus outline on top of this component's rounded turquoise
    // focus ring (see `focused` below) - suppress only that native ring;
    // `focused` remains the sole visual focus indicator.
    ...Platform.select({ web: { outlineStyle: 'none' } }),
  },
  // A soft turquoise glow (not the generic black card shadow) reads as an
  // intentional focus state rather than "this input is elevated like a
  // card" - kept subtle on purpose.
  focused: {
    borderColor: colors.primary,
    shadowColor: colors.primary,
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
    elevation: 2,
  },
  error: {
    borderColor: colors.error,
  },
  errorText: {
    color: colors.error,
    fontSize: typography.caption.fontSize,
    lineHeight: typography.caption.lineHeight,
    marginTop: spacing.xs,
  },
});
