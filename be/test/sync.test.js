// Outgoing multi-device sync — server side (see
// docs/features/outgoing-multidevice-sync.md):
//   * sync:1 envelopes are legal ONLY toward the sender's own account and
//     are stored/forwarded like mail (offline own devices catch up);
//   * sync copies never enter the push path and never bump the sent counter;
//   * message pruning: every queued copy gets expireAt = ts +
//     MSG_QUEUE_MAX_SEC at insert (TTL index prunes never-pulled copies);
//     handlePulled overwrites it with the resync retention window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHmac, createCipheriv, createDecipheriv, createPublicKey, diffieHellman, hkdfSync } from 'node:crypto';
import WebSocket from 'ws';
import { setupApp, makeClient, randomAesKey, nowEpoch } from './helpers.js';
import { canonical } from '../src/lib/canon.js';
import { b64uDecode, b64uEncode } from '../src/lib/b64u.js';

const LIMITS = {
  signupIpLimit: 1000,
  challengeIpLimit: 1000,
  verifyAccountLimit: 1000,
  verifyIpLimit: 1000,
  msgAccountLimit: 1000,
  msgIpLimit: 1000,
  userKeysIpLimit: 1000,
  deviceLimitUnverified: 5,
  deviceEnrollIpLimit: 1000,
  deviceApproveAccountLimit: 1000,
  // distinguishable windows so the pruning asserts cannot pass by accident
  msgQueueMaxSec: 3600,        // queue cap: 1 h
  msgRetentionSec: 7200,       // pulled resync window: 2 h
};

async function setupLive(overrides = {}) {
  const ctx = await setupApp({ ...LIMITS, ...overrides });
  await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  return { ...ctx, port: ctx.app.server.address().port };
}

async function createUser(ctx, client, u, d = randomUUID()) {
  const a = randomAesKey();
  const t = nowEpoch();
  const s = client.signSignup({ u, a, d, t });
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/signup',
    payload: { u, p: client.p, x: client.x, a, d, t, s },
  });
  assert.equal(res.statusCode, 201, `signup failed: ${res.body}`);
  return { ...(await login(ctx, client, u, d)), a, client };
}

async function login(ctx, client, u, d) {
  const { n } = (await ctx.app.inject({ method: 'POST', url: '/api/auth/challenge', payload: { u, d } })).json();
  const ve = await ctx.app.inject({
    method: 'POST', url: '/api/auth/verify',
    payload: { u, d, n, s: client.signBytes(Buffer.from(n, 'utf8')) },
  });
  return { u, ul: u.toLowerCase(), d, token: ve.json().token };
}

// Second device for an existing account, via the real enroll+approve flow.
async function addDevice(ctx, main, u) {
  const client = makeClient();
  const d = randomUUID();
  const a = randomAesKey();
  const t = nowEpoch();
  const s = client.signSignup({ u, a, d, t });
  const enrollRes = await ctx.app.inject({
    method: 'POST', url: '/api/devices/enroll',
    payload: { u, p: client.p, x: client.x, a, d, t, s },
  });
  assert.equal(enrollRes.statusCode, 201, `enroll failed: ${enrollRes.body}`);
  const { code } = enrollRes.json();
  const approve = await ctx.app.inject({
    method: 'POST', url: '/api/devices/approve',
    headers: { authorization: `Bearer ${main.token}` },
    payload: { code },
  });
  assert.equal(approve.statusCode, 200, `approve failed: ${approve.body}`);
  return { ...(await login(ctx, client, u, d)), a, client };
}

function connectWs(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    const received = [];
    const listeners = new Set();
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      received.push(msg);
      for (const l of [...listeners]) l();
    });
    async function waitFor(pred, timeoutMs = 10000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = received.find(pred);
        if (found) return found;
        if (Date.now() > deadline) throw new Error('timeout waiting for WS message');
        await new Promise((res) => {
          const l = () => { listeners.delete(l); res(); };
          listeners.add(l);
          setTimeout(l, 250);
        });
      }
    }
    ws.on('open', () => resolve({ ws, received, waitFor, send: (obj) => ws.send(JSON.stringify(obj)) }));
    ws.on('error', reject);
  });
}

