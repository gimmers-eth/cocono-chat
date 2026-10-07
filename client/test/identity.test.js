// Safety numbers: pure functions (WebCrypto + atob exist in Node too), so
// the app module is unit-testable without a browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import { safetyNumber, safetyNumberShort } from '../app/js/identity.js';
import { b64uEncode } from '../../be/src/lib/b64u.js';

const keyOf = (seed) => {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (seed * 31 + i * 7) % 256;
  return b64uEncode(bytes);
};

test('safety number: deterministic 8 groups of 4 hex chars', async () => {
  const k = keyOf(1);
  const a = await safetyNumber(k);
  const b = await safetyNumber(k);
  assert.equal(a, b, 'same key -> same number');
  const groups = a.split(' ');
  assert.equal(groups.length, 8);
  for (const g of groups) assert.match(g, /^[0-9A-F]{4}$/);
});

test('safety number: different keys -> different numbers', async () => {
  const a = await safetyNumber(keyOf(1));
  const b = await safetyNumber(keyOf(2));
  assert.notEqual(a, b);
});

test('safety number: known vector (all-zero key)', async () => {
  const zero = b64uEncode(new Uint8Array(32));
  // SHA-256 of 32 zero bytes, first 16 bytes as hex — fixed expectations
  // pin the format (any change here is a UX break for returning users)
  assert.equal(await safetyNumber(zero), '6668 7AAD F862 BD77 6C8F C18B 8E9F 8E20');
});

test('safetyNumberShort: first…last group', async () => {
  const full = await safetyNumber(keyOf(3));
  const short = safetyNumberShort(full);
  assert.match(short, /^[0-9A-F]{4}…[0-9A-F]{4}$/);
});
