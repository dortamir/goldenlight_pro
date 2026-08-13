import { colors } from './colors';

export const shadows = {
  none: {
    shadowColor: 'transparent',
    shadowOpacity: 0,
    shadowRadius: 0,
    shadowOffset: { width: 0, height: 0 },
    elevation: 0,
  },
  sm: {
    shadowColor: '#111111',
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  md: {
    shadowColor: '#111111',
    shadowOpacity: 0.12,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
  },
  lg: {
    shadowColor: '#111111',
    shadowOpacity: 0.16,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 6,
  },
  // The two shared "premium" shadow levels - prefer these over ad-hoc
  // shadow values on individual screens. Both are intentionally soft (low
  // opacity, larger blur, no harsh offset) so cards read as gently floating
  // rather than boxed-in; pair with a light border (or none) rather than a
  // strong outline.
  softCard: {
    shadowColor: '#0B0B0B',
    shadowOpacity: 0.06,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 3,
  },
  premiumCard: {
    shadowColor: '#0B0B0B',
    shadowOpacity: 0.1,
    shadowRadius: 26,
    shadowOffset: { width: 0, height: 14 },
    elevation: 7,
  },
  // A turquoise glow (not a black shadow) for dark hero cards - e.g. the
  // points-balance card. Kept low-opacity/large-blur so it reads as an
  // ambient glow, never a harsh colored drop shadow.
  glow: {
    shadowColor: colors.primary,
    shadowOpacity: 0.25,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  // Subtle turquoise lift for primary CTAs. Values intentionally match what
  // PrimaryButton.js currently hardcodes inline - that inline copy will be
  // migrated to reference this token directly in the next stage, not
  // changed visually.
  buttonGlow: {
    shadowColor: colors.primaryPressed,
    shadowOpacity: 0.22,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 3,
  },
};

export default shadows;
