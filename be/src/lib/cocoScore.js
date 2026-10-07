// CoCo social-score calculation — the SINGLE place the number and the
// "Social: Trusted/Untrusted" verdict are derived. See docs/COCO_SCORE.md.
//
// v1: score = verifiedBy × 1 + trustedBy × 3.
// Trusted requires BOTH: score strictly above the threshold AND an account
// older than the minimum age — a fresh account cannot look trustworthy by
// vouch-farming alone (Sybil cool-down). Threshold/age are env config.
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
  return {
    score,
    trusted: score > config.cocoTrustThreshold && oldEnough,
  };
}
