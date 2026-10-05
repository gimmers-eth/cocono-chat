// SDK unit tests: no server needed. These pin down the wire-format contracts
// (canonical JSON, b64u, Ed25519 signatures, envelope HMAC) by validating the
// SDK output against the BACKEND's own verification code, plus tests for the
// event emitter, logger gating, storage adapters and REST plumbing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { canonical as beCanonical } from '@cocono/be/src/lib/canon.js';
import { b64uEncode as beB64u, b64uDecode as beB64uDecode } from '@cocono/be/src/lib/b64u.js';
import { importRawPublicKey, verifySignature } from '@cocono/be/src/lib/ed25519.js';
import { verifyEnvelope } from '@cocono/be/src/routes/ws-routes/envelope.js';

import { canonical, b64uEncode, b64uDecode, utf8, nowEpoch } from '../src/encoding.js';
import * as c from '../src/crypto.js';
import { Emitter } from '../src/emitter.js';
import { createLogger, LOG_PREFIX } from '../src/logger.js';
import { MemoryStorage } from '../src/storage.js';
import { Api } from '../src/api.js';
import { CoconoApiError } from '../src/errors.js';

// ---------- encoding: parity with the backend ----------

test('canonical matches the BE implementation on nested input', () => {
  const values = [
    { b: 1, a: { z: [3, { y: 2, x: 1 }], m: null }, c: 'str' },
    { z: 1, a: 2, M: { nested: { deep: { deeper: [1, 'two', null, true] } } } },
    ['mixed', { b: 2, a: 1 }, 42],
    'plain',
    17,
    null,
  ];
  for (const v of values) assert.equal(canonical(v), beCanonical(v));
});

test('canonical is insertion-order independent', () => {
  assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }));
});

test('b64u roundtrip and parity with the BE codec', () => {
  for (let i = 0; i < 20; i++) {
    const bytes = randomBytes(1 + Math.floor(Math.random() * 90));
    const mine = b64uEncode(bytes);
    assert.equal(mine, beB64u(bytes));
    assert.deepEqual([...b64uDecode(mine)], [...bytes]);
    assert.deepEqual([...beB64uDecode(mine)], [...bytes]);
  }
});

// ---------- crypto ----------

test('Ed25519 signatures produced by the SDK verify with the BE validator', async () => {
  const kp = await c.generateIdentityKeyPair();
  const pubRaw = await c.exportRawPublicKey(kp.publicKey);
  const raw = await crypto.subtle.exportKey('raw', kp.publicKey);
  assert.equal(raw.byteLength, 32);
  const msg = canonical({ a: 'x', d: 'y', p: pubRaw, t: nowEpoch(), u: 'someuser', z: 'k' });
  const s = await c.sign(kp.privateKey, msg);
  const pub = importRawPublicKey(pubRaw);
  assert.ok(pub, 'BE must be able to import our public key');
  assert.ok(verifySignature(pub, Buffer.from(msg, 'utf8'), s));
  assert.ok(!verifySignature(pub, Buffer.from(msg + '!', 'utf8'), s), 'tampered message must not verify');
});

test('X25519 conversation keys are symmetric and ciphertext roundtrips', async () => {
  const a = await c.generateX25519KeyPair();
  const b = await c.generateX25519KeyPair();
  const aPub = await c.exportRawX25519(a.publicKey);
  const bPub = await c.exportRawX25519(b.publicKey);
  const info = c.pairInfo('alice', 'dev-a', 'bobby', 'dev-b');
  const keyAB = await c.deriveConversationKey(a.privateKey, bPub, info);
  const keyBA = await c.deriveConversationKey(b.privateKey, aPub, info);
  const d = await c.encryptForConversation(keyAB, 'secret text');
  assert.equal(await c.decryptFromConversation(keyBA, d), 'secret text');
});

test('pairInfo is deterministic regardless of argument order', () => {
  const one = c.pairInfo('alice', 'd1', 'bobby', 'd2');
  const two = c.pairInfo('bobby', 'd2', 'alice', 'd1');
  assert.equal(one, two);
  assert.match(one, /^cocono-conv-v1\|/);
});

test('HMAC keyed with the transport MAC verifies as BE envelope HMAC', async () => {
  const aes = await c.generateAesKey();
  const aesRaw = await c.exportRawAesKey(aes);
  const { aesMac } = await c.importAesKeys(aesRaw);
  const m = { d: 'AAAA', u: 'bobby', dv: 'dev-1', f: 'alice', fd: 'dev-0', cid: 'cid-12345678', t: nowEpoch() };
  const h = await c.hmac(aesMac, canonical(m));
  // Recompute the way the server does (node crypto, raw key bytes).
  const { createHmac } = await import('node:crypto');
  const expected = createHmac('sha256', beB64uDecode(aesRaw)).update(beCanonical(m)).digest('base64url');
  assert.equal(h, expected);
});

