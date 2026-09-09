// Official GOLDEN+ membership tiers - based ONLY on the real, database
// -computed public.profiles.approved_purchases_count (see
// supabase/migrations/031_membership_tier_rewards.sql:
// public.recalculate_membership_level() / public.membership_tier_for_count(),
// the authoritative source). This file is a read-only client-side MIRROR of
// that same business rule, used only to render display/progress hints - it
// never computes or sends an authoritative level/count/rate anywhere; the
// database's profiles.membership_level value is always what's actually
// displayed as the level itself, and the database is always what actually
// decides how many points any given invoice earns (see
// award_purchase_points() in that same migration).
//
// STAGE 32: replaces the old 4-tier, 12-invoice ladder (BRONZE/SILVER/GOLD/
// TITANIUM at 0/12/24/36) with the final 5-tier, 15-invoice ladder. DIAMOND
// is the current maximum - no level exists above it.
export const MEMBERSHIP_LEVELS = ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND'];

// Each level's starting threshold (inclusive), in approved-report count.
export const MEMBERSHIP_LEVEL_THRESHOLDS = {
  BRONZE: 0,
  SILVER: 15,
  GOLD: 30,
  PLATINUM: 45,
  DIAMOND: 60,
};

// Reward rate (fraction of an eligible ₪ amount awarded as points) per
// tier - display-only mirror of public.membership_tier_reward_rate() in
// 031_membership_tier_rewards.sql. Preserves the existing project
// convention that 10 points = ₪1 of reward value, so e.g. BRONZE's 0.20
// means ₪1,000 eligible -> 200 points -> ₪20 of reward value. Used only for
// showing the customer what rate they're at / what the NEXT tier pays
// (e.g. the level-up celebration's "מעכשיו כל ₪1,000 מזכים אותך ב-₪25") -
// never used to compute an actual points award anywhere in this app; that
// always happens server-side only.
export const MEMBERSHIP_LEVEL_REWARD_RATE = {
  BRONZE: 0.2,
  SILVER: 0.25,
  GOLD: 0.3,
  PLATINUM: 0.35,
  DIAMOND: 0.4,
};

// The reward VALUE, in real ₪, per ₪1,000 of eligible purchases at a given
// tier - e.g. 20 for BRONZE, 25 for SILVER. Purely a display-formatting
// helper over MEMBERSHIP_LEVEL_REWARD_RATE above (rate * 1000 / 10, i.e.
// rate * 100) - never a second source of truth for the rate itself.
export function getMembershipLevelRewardPer1000(level) {
  const rate = MEMBERSHIP_LEVEL_REWARD_RATE[level];
  return Number.isFinite(rate) ? Math.round(rate * 100) : null;
}

// STAGE 32: given a qualifying-invoice count, returns the reward rate that
// count's tier pays - used by AdminReportDetailScreen.js to preview
// "how many points will this invoice earn" BEFORE finalize, using the
// customer's CURRENT (i.e., pre-this-invoice, for a still-reviewable
// report) approved_purchases_count. Display/UX only, exactly like
// getFinalizeBlockingReason()'s own existing client-side mirror of the
// server's validation rules - the actual award always happens server-side
// in public.award_purchase_points(), which independently recomputes its
// own pre-finalization count and never trusts this or any other
// client-supplied value.
export function getMembershipLevelRewardRate(approvedCount) {
  const { level } = getMembershipLevelInfo(approvedCount);
  return MEMBERSHIP_LEVEL_REWARD_RATE[level] ?? MEMBERSHIP_LEVEL_REWARD_RATE.BRONZE;
}

// Given a real approved_purchases_count, returns which level it belongs to
// and how far into the current bracket it is. DIAMOND has no next level -
// nextLevel/progressPercent/remainingToNext are all null in that case,
// never invented or shown as progress toward a nonexistent sixth tier.
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
