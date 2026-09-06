// Centralized constants for external URLs this app links out to. A `null`
// value means "link not ready yet" - every screen that reads these must
// treat `null` as disabled and fail safely (show a "בקרוב"/disabled state,
// never navigate anywhere) rather than opening a fake or broken
// destination. See RewardsScreen's openExternalLinkSafely for the actual
// safe-open behavior (canOpenURL-gated, opens as an external browser/app
// link - never an internal Expo Router route - and never surfaces a raw
// error to the user on failure).

// Where the user redeems their accumulated points. Not available yet -
// replace this string with the real redemption URL once it exists.
export const POINTS_REDEMPTION_URL = null;

// STAGE 18.5: the real, approved production Golden Light website.
export const GOLDEN_LIGHT_WEBSITE_URL = 'https://www.golden-light.co.il/';