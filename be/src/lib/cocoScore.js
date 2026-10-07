// CoCo social-score calculation — the SINGLE place the number and the
// "Social: Trusted/Untrusted" verdict are derived. See docs/COCO_SCORE.md.
//
// v1: score = verifiedBy × 1 + trustedBy × 3.
// Trusted requires ALL of: score strictly above the threshold, at least
// cocoTrustMinVouchers DISTINCT trusted vouches (one person's word alone —
// even genuine — is not a network), and an account older than the minimum
// age (Sybil cool-down). All knobs are env config.
import { config } from '../config.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {{verifiedBy?: number, trustedBy?: number}} buckets exclusive vouch counts
 * @param {Date|string|number} accountCreatedAt
 * @param {number} [now] injectable clock for tests
 */
export function cocoScore(buckets, accountCreatedAt, now = Date.now()) {
  const verifiedBy = Number(buckets?.verifiedBy) || 0;
  const trustedBy = Number(buckets?.trustedBy) || 0;
  const score = verifiedBy * 1 + trustedBy * 3;
  const ageMs = now - new Date(accountCreatedAt).getTime();
  const oldEnough = ageMs > config.cocoTrustMinAgeDays * DAY_MS;
  const enoughVouchers = trustedBy >= (config.cocoTrustMinVouchers ?? 2);
  return {
    score,
    trusted: score > config.cocoTrustThreshold && oldEnough && enoughVouchers,
  };
}
