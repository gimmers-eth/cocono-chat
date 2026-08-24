import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { b64uDecode, b64uEncode } from '../src/lib/b64u.js';
import { canonical } from '../src/lib/canon.js';
import { importRawPublicKey, verifySignature } from '../src/lib/ed25519.js';
import { signJwt, verifyJwt } from '../src/lib/jwt.js';
import {
  DEVICE_ID_RE,
  isValidDeviceId,
  isValidUsername,
  isReserved,
} from '../src/lib/username.js';

test('canonical sorts object keys and is stable', () => {
  assert.equal(canonical({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonical({ u: 'x', p: 'y', a: 'z' }), '{"a":"z","p":"y","u":"x"}');
  assert.equal(canonical({ n: { d: 1, c: [3, 2] } }), '{"n":{"c":[3,2],"d":1}}');
  assert.equal(canonical('s'), '"s"');
  assert.equal(canonical(null), 'null');
});

test('canonical output matches regardless of insertion order', () => {
  assert.equal(canonical({ a: 1, d: 2, p: 3, u: 4 }), canonical({ u: 4, p: 3, d: 2, a: 1 }));
});

test('b64u roundtrip', () => {
  const buf = Buffer.from([0, 1, 2, 250, 251, 252]);
  assert.deepEqual(b64uDecode(b64uEncode(buf)), buf);
  assert.equal(b64uEncode(Buffer.from([251, 255])), '-_8');
});

test('b64uDecode rejects invalid input', () => {
  assert.equal(b64uDecode(''), null);
  assert.equal(b64uDecode('abc$'), null);
  assert.equal(b64uDecode(123), null);
});

test('jwt sign/verify roundtrip', () => {
  const token = signJwt({ sub: 'alice', d: 'dev-1' }, 'secret', 60);
  const payload = verifyJwt(token, 'secret');
  assert.equal(payload.sub, 'alice');
  assert.equal(payload.d, 'dev-1');
  assert.ok(payload.exp > payload.iat);
});

test('jwt rejects wrong secret, tampering and expiry', () => {
  const token = signJwt({ sub: 'alice' }, 'secret', 60);
  assert.equal(verifyJwt(token, 'other'), null);

  const [h, body] = token.split('.');
  const forgedBody = b64uEncode(JSON.stringify({ sub: 'mallory', iat: 1, exp: 9999999999 }));
  assert.equal(verifyJwt(`${h}.${forgedBody}.${token.split('.')[2]}`, 'secret'), null);

  assert.equal(verifyJwt(signJwt({ sub: 'x' }, 'secret', -10), 'secret'), null);
  assert.equal(verifyJwt('garbage', 'secret'), null);
  assert.equal(verifyJwt(null, 'secret'), null);
});

test('username validation', () => {
  assert.ok(isValidUsername('alice'));
  assert.ok(isValidUsername('bob_1-x'));
  assert.ok(!isValidUsername('abcd')); // too short
  assert.ok(!isValidUsername('has space'));
  assert.ok(!isValidUsername('punct!'));
  assert.ok(!isValidUsername(''));
  assert.ok(!isValidUsername(undefined));
});

test('reserved usernames are case-insensitive', () => {
  assert.ok(isReserved('Server', ['server', 'admin']));
  assert.ok(!isReserved('alice', ['server', 'admin']));
});

test('device id validation', () => {
  assert.ok(isValidDeviceId('abc-def_123'));
  assert.ok(!isValidDeviceId('short'));
  assert.ok(!isValidDeviceId('bad chars!!'));
  assert.ok(DEVICE_ID_RE.test('01234567-89ab-cdef-0123-456789abcdef')); // UUID
});

test('ed25519 import and verify', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const rawB64u = b64uEncode(spki.subarray(spki.length - 32));

  const key = importRawPublicKey(rawB64u);
  assert.ok(key);

  const data = Buffer.from('hello');
  const sig = b64uEncode(sign(null, data, privateKey));
  assert.ok(verifySignature(key, data, sig));
  assert.ok(!verifySignature(key, Buffer.from('hellp'), sig));
});

test('ed25519 import rejects bad input', () => {
  assert.equal(importRawPublicKey('nonsense'), null);
  assert.equal(importRawPublicKey(b64uEncode(Buffer.alloc(31))), null);
});
