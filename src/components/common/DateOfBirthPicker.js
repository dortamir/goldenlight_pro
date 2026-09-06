import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing, typography } from '../../theme';

// STAGE 26: a self-contained date-of-birth picker built entirely from
// existing React Native primitives (Modal/ScrollView/Pressable) - no new
// dependency. @expo/ui's own bundled "community" DateTimePicker
// (node_modules/@expo/ui/src/community/datetime-picker) was checked first
// per this stage's explicit instruction, but its web implementation
// (DateTimePicker.web.tsx) renders nothing at all (`return null`) - since
// this app also ships a web build (validated via `npx expo export
// --platform web`), that component would leave web users with no picker
// whatsoever, so it was not used. No other date-picker package
// (@react-native-community/datetimepicker or similar) exists in
// package.json/node_modules. This component instead renders a real
// picker UI - three scrollable day/month/year columns in a modal sheet -
// that works identically on iOS, Android, and web.
const HEBREW_MONTHS = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
];

// `month` is 1-based here (JS's own Date(year, month, 0) trick: day 0 of
// the NEXT 1-based month is the last day of the target month), so this
// correctly returns 29 for February in a leap year and 28 otherwise -
// there is no separate leap-year branch needed on the client side.
function daysInMonth(month, year) {
  return new Date(year, month, 0).getDate();
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function parseIsoDate(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (!year || !month || !day) {
    return null;
  }

  return { year, month, day };
}

function PickerColumn({ items, selected, onSelect, formatItem, style }) {
  return (
    <ScrollView style={[styles.column, style]} showsVerticalScrollIndicator={false}>
      {items.map((item) => {
        const isSelected = item === selected;
        return (
          <Pressable
            key={item}
            onPress={() => onSelect(item)}
            accessibilityRole="button"
            accessibilityState={{ selected: isSelected }}
            style={[styles.columnRow, isSelected && styles.columnRowSelected]}>
            <Text style={[styles.columnRowText, isSelected && styles.columnRowTextSelected]} numberOfLines={1}>
              {formatItem(item)}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

// Props:
//   label       - field label above the pressable box (matches AppInput's
//                 own label styling).
//   value       - the stored value, 'YYYY-MM-DD' or null/undefined. Never
//                 mutated here - purely controlled, exactly like AppInput.
//   onChange    - called with a new 'YYYY-MM-DD' string only when the user
//                 explicitly presses "אישור" (confirm). Never called on
//                 open/cancel/backdrop-dismiss, and the field never shows
//                 anything but its own real `value` prop or an empty
//                 placeholder - no default-to-today of any kind.
//   maxDate     - optional Date; defaults to today (a birthday cannot be a
//                 future date). Passed as a real Date so callers never need
//                 to know this component's internal year-range math.
//   error       - optional error string, same treatment as AppInput's own.
//   disabled    - when true, the field is not pressable (used for a
//                 birthday that has already been permanently set - see
//                 ProfileScreen/EditProfileScreen).
//   style       - optional outer style override, same convention as every
//                 other shared input in this app.
export default function DateOfBirthPicker({
  label = 'תאריך לידה',
  value,
  onChange,
  maxDate,
  error,
  disabled = false,
  style,
}) {
  const [visible, setVisible] = useState(false);

  const today = maxDate instanceof Date ? maxDate : new Date();
  const maxYear = today.getFullYear();
  const minYear = maxYear - 100;

  const parsedValue = useMemo(() => parseIsoDate(value), [value]);

  const defaultPending = useMemo(
    () => parsedValue || { day: 1, month: 1, year: maxYear - 30 },
    // Only recomputed when the modal is (re)opened against a new stored
    // value - see openPicker() below, which is the sole place that reads
    // this as a starting point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const [pending, setPending] = useState(defaultPending);

  const openPicker = () => {
    if (disabled) {
      return;
    }
    setPending(parsedValue || { day: 1, month: 1, year: maxYear - 30 });
    setVisible(true);
  };

  const pendingMaxDay = daysInMonth(pending.month, pending.year);
  const safeDay = Math.min(pending.day, pendingMaxDay);

  // A year/month change can leave `day` pointing past the new month's real
  // length (e.g. switching away from a 31-day month while day=31 is
  // selected, or off a leap-year Feb 29) - clamped here for confirm() and
  // for what the day column itself highlights, without ever silently
  // committing that clamp to the stored value until the user presses
  // confirm.
  const confirm = () => {
    const finalDay = Math.min(pending.day, daysInMonth(pending.month, pending.year));
    const nextValue = `${pending.year}-${pad2(pending.month)}-${pad2(finalDay)}`;
    onChange?.(nextValue);
    setVisible(false);
  };

  const displayText = parsedValue
    ? `${pad2(parsedValue.day)}/${pad2(parsedValue.month)}/${parsedValue.year}`
    : '';

  const dayItems = useMemo(
    () => Array.from({ length: daysInMonth(pending.month, pending.year) }, (_, i) => i + 1),
    [pending.month, pending.year],
  );
  const monthItems = useMemo(() => Array.from({ length: 12 }, (_, i) => i + 1), []);
  const yearItems = useMemo(() => {
    const list = [];
    for (let y = maxYear; y >= minYear; y -= 1) {
      list.push(y);
    }
    return list;
  }, [maxYear, minYear]);

  return (
    <View style={[styles.wrapper, style]}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <Pressable
        style={[
          styles.field,
          error ? styles.fieldError : null,
          disabled ? styles.fieldDisabled : null,
        ]}
        onPress={openPicker}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={label}>
        <Text style={[styles.valueText, !displayText && styles.placeholderText]}>
          {displayText || 'בחרו תאריך לידה'}
        </Text>
      </Pressable>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      <Modal visible={visible} transparent animationType="fade" onRequestClose={() => setVisible(false)}>
        <View style={styles.modalRoot}>
          <Pressable
            style={styles.backdrop}
            onPress={() => setVisible(false)}
            accessibilityRole="button"
            accessibilityLabel="סגירה"
          />

          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>תאריך לידה</Text>

            <View style={styles.columnsRow}>
              <PickerColumn items={yearItems} selected={pending.year} formatItem={String} onSelect={(year) => setPending((p) => ({ ...p, year }))} />
              <PickerColumn
                items={monthItems}
                selected={pending.month}
                formatItem={(month) => HEBREW_MONTHS[month - 1]}
                onSelect={(month) => setPending((p) => ({ ...p, month }))}
                style={styles.monthColumn}
              />
              <PickerColumn items={dayItems} selected={safeDay} formatItem={pad2} onSelect={(day) => setPending((p) => ({ ...p, day }))} />
            </View>

            <View style={styles.actionsRow}>
              <Pressable
                style={({ pressed }) => [styles.cancelButton, pressed && styles.actionPressed]}
                onPress={() => setVisible(false)}
                accessibilityRole="button">
                <Text style={styles.cancelText}>ביטול</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.confirmButton, pressed && styles.actionPressed]}
                onPress={confirm}
                accessibilityRole="button">
                <Text style={styles.confirmText}>אישור</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const COLUMN_HEIGHT = 220;

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
  field: {
    minHeight: 52,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    justifyContent: 'center',
  },
  fieldError: {
    borderColor: colors.error,
  },
  fieldDisabled: {
    opacity: 0.7,
  },
  valueText: {
    color: colors.text,
    fontSize: typography.body.fontSize,
    lineHeight: typography.body.lineHeight,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  placeholderText: {
    color: colors.textMuted,
  },
  errorText: {
    color: colors.error,
    fontSize: typography.caption.fontSize,
    lineHeight: typography.caption.lineHeight,
    marginTop: spacing.xs,
  },
  modalRoot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(6, 10, 10, 0.6)',
  },
  sheet: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: colors.white,
    borderRadius: radius.xl,
    padding: spacing.lg,
  },
  sheetTitle: {
    fontSize: typography.heading.fontSize,
    fontWeight: typography.heading.fontWeight,
    color: colors.text,
    textAlign: 'center',
    marginBottom: spacing.md,
  },
  columnsRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  column: {
    flex: 1,
    height: COLUMN_HEIGHT,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceMuted,
  },
  monthColumn: {
    flex: 1.4,
  },
  columnRow: {
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
  },
  columnRowSelected: {
    backgroundColor: colors.primarySoft,
  },
  columnRowText: {
    fontSize: typography.body.fontSize,
    fontWeight: '500',
    color: colors.textMuted,
    textAlign: 'center',
  },
  columnRowTextSelected: {
    fontWeight: '700',
    color: colors.primaryPressed,
  },
  actionsRow: {
    flexDirection: 'row-reverse',
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  cancelButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: radius.lg,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionPressed: {
    opacity: 0.85,
  },
  cancelText: {
    fontSize: typography.button.fontSize,
    fontWeight: '600',
    color: colors.textMuted,
  },
  confirmText: {
    fontSize: typography.button.fontSize,
    fontWeight: '700',
    color: colors.black,
  },
});