// The CoCo calculation in isolation: weights, STRICT threshold, and the
// account-age cool-down (a day-old account can't be Social: Trusted no
// matter the score).
import test from 'node:test';
import assert from 'node:assert/strict';
import { cocoScore } from '../src/lib/cocoScore.js';
import { config } from '../src/config.js';

const DAY = 24 * 60 * 60 * 1000;
const oldAccount = new Date(Date.now() - (config.cocoTrustMinAgeDays + 1) * DAY);
const freshAccount = new Date(Date.now() - 1 * DAY);

test('score weights: verified x1 + trusted x3', () => {
  assert.equal(cocoScore({ verifiedBy: 4, trustedBy: 2 }, oldAccount).score, 4 + 6);
  assert.equal(cocoScore({}, oldAccount).score, 0);
});

test('threshold is strict (> not >=) and needs an old enough account', () => {
  const at = { verifiedBy: 0, trustedBy: config.cocoTrustThreshold / 3 };
  const above = { verifiedBy: 0, trustedBy: (config.cocoTrustThreshold + 3) / 3 };
  assert.equal(cocoScore(at, oldAccount).trusted, false, 'exactly at threshold: not trusted');
  // trustedBy such that score = threshold + 3 (strictly above)
  assert.equal(cocoScore(above, oldAccount).trusted, true);
});

test('young accounts never qualify, whatever the score', () => {
  const lots = { verifiedBy: 0, trustedBy: 100 };
  const res = cocoScore(lots, freshAccount);
  assert.ok(res.score > config.cocoTrustThreshold);
  assert.equal(res.trusted, false, 'Sybil cool-down: age gate wins');
});

test('one lone voucher never makes a profile Trusted, whatever the score', () => {
  // 11 verified + 1 trusted => score 14 > threshold, old account… still not
  // trusted: distinct TRUSTED vouchers are below COCO_TRUST_MIN_VOUCHERS
  const res = cocoScore({ verifiedBy: 11, trustedBy: 1 }, oldAccount);
  assert.ok(res.score > config.cocoTrustThreshold);
  assert.equal(res.trusted, false, 'lone vouch is not a network');
  // two trusted vouchers clear it
  assert.equal(cocoScore({ verifiedBy: 11, trustedBy: 2 }, oldAccount).trusted, true);
});

test('clock is injectable for deterministic age checks', () => {
  const created = Date.now() - 10 * DAY;
  assert.equal(cocoScore({ verifiedBy: 0, trustedBy: 100 }, created, Date.now()).trusted, false);
  assert.equal(
    cocoScore({ verifiedBy: 0, trustedBy: 100 }, created, created + (config.cocoTrustMinAgeDays + 1) * DAY).trusted,
    true,
  );
});
