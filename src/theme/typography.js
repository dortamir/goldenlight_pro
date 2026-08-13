export const typography = {
  // The single most important number on a screen (points balance) - sized
  // for a phone, not the ~90px+ a desktop hero would use.
  hero: {
    fontSize: 52,
    lineHeight: 56,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  display: {
    fontSize: 40,
    lineHeight: 48,
    fontWeight: '800',
    letterSpacing: -0.02,
  },
  heading: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '700',
    letterSpacing: -0.01,
  },
  title: {
    fontSize: 20,
    lineHeight: 28,
    fontWeight: '600',
    letterSpacing: 0,
  },
  body: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '400',
    letterSpacing: 0,
  },
  caption: {
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '400',
    letterSpacing: 0.01,
  },
  // Tiny uppercase labels (tier name, "MEMBER"-style tags) - always pair
  // with wide letterSpacing, never used for anything readable at length.
  micro: {
    fontSize: 10,
    lineHeight: 14,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  button: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '600',
    letterSpacing: 0.01,
  },
};

export default typography;