// ---------- envelope: BE must accept what the SDK builds ----------

test('BE verifyEnvelope accepts a complete SDK-built envelope', async () => {
  const kp = await c.generateIdentityKeyPair();
  const pub = await c.exportRawPublicKey(kp.publicKey);
  const aes = await c.generateAesKey();
  const aesRaw = await c.exportRawAesKey(aes);
  const { aesMac } = await c.importAesKeys(aesRaw);
  const deviceId = c.newDeviceId();

  const m = { d: 'AAAA', u: 'bobby', dv: c.newDeviceId(), f: 'alice', fd: deviceId, cid: 'cid-unit-test', t: nowEpoch() };
  m.h = await c.hmac(aesMac, canonical(m));

  const senderDevice = { id: deviceId, pub, aes: aesRaw };
  const config = { signedPayloadMaxAgeSec: 300 };
  assert.equal(verifyEnvelope({ m }, senderDevice, config), null, 'envelope must pass BE validation');

  // Tampered HMAC must be rejected.
  const tampered = structuredLike(m, { h: m.h.slice(0, -2) + 'xx' });
  assert.equal(verifyEnvelope({ m: tampered }, senderDevice, config), 'bad_hmac');

  // Stale timestamps must be rejected.
  const stale = structuredLike(m, { t: nowEpoch() - 10_000 });
  assert.equal(verifyEnvelope({ m: stale }, senderDevice, config), 'stale_payload');
});

function structuredLike(obj, patch) {
  const { h: _omit, ...rest } = obj;
  return { ...rest, ...patch };
}

// ---------- emitter ----------

test('emitter: on/off/once and listener isolation', () => {
  const e = new Emitter();
  let hits = 0;
  const off = e.on('x', () => {
    hits += 1;
    throw new Error('bad listener must not break emit');
  });
  e.on('x', () => {
    hits += 100;
  });
  e.emit('x');
  assert.equal(hits, 101);
  off();
  e.emit('x');
  assert.equal(hits, 201);
  const once = new Emitter();
  let n = 0;
  once.once('y', () => (n += 1));
  once.emit('y');
  once.emit('y');
  assert.equal(n, 1);
});

// ---------- logger gating ----------

test('logging off is silent, logging on emits tagged lines, custom sink works', () => {
  const original = console.log;
  let calls = 0;
  console.log = () => {
    calls += 1;
  };
  try {
    createLogger(false).info('nothing');
    assert.equal(calls, 0);
    createLogger(true).info('something');
    assert.equal(calls, 1);
  } finally {
    console.log = original;
  }
  const seen = [];
  const log = createLogger((level, ...args) => seen.push([level, ...args]));
  log.debug('d');
  log.warn('w', 1);
  assert.deepEqual(seen, [['debug', 'd'], ['warn', 'w', 1]]);
  assert.ok(LOG_PREFIX.includes('cocono'));
});

// ---------- storage ----------

test('MemoryStorage save/load/clear', async () => {
  const s = new MemoryStorage();
  assert.equal(await s.loadIdentity(), null);
  await s.saveIdentity({ username: 'u' });
  assert.deepEqual(await s.loadIdentity(), { username: 'u' });
  await s.clearIdentity();
  assert.equal(await s.loadIdentity(), null);
});

// ---------- REST plumbing ----------

test('Api maps non-2xx to CoconoApiError with server error code', async () => {
  const api = new Api({
    baseUrl: 'http://test.local',
    logger: createLogger(false),
    fetchImpl: async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: 'username_taken', message: 'taken' }),
    }),
  });
  await assert.rejects(api.signup({}), (err) => {
    assert.ok(err instanceof CoconoApiError);
    assert.equal(err.status, 409);
    assert.equal(err.code, 'username_taken');
    return true;
  });
});

test('Api derives ws:// / wss:// URLs from baseUrl', () => {
  const logger = createLogger(false);
  assert.equal(new Api({ baseUrl: 'http://127.0.0.1:3000', logger }).wsUrl(), 'ws://127.0.0.1:3000');
  assert.equal(new Api({ baseUrl: 'https://example.com/', logger }).wsUrl(), 'wss://example.com');
  assert.throws(() => new Api({ baseUrl: '', logger }).wsUrl(), /absolute baseUrl/);
});
