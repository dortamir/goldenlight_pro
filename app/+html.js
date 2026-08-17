import { ScrollViewStyleReset } from 'expo-router/html';

import { colors } from '../src/theme';

// Chrome's native autofill highlight (a blue/yellow fill + its own text
// color) is applied directly to the underlying web <input> via the
// :-webkit-autofill pseudo-class, which react-native-web's StyleSheet
// system has no way to express (it only compiles real style *properties*,
// not pseudo-class selectors) - see AppInput.js. This is the one place
// Expo Router lets you inject real global CSS into the web document's
// <head>, so the override lives here instead. `box-shadow` (not
// `background-color`) is the standard cross-browser way to reset the
// autofill fill, because Chrome ignores `background-color` on
// `:-webkit-autofill` but still honors box-shadow. `!important` is required
// on every property here - Chrome applies the autofill highlight through an
// internal rendering path that outranks ordinary author-stylesheet
// specificity (a well-documented Chrome quirk, not something achievable via
// selector specificity alone), so without it this override is silently
// ignored the moment a field is actually autofilled. `:autofill` (the
// unprefixed standard form) is included alongside `:-webkit-autofill` for
// forward compatibility. Combined with `-webkit-text-fill-color`, the
// autofilled field ends up matching AppInput's normal white surface
// (colors.surface) and text color (colors.text) exactly, with no other
// input behavior changed.
const AUTOFILL_FILL_OVERRIDE = `
  -webkit-text-fill-color: ${colors.text} !important;
  color: ${colors.text} !important;
  caret-color: ${colors.text} !important;
  -webkit-box-shadow: 0 0 0 1000px ${colors.surface} inset !important;
  box-shadow: 0 0 0 1000px ${colors.surface} inset !important;
  background-color: ${colors.surface} !important;
  transition: background-color 9999s ease-in-out 0s, box-shadow 9999s ease-in-out 0s;
`;

// Kept as two separate rule blocks (not one comma-joined selector list) -
// a browser that doesn't recognize the unprefixed `:autofill` form would
// otherwise drop the *entire* combined selector list, including the
// `:-webkit-autofill` rules it does understand.
const AUTOFILL_OVERRIDE_CSS = `
input:-webkit-autofill,
input:-webkit-autofill:hover,
input:-webkit-autofill:focus,
input:-webkit-autofill:active {
  ${AUTOFILL_FILL_OVERRIDE}
}
input:autofill,
input:autofill:hover,
input:autofill:focus,
input:autofill:active {
  ${AUTOFILL_FILL_OVERRIDE}
}
`;

export default function Root({ children }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />
        <ScrollViewStyleReset />
        <style dangerouslySetInnerHTML={{ __html: AUTOFILL_OVERRIDE_CSS }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
