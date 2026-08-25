// Centralized placeholder constants for external URLs this app links out to
// but doesn't own/control yet. Deliberately `null` (not "#", not a made-up
// production URL) until the real destination is provided - every screen
// that reads these must treat `null` as "link not ready yet" and fail
// safely (hide/disable the action, never navigate anywhere) rather than
// opening a fake or broken destination. See RewardsScreen's
// openExternalLinkSafely for the actual safe-open behavior.

// Where the user redeems their accumulated points. Not available yet -
// replace this string with the real redemption URL once it exists.
export const POINTS_REDEMPTION_URL = null;

// The official Golden Light website (or a specific landing/collection page
// on it). Not available yet - replace this string with the real URL once
// it exists.
export const GOLDEN_LIGHT_WEBSITE_URL = null;