// --- E2EE mirror (same as messaging.test.js) ---
function pairInfo(aUl, aDv, bUl, bDv) {
  const parts = [`${aUl}:${aDv}`, `${bUl}:${bDv}`].sort();
  return `cocono-conv-v1|${parts[0]}|${parts[1]}`;
}

function deriveConvKey(myXPriv, peerXPubB64u, info) {
  const peerPub = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: peerXPubB64u }, format: 'jwk' });
  const shared = diffieHellman({ privateKey: myXPriv, publicKey: peerPub });
  return Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from(info), 32));
}

function e2eeEncrypt(convKey, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', convKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return b64uEncode(Buffer.concat([iv, ct, cipher.getAuthTag()]));
}

function e2eeDecrypt(convKey, d) {
  const buf = b64uDecode(d);
  const decipher = createDecipheriv('aes-256-gcm', convKey, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([decipher.update(buf.subarray(12, buf.length - 16)), decipher.final()]).toString('utf8');
}

// Envelope builder: `rec` is { ul, u, dv, x } (lowercase ul for the key
// derivation, display u for the wire, device id + X25519 pub of the target);
// `extraM` carries plaintext tail fields like { sync: 1 }.
function buildEnvelope(sender, rec, cid, plaintext, extraM = {}) {
  const t = nowEpoch();
  const info = pairInfo(sender.ul, sender.d, rec.ul, rec.dv);
  const convKey = deriveConvKey(sender.client.xPriv, rec.x, info);
  const d = e2eeEncrypt(convKey, plaintext);
  const m = { d, u: rec.u, dv: rec.dv, f: sender.u, fd: sender.d, cid, t, ...extraM };
  const h = createHmac('sha256', b64uDecode(sender.a)).update(canonical(m)).digest('base64url');
  return { env: { m: { ...m, h } }, convKey };
}

test('sync: own-device copy is queued, delivered and decryptable; no push, no sent-counter', async () => {
  const ctx = await setupLive();
  try {
    const alice1 = await createUser(ctx, makeClient(), 'alice');
    const alice2 = await addDevice(ctx, alice1, 'alice');
    const bob = await createUser(ctx, makeClient(), 'bobby');

    // Push subscriptions so the push-gate asserts are meaningful: alice's
    // second device and bob both LOOK pushable and are offline for it.
    const fakeSub = { endpoint: 'https://push.invalid/push', keys: { p256dh: 'cHVzaA', auth: 'cHVzaA' } };
    for (const dev of [alice2, bob]) {
      const res = await ctx.app.inject({
        method: 'PUT', url: '/api/devices/push-subscription',
        headers: { authorization: `Bearer ${dev.token}` }, payload: fakeSub,
      });
      assert.equal(res.statusCode, 200, res.body);
    }

    const wsA1 = await connectWs(ctx.port, alice1.token);
    await wsA1.waitFor((m) => m.type === 'hello');

    // 1) The real send to bob (offline) — the push path MUST run: the
    //    coalesce key appears even though the fake endpoint cannot deliver.
    const cidPeer = 'cid-sync-peer1';
    const bobRec = { ul: bob.ul, u: bob.u, dv: bob.d, x: bob.client.x };
    const peerEnv = buildEnvelope(alice1, bobRec, cidPeer, `hello-${cidPeer}`);
    wsA1.send({ type: 'msg', msg: peerEnv.env });
    const peerAck = await wsA1.waitFor((m) => m.type === 'ack' && m.cid === cidPeer);
    assert.equal(peerAck.ok, true, JSON.stringify(peerAck));
    // push is fire-and-forget after the ack — give it a beat. (The coalesce
    // key's sender segment comes from auth.ul, which today's JWT does not
    // carry — scan the prefix instead of rebuilding the exact key.)
    await new Promise((r) => setTimeout(r, 500));
    const pushKeys = await ctx.redis.keys(`pushsent:${bob.ul}:${bob.d}:*`);
    assert.equal(pushKeys.length, 1, 'peer send entered the push path');

    // 2) The sync copy to alice's own second device (offline, pushable).
    const cidSync = 'cid-sync-own01';
    const localId = randomUUID();
    const payload = JSON.stringify({ sync: 1, id: localId, peer: bob.u, text: `hello-${cidPeer}`, ts: Date.now() });
    const syncEnv = buildEnvelope(
      alice1,
      { ul: alice1.ul, u: alice1.u, dv: alice2.d, x: alice2.client.x },
      cidSync, payload, { sync: 1 },
    );
    wsA1.send({ type: 'msg', msg: syncEnv.env });
    const syncAck = await wsA1.waitFor((m) => m.type === 'ack' && m.cid === cidSync);
    assert.equal(syncAck.ok, true, JSON.stringify(syncAck));
    await new Promise((r) => setTimeout(r, 500));

    // NEVER pushed: your own outgoing mirror must not ring your other device.
    const syncPushKeys = await ctx.redis.keys(`pushsent:${alice1.ul}:${alice2.d}:*`);
    assert.equal(syncPushKeys.length, 0, 'sync copy must not push');

    // Sent counter: exactly 1 (the peer message); the sync copy is not a message.
    const counter = await ctx.mongo.db.collection('counters').findOne({ _id: `sent:${alice1.ul}` });
    assert.equal(counter?.n, 1, 'sync copies must not inflate the sent counter');

    // Queued for the offline device; delivered on next connect; the
    // ciphertext decrypts with the own-device pairwise key.
    const wsA2 = await connectWs(ctx.port, alice2.token);
    await wsA2.waitFor((m) => m.type === 'hello');
    const incoming = await wsA2.waitFor((m) => m.type === 'msg' && m.env?.m?.cid === cidSync);
    assert.equal(incoming.env.m.sync, 1);
    assert.equal(incoming.env.m.f, alice1.u);
    assert.equal(e2eeDecrypt(syncEnv.convKey, incoming.env.m.d), payload);

    // The server holds ciphertext only: NEITHER the mirrored text, nor the
    // peer's username, nor the sync-payload JSON appear anywhere in the
    // stored doc — the plaintext exists only under the own-device pairwise
    // key, which the server never sees.
    const storedSync = await ctx.mongo.db.collection('messages').findOne({ mid: incoming.id });
    const storedRaw = JSON.stringify(storedSync);
    for (const secret of [`hello-${cidPeer}`, bob.u, localId]) {
      assert.ok(!storedRaw.includes(secret), `server must never store plaintext fragment: ${secret}`);
    }
    assert.equal(storedSync.env.m.sync, 1, 'only the plaintext routing flag is visible');

    wsA2.send({ type: 'pulled', ids: [incoming.id] });
    // The receipt reaches the sender (the SDK swallows it via #syncCids —
    // server behaviour is unchanged and asserted here).
    const delivered = await wsA1.waitFor((m) => m.type === 'delivered' && m.cid === cidSync);
    assert.equal(delivered.to, alice1.ul);

    wsA1.ws.close();
    wsA2.ws.close();
  } finally {
    await ctx.teardown();
  }
});

test('sync: live own device receives the copy in real time', async () => {
  const ctx = await setupLive();
  try {
    const alice1 = await createUser(ctx, makeClient(), 'alice');
    const alice2 = await addDevice(ctx, alice1, 'alice');

    const wsA1 = await connectWs(ctx.port, alice1.token);
    const wsA2 = await connectWs(ctx.port, alice2.token);
    await wsA1.waitFor((m) => m.type === 'hello');
    await wsA2.waitFor((m) => m.type === 'hello');

    const cid = 'cid-sync-live1';
    const payload = JSON.stringify({ sync: 1, id: randomUUID(), peer: 'bobby', text: 'live mirror', ts: Date.now() });
    const { env } = buildEnvelope(
      alice1,
      { ul: alice1.ul, u: alice1.u, dv: alice2.d, x: alice2.client.x },
      cid, payload, { sync: 1 },
    );
    wsA1.send({ type: 'msg', msg: env });

    const ack = await wsA1.waitFor((m) => m.type === 'ack' && m.cid === cid);
    assert.equal(ack.ok, true, JSON.stringify(ack));
    const incoming = await wsA2.waitFor((m) => m.type === 'msg' && m.env?.m?.cid === cid);
    assert.equal(incoming.env.m.sync, 1);

    wsA1.ws.close();
    wsA2.ws.close();
  } finally {
    await ctx.teardown();
  }
});

test('sync: rejected toward other users and with bad flag values', async () => {
  const ctx = await setupLive();
  try {
    const alice = await createUser(ctx, makeClient(), 'alice');
    const bob = await createUser(ctx, makeClient(), 'bobby');
    const wsA = await connectWs(ctx.port, alice.token);
    await wsA.waitFor((m) => m.type === 'hello');

    // sync:1 toward ANOTHER account is not a delivery channel.
    const cid1 = 'cid-sync-evil1';
    const toBob = buildEnvelope(alice, { ul: bob.ul, u: bob.u, dv: bob.d, x: bob.client.x }, cid1, 'nope', { sync: 1 });
    wsA.send({ type: 'msg', msg: toBob.env });
    const ack1 = await wsA.waitFor((m) => m.type === 'ack' && m.cid === cid1);
    assert.equal(ack1.ok, false);
    assert.equal(ack1.error, 'invalid_envelope');

    // Structural: sync must be exactly 1 when present (HMAC covers it).
    const alice2 = await addDevice(ctx, alice, 'alice');
    const cid2 = 'cid-sync-evil2';
    const badFlag = buildEnvelope(
      alice,
      { ul: alice.ul, u: alice.u, dv: alice2.d, x: alice2.client.x },
      cid2, 'nope', { sync: true },
    );
    wsA.send({ type: 'msg', msg: badFlag.env });
    const ack2 = await wsA.waitFor((m) => m.type === 'ack' && m.cid === cid2);
    assert.equal(ack2.ok, false);
    assert.equal(ack2.error, 'invalid_envelope');

    wsA.ws.close();
  } finally {
    await ctx.teardown();
  }
});

test('pruning: queued copies get expireAt at insert; pulled overwrites with the retention window', async () => {
  const ctx = await setupLive();
  try {
    const alice = await createUser(ctx, makeClient(), 'alice');
    const bob = await createUser(ctx, makeClient(), 'bobby');
    const wsA = await connectWs(ctx.port, alice.token);
    const wsB = await connectWs(ctx.port, bob.token);
    await wsA.waitFor((m) => m.type === 'hello');
    await wsB.waitFor((m) => m.type === 'hello');

    const cid = 'cid-prune-0001';
    const { env } = buildEnvelope(alice, { ul: bob.ul, u: bob.u, dv: bob.d, x: bob.client.x }, cid, `hello-${cid}`);
    const before = Date.now();
    wsA.send({ type: 'msg', msg: env });
    const incoming = await wsB.waitFor((m) => m.type === 'msg' && m.env?.m?.cid === cid);

    const queued = await ctx.mongo.db.collection('messages').findOne({ mid: incoming.id });
    assert.ok(queued.expireAt instanceof Date, 'queue cap stamped at insert');
    const queueAgeSec = (queued.expireAt.getTime() - queued.ts.getTime()) / 1000;
    assert.ok(Math.abs(queueAgeSec - LIMITS.msgQueueMaxSec) < 60, `expireAt ≈ ts + msgQueueMaxSec (got ${queueAgeSec}s)`);

    // Pulling swaps the queue cap for the (longer) resync retention window.
    wsB.send({ type: 'pulled', ids: [incoming.id] });
    await wsA.waitFor((m) => m.type === 'delivered' && m.cid === cid);
    const pulled = await ctx.mongo.db.collection('messages').findOne({ mid: incoming.id });
    assert.ok(pulled.pulledAt instanceof Date);
    const retainSec = (pulled.expireAt.getTime() - pulled.pulledAt.getTime()) / 1000;
    assert.ok(Math.abs(retainSec - LIMITS.msgRetentionSec) < 60, `expireAt ≈ pulledAt + msgRetentionSec (got ${retainSec}s)`);
    assert.ok(pulled.expireAt.getTime() > before, 'pulled window overwrote the queue cap');

    wsA.ws.close();
    wsB.ws.close();
  } finally {
    await ctx.teardown();
  }
});
