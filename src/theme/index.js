import { colors } from './colors';
import { radius } from './radius';
import { shadows } from './shadows';
import { spacing } from './spacing';
import { typography } from './typography';

export { colors, colors as colorsTheme } from './colors';
export { radius, radius as radiusTheme } from './radius';
export { shadows, shadows as shadowsTheme } from './shadows';
export { spacing, spacing as spacingTheme } from './spacing';
export { typography, typography as typographyTheme } from './typography';

export const theme = {
  colors,
  spacing,
  typography,
  radius,
  shadows,
};

export default theme;
