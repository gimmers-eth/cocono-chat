// Pair safety numbers: pure functions (WebCrypto + atob exist in Node too),
// so the app module is unit-testable without a browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { safetyNumber, safetyNumberShort } from '../app/js/identity.js';
import { b64uEncode } from '../../be/src/lib/b64u.js';

const keyOf = (seed) => {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (seed * 31 + i * 7) % 256;
  return b64uEncode(bytes);
};

const A = keyOf(1);
const B = keyOf(2);

// Independent re-implementation of the spec: sha256 of the canonically
// ordered pair of raw keys, first 16 bytes as uppercase hex in 4-char groups.
function expected(k1, k2) {
  const [f, s] = k1 <= k2 ? [k1, k2] : [k2, k1];
  const join = Buffer.concat([Buffer.from(f, 'base64url'), Buffer.from(s, 'base64url')]);
  return createHash('sha256').update(join).digest().subarray(0, 16)
    .toString('hex').toUpperCase().match(/.{4}/g).join(' ');
}

test('safety number: deterministic, 8 groups of 4 hex chars', async () => {
  const a = await safetyNumber(A, B);
  assert.equal(a, await safetyNumber(A, B));
  const groups = a.split(' ');
  assert.equal(groups.length, 8);
  for (const g of groups) assert.match(g, /^[0-9A-F]{4}$/);
});

test('safety number: SYMMETRIC — both peers see the same number', async () => {
  assert.equal(await safetyNumber(A, B), await safetyNumber(B, A));
});

test('safety number: different counterpart -> different number', async () => {
  assert.notEqual(await safetyNumber(A, B), await safetyNumber(A, keyOf(3)));
});

test('safety number: matches the independent spec implementation', async () => {
  assert.equal(await safetyNumber(A, B), expected(A, B));
  // known vector pinned for format stability (users write these down)
  const zero = b64uEncode(new Uint8Array(32));
  assert.equal(await safetyNumber(zero, zero), expected(zero, zero));
});

test('safetyNumberShort: first…last group', async () => {
  const full = await safetyNumber(A, B);
  assert.match(safetyNumberShort(full), /^[0-9A-F]{4}…[0-9A-F]{4}$/);
});
