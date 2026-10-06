import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../src/crypto.js';
import { deriveWrapKey, passkeyAvailable } from '../src/passkey.js';
import { b64uEncode, utf8 } from '../src/encoding.js';

// Node has no WebAuthn — passkeyAvailable() must be false (the SDK then
// keeps the legacy handle path and browser flows are unaffected) and the
// pure-crypto building blocks of the sealing scheme must still work.

test('passkey: feature detection is false without WebAuthn', () => {
  assert.equal(passkeyAvailable(), false);
});

test('crypto: extractable generation + pkcs8 roundtrip preserves keys', async () => {
  const kp = await c.generateIdentityKeyPair(true);
  assert.equal(kp.privateKey.extractable, true);
  const pkcs8 = await c.exportPkcs8b64u(kp.privateKey);

  const imported = await c.importEd25519PrivatePkcs8(pkcs8);
  assert.equal(imported.extractable, false, 're-imported non-extractable');

  // Ed25519 signatures are deterministic: same key => identical signature.
  assert.equal(await c.sign(imported, 'hello'), await c.sign(kp.privateKey, 'hello'));
});

test('crypto: x25519 pkcs8 roundtrip derives the same shared bits', async () => {
  const pair = await c.generateX25519KeyPair(true);
  const pkcs8 = await c.exportPkcs8b64u(pair.privateKey);
  const imported = await c.importX25519PrivatePkcs8(pkcs8);

  // Peer side: generate a second pair, export raw pub, derive both ways.
  const peer = await c.generateX25519KeyPair();
  const peerPub = await c.exportRawX25519(peer.publicKey);
  const info = 'cocono-conv-v1|test';
  const k1 = await c.deriveConversationKey(imported, peerPub, info);
  const k2 = await c.deriveConversationKey(pair.privateKey, peerPub, info);
  const probe = utf8('probe');
  const iv = new Uint8Array(12).fill(7);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k1, probe);
  const back = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k2, new Uint8Array(ct));
  assert.equal(new TextDecoder().decode(back), 'probe');
});

test('passkey: wrap key is deterministic from PRF secrets', async () => {
  const secrets = {
    first: crypto.getRandomValues(new Uint8Array(32)),
    second: crypto.getRandomValues(new Uint8Array(32)),
  };
  const k1 = await deriveWrapKey(secrets);
  const k2 = await deriveWrapKey(secrets);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k1, utf8('identity-bytes'));
  const back = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k2, new Uint8Array(ct));
  assert.equal(new TextDecoder().decode(back), 'identity-bytes');

  // Different secrets => different key => decrypt fails (auth-tag).
  const other = await deriveWrapKey({ ...secrets, first: crypto.getRandomValues(new Uint8Array(32)) });
  await assert.rejects(() => crypto.subtle.decrypt({ name: 'AES-GCM', iv }, other, new Uint8Array(ct)));
});

// --- local seal (format 4): the iOS-without-PRF path -----------------------

import { localSeal, localUnseal } from '../src/localseal.js';

test('localseal: seal/unseal roundtrip yields equivalent non-extractable handles', async () => {
  const keyPair = await c.generateIdentityKeyPair(true);
  const xPair = await c.generateX25519KeyPair(true);
  const aesRaw = await c.exportRawAesKey(await c.generateAesKey());
  const pubRaw = await c.exportRawPublicKey(keyPair.publicKey);
  const device = { keyPair, xPair, aesRaw, pubRaw, deviceId: 'device-000001' };

  const { bundle, runtime } = await localSeal('mike1', device);
  assert.equal(bundle.format, 4);
  assert.equal(runtime.priv.extractable, false, 'runtime handle non-extractable');
  assert.ok(bundle.wrapped.iv && bundle.wrapped.ct);
  assert.ok(!JSON.stringify(bundle).includes('MC4EE'), 'no plaintext pkcs8 header in stored form');

  const record = { ...bundle, username: 'mike1', deviceId: device.deviceId, pubRaw };
  const back = await localUnseal(record);
  // Ed25519 signatures are deterministic: same key material => same signature.
  assert.equal(await c.sign(back.priv, 'probe'), await c.sign(keyPair.privateKey, 'probe'));

  // Wrong identifiers => wrong wrap key => auth-tag failure (no silent garbage).
  await assert.rejects(() => localUnseal({ ...record, username: 'someone-else' }));
});

test('storage: multi-account list / use / remove', async () => {
  const s = new (await import('../src/storage.js')).MemoryStorage();
  await s.saveIdentity({ username: 'alice', deviceId: 'd1' });
  await s.saveIdentity({ username: 'bob', deviceId: 'd2' });

  const list = await s.listAccounts();
  assert.deepEqual(list.map((a) => a.username).sort(), ['alice', 'bob']);
  assert.equal(list.find((a) => a.current).username, 'bob', 'last saved is active');

  await s.useAccount('alice');
  assert.equal((await s.loadIdentity()).deviceId, 'd1');

  await s.removeAccount('alice');
  assert.equal((await s.loadIdentity()).deviceId, 'd2', 'pointer re-pointed to a survivor');
  await s.removeAccount('bob');
  assert.equal(await s.loadIdentity(), null);
  assert.deepEqual(await s.listAccounts(), []);
});
