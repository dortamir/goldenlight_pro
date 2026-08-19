// Official G Level thresholds - based ONLY on the real, database-computed
// public.profiles.approved_purchases_count (see
// supabase/migrations/017_g_level_progression.sql:
// public.recalculate_membership_level(), the authoritative source). This
// file is a read-only client-side mirror of that same business rule, used
// only to render an optional "X / Y toward next level" progress hint - it
// never computes or sends an authoritative level/count anywhere; the
// database's profiles.membership_level value is always what's actually
// displayed as the level itself.
export const MEMBERSHIP_LEVELS = ['BRONZE', 'SILVER', 'GOLD', 'TITANIUM'];

// Each level's starting threshold (inclusive), in approved-report count.
// Titanium is the current maximum - no level exists above it.
export const MEMBERSHIP_LEVEL_THRESHOLDS = {
  BRONZE: 0,
  SILVER: 12,
  GOLD: 24,
  TITANIUM: 36,
};

// Given a real approved_purchases_count, returns which level it belongs to
// and how far into the current bracket it is. Titanium has no next level -
// nextLevel/progressPercent/remainingToNext are all null in that case,
// never invented or shown as progress toward a nonexistent fifth level.
export function getMembershipLevelInfo(approvedCount) {
  const count = Number.isFinite(approvedCount) && approvedCount > 0 ? approvedCount : 0;

  let level = 'BRONZE';
  for (const candidate of MEMBERSHIP_LEVELS) {
    if (count >= MEMBERSHIP_LEVEL_THRESHOLDS[candidate]) {
      level = candidate;
    }
  }

  const levelIndex = MEMBERSHIP_LEVELS.indexOf(level);
  const currentThreshold = MEMBERSHIP_LEVEL_THRESHOLDS[level];
  const nextLevel = MEMBERSHIP_LEVELS[levelIndex + 1] || null;
  const nextThreshold = nextLevel ? MEMBERSHIP_LEVEL_THRESHOLDS[nextLevel] : null;

  const bracketSize = nextThreshold != null ? nextThreshold - currentThreshold : null;
  const progressInBracket = nextThreshold != null ? count - currentThreshold : null;
  const remainingToNext = nextThreshold != null ? Math.max(0, nextThreshold - count) : null;
  const progressPercent =
    bracketSize && bracketSize > 0
      ? Math.max(0, Math.min(100, (progressInBracket / bracketSize) * 100))
      : null;

  return {
    level,
    nextLevel,
    progressInBracket,
    bracketSize,
    remainingToNext,
    progressPercent,
  };
}
