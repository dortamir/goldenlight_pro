export const colors = {
  background: '#F7FBFB',
  surface: '#FFFFFF',
  surfaceMuted: '#F4F7F8',
  surfaceElevated: '#F9FCFC',
  text: '#0B0B0B',
  textMuted: '#7A7A7A',
  border: '#D9E1E3',
  black: '#000000',
  white: '#FFFFFF',
  primary: '#2EC4C7',
  primaryPressed: '#22B5B9',
  primarySoft: '#EAF9F9',
  // Was aliased to turquoise (a scaffold-era placeholder never actually
  // consumed anywhere - verified via repo-wide search before changing these
  // values). Now genuinely gold, for sparing use as an accent only (tier
  // badges, VIP touches) - never as a base/background color.
  gold: '#D4AF37',
  goldDeep: '#B8942C',
  goldSoft: '#F7F0DC',
  grayLight: '#F4F7F8',
  grayMedium: '#D9E1E3',
  grayDark: '#7A7A7A',
  success: '#2E8B57',
  successSoft: '#E8F5EE',
  error: '#C24B4B',
  errorSoft: '#FBECEC',
  // ~5.2:1 against white - meets WCAG AA for normal-size text, consistent
  // with how `error` above is calibrated.
  warning: '#996116',
  warningSoft: '#FBF0DF',
  // Premium dark-card palette (near-black, not pure #000) - used only for
  // selected high-value sections (e.g. the Home points card), never as a
  // whole-app background. Pair with mutedOnDark for secondary text and
  // charcoalBorder for a barely-there turquoise-tinted edge.
  charcoal: '#14181A',
  charcoalBorder: 'rgba(46, 196, 199, 0.18)',
  mutedOnDark: '#9AA6A8',
  // --- Premium dark-brand redesign additions ---
  // The app's deepest background, one step darker than `charcoal` - for
  // full-bleed dark headers/hero gradients that a `charcoal` card then sits
  // on top of (charcoal reads as "elevated" against this). Never mixed with
  // charcoal as if they were the same surface.
  bgDark: '#0A0E0E',
  // A nested inset panel *inside* a charcoal/bgDark card (one step lighter
  // than charcoal) - e.g. a sub-box within the dark points card.
  bgDarkInset: '#1C2626',
  // Endpoints for the brand gradient (used with expo-linear-gradient's
  // `colors` prop) - gradientDarkStart intentionally equals bgDark so a
  // gradient header and a flat bgDark surface never mismatch at the seam.
  gradientDarkStart: '#0A0E0E',
  gradientDarkEnd: '#0F3D3D',
  // A turquoise glow for shadows around dark cards/primary CTAs - see
  // shadows.glow / shadows.buttonGlow, which source their shadowColor from
  // `primary`/`primaryPressed` directly; this rgba is for cases (e.g. a
  // manual blurred glow layer) that need the color pre-mixed with alpha.
  primaryGlow: 'rgba(46, 196, 199, 0.35)',
  // Primary (non-muted) text on a dark surface - pair with `mutedOnDark`
  // above for secondary/supporting text on the same surface.
  textOnDark: '#F5F7F7',
  // Loyalty tier colors - real color per tier instead of a plain text label.
  // Four official G Levels (see src/constants/membershipLevels.js): Bronze,
  // Silver, Gold, Titanium (current maximum). tierTitanium is a cool
  // gunmetal/graphite tone - deliberately darker and more premium-reading
  // than tierSilver's light gray, while staying legible both on the dark
  // PointsBalanceCard hero and on ProfileScreen's white summary card, same
  // as the other three tier colors.
  tierBronze: '#B08D57',
  tierSilver: '#B7C1C1',
  tierGold: '#D4AF37',
  tierTitanium: '#6E7C89',
  // A barely-there "glass" surface for content that must sit directly on a
  // dark gradient without a solid card behind it (e.g. the auth logo) -
  // enough to lift it off the background for contrast, without reading as
  // an opaque card of its own.
  glassFill: 'rgba(255, 255, 255, 0.06)',
  glassBorder: 'rgba(255, 255, 255, 0.12)',
  // `error` (#C24B4B) is calibrated for light surfaces (~4.8:1 on white)
  // and drops to ~3.7:1 on the dark charcoal card - below WCAG AA for
  // normal text. This lighter coral hits ~6.7:1 on charcoal while still
  // reading unambiguously as an error color.
  errorOnDark: '#E8827E',
  // A warm light-gray form-card surface - between white and mid-gray, for
  // the auth form card sitting on the dark hero gradient. ~15.9:1 contrast
  // against `text` (#0B0B0B), far exceeding WCAG AA.
  cardLight: '#E4E8E8',
};

export default colors;
