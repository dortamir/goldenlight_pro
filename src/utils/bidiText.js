// Unicode bidi isolation for mixed Hebrew/English/numeric text.
//
// PROBLEM: a Hebrew (RTL) sentence that embeds an English phrase, a number,
// a currency amount, a SKU/barcode, a date, a filename, an email, or a
// phone number can render with the embedded value in the wrong visual
// position (or reordered internally) depending on the platform's bidi
// engine and on exactly which characters happen to sit next to it. This is
// NOT fixed by textAlign ('right' only controls block alignment, not
// character-level direction resolution) and must NOT be fixed by forcing
// the whole app/screen into RTL or LTR mode - see App.js/the removed
// I18nManager.forceRTL() call for why global RTL forcing was deliberately
// abandoned.
//
// FIX: wrap the embedded value in Unicode directional ISOLATE characters.
// This is plain Unicode text, not a platform or web-only API - it is
// resolved identically by any Unicode-compliant bidi engine (ICU in a web
// browser, CoreText on iOS, the platform text layout engine on Android), so
// it works correctly in Expo Web, iOS, and Android without any
// platform-specific branching.
//
//   U+2066 LRI  (LEFT-TO-RIGHT ISOLATE)  - opens an isolated LTR span
//   U+2069 PDI  (POP DIRECTIONAL ISOLATE) - closes the isolated span
//
// "Isolated" means: characters inside the span are laid out left-to-right
// regardless of the surrounding paragraph's direction, AND the surrounding
// Hebrew text is never reordered by what's inside the span - the two
// directions can never leak into each other. This is the standards-based
// way to embed a value whose internal order must always stay correct
// (English words, numbers, currency, SKUs, barcodes, dates, filenames,
// emails, phone numbers) inside an RTL sentence, or vice versa.
//
// Centralized here on purpose (per project convention) rather than
// scattering literal \u2066/\u2069 characters across screens - every call
// site should read isolateLTR(...), never a raw invisible character.
const LEFT_TO_RIGHT_ISOLATE = '\u2066';
const POP_DIRECTIONAL_ISOLATE = '\u2069';

// Wraps `value` so it always renders in its own correct left-to-right
// internal order, no matter what Hebrew/RTL text surrounds it in the final
// sentence. Never changes the visible characters - only adds invisible
// Unicode isolation marks around them. Accepts a string or number; null/
// undefined safely become an empty string (so it can always be used
// directly inside a template literal without a separate null check).
//
// Typical use - wrap ONLY the embedded LTR/numeric segment, not the whole
// sentence:
//
//   `סכום מוצרי ${isolateLTR('Golden Light')}: ${isolateLTR(`₪${total.toFixed(2)}`)}`
//   `מק״ט ${isolateLTR(sku)}`
//   `G Level: ${isolateLTR(levelLabel)}`
//   `${isolateLTR(fileName)}`
//   `הועלתה ב-${isolateLTR(formattedDate)}`
export function isolateLTR(value) {
  if (value === null || value === undefined) {
    return '';
  }
  const text = String(value);
  if (!text) {
    return text;
  }
  return `${LEFT_TO_RIGHT_ISOLATE}${text}${POP_DIRECTIONAL_ISOLATE}`;
}