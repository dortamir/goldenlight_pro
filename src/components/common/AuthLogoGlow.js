import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import { StyleSheet } from 'react-native';

import { colors } from '../../theme';

// A single true radial gradient (SVG), not several stacked flat-opacity
// circles - opacity is interpolated continuously by the SVG renderer from
// the center out to the edge, so there is no ring/boundary anywhere, only
// one smooth falloff. Deliberately large relative to the logo it sits
// behind so its zero-opacity outer edge is well past the logo/card, making
// it imperceptible against the dark gradient rather than a visible circle.
const SIZE = 380;

export default function AuthLogoGlow() {
  return (
    <Svg width={SIZE} height={SIZE} style={styles.container} pointerEvents="none">
      <Defs>
        <RadialGradient id="authLogoGlow" cx="50%" cy="50%" r="50%">
          <Stop offset="0%" stopColor={colors.primary} stopOpacity={0.38} />
          <Stop offset="35%" stopColor={colors.primary} stopOpacity={0.2} />
          <Stop offset="70%" stopColor={colors.primary} stopOpacity={0.06} />
          <Stop offset="100%" stopColor={colors.primary} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect x={0} y={0} width={SIZE} height={SIZE} fill="url(#authLogoGlow)" />
    </Svg>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: -90,
    alignSelf: 'center',
  },
});
