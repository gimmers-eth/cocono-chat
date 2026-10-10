// CoCo social-score calculation — the SINGLE place the number and the
// "Social: Trusted/Untrusted" verdict are derived. See docs/COCO_SCORE.md.
//
// v1: score = verifiedBy × 1 + trustedBy × 3 (+ cocoPremiumBonus for PREMIUM
// subscribers — a flat gift for funding the platform, on top of vouches;
// minus cocoTimeoutPenalty while a staff TIMEOUT runs — lib/moderation.js).
// Trusted requires ALL of: score strictly above the threshold, at least
// cocoTrustMinVouchers DISTINCT trusted vouches (one person's word alone —
// even genuine — is not a network), and an account older than the minimum
// age (Sybil cool-down). All knobs are env config.
import { config } from '../config.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {{verifiedBy?: number, trustedBy?: number, badgePoints?: number, penalty?: number}} buckets — exclusive vouch counts + badge points; `penalty` is the flat subtraction a staff moderation state carries (lib/moderation.js cocoPenalty)
 * @param {Date|string|number} accountCreatedAt
 * @param {number} [now] injectable clock for tests
 */
export function cocoScore(buckets, accountCreatedAt, now = Date.now()) {
  const verifiedBy = Number(buckets?.verifiedBy) || 0;
  const trustedBy = Number(buckets?.trustedBy) || 0;
  // badge points arrive pre-summed from lib/badges.js (premium's +5 is one
  // of those badges — counted once there, never here)
  const badgePoints = Number(buckets?.badgePoints) || 0;
  // staff penalties (a malicious-user timeout costs -1000 CoCo while the
  // clock runs) subtract at the end: a timed-out account is never Trusted
  const penalty = Number(buckets?.penalty) || 0;
  const score = verifiedBy * 1 + trustedBy * 3 + badgePoints - penalty;
  const ageMs = now - new Date(accountCreatedAt).getTime();
  const oldEnough = ageMs > config.cocoTrustMinAgeDays * DAY_MS;
  const enoughVouchers = trustedBy >= (config.cocoTrustMinVouchers ?? 2);
  return {
    score,
    trusted: score > config.cocoTrustThreshold && oldEnough && enoughVouchers,
  };
}
