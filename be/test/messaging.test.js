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
};

// Boots the real server (WS needs an actual listener, app.inject won't do).
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

  const { n } = (await ctx.app.inject({ method: 'POST', url: '/api/auth/challenge', payload: { u, d } })).json();
  const ve = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/verify',
    payload: { u, d, n, s: client.signBytes(Buffer.from(n, 'utf8')) },
  });
  return { u, ul: u.toLowerCase(), d, a, token: ve.json().token, client };
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
    async function waitFor(pred, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = received.find(pred);
        if (found) return found;
        if (Date.now() > deadline) throw new Error('timeout waiting for WS message');
        await new Promise((res) => {
          const l = () => {
            listeners.delete(l);
            res();
          };
          listeners.add(l);
          setTimeout(l, 250);
        });
      }
    }
    ws.on('open', () => resolve({ ws, received, waitFor, send: (obj) => ws.send(JSON.stringify(obj)) }));
    ws.on('error', reject);
  });
}

// --- E2EE mirror of the FE: pairwise conversation keys via ECDH + HKDF ---
// info string: 'cocono-conv-v1|' + sorted 'ul:deviceId' pair (deterministic
// on both sides; the FE must produce the identical string).
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
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(12, buf.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', convKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// Builds a valid envelope exactly as the FE does.
function buildEnvelope(sender, recipient, recipientDevice, cid, tamper = null) {
  const t = nowEpoch();
  const info = pairInfo(sender.ul, sender.d, recipient.ul, recipientDevice);
  const convKey = deriveConvKey(sender.client.xPriv, recipient.client.x, info);
  const d = e2eeEncrypt(convKey, `hello-${cid}`);
  const m = { d, u: recipient.u, dv: recipientDevice, f: sender.u, fd: sender.d, cid, t };
  const h = createHmac('sha256', b64uDecode(sender.a)).update(canonical(m)).digest('base64url');
  const env = { m: { ...m, h: tamper === 'hmac' ? h.slice(0, h.length - 2) + 'xx' : h } };
  return { env, convKey };
}

test('messaging: online delivery with E2EE + pulled ack + delivered receipt', async () => {
  const ctx = await setupLive();
  try {
    const alice = await createUser(ctx, makeClient(), 'alice');
    const bob = await createUser(ctx, makeClient(), 'bobby');

    const wsA = await connectWs(ctx.port, alice.token);
    const wsB = await connectWs(ctx.port, bob.token);
    await wsA.waitFor((m) => m.type === 'hello');
    await wsB.waitFor((m) => m.type === 'hello');

    const cid = 'cid-0001';
    const { env, convKey } = buildEnvelope(alice, bob, bob.d, cid);
    wsA.send({ type: 'msg', msg: env });

    // Sender gets an ack.
    const ack = await wsA.waitFor((m) => m.type === 'ack' && m.cid === cid);
    assert.equal(ack.ok, true, JSON.stringify(ack));

    // Recipient receives the message; ciphertext decrypts with the pairwise key.
    const incoming = await wsB.waitFor((m) => m.type === 'msg');
    assert.equal(incoming.env.m.f, 'alice');
    assert.equal(incoming.env.m.cid, cid);
    assert.equal(e2eeDecrypt(convKey, incoming.env.m.d), `hello-${cid}`);

    // Bob confirms the pull -> message deleted server-side...
    wsB.send({ type: 'pulled', ids: [incoming.id] });
    // ...and Alice's device gets a delivery receipt.
    const delivered = await wsA.waitFor((m) => m.type === 'delivered' && m.cid === cid);
    assert.equal(delivered.to, 'bobby');

    const left = await ctx.mongo.db.collection('messages').countDocuments({ mid: incoming.id });
    assert.equal(left, 0);

    wsA.ws.close();
    wsB.ws.close();
  } finally {
    await ctx.teardown();
  }
});

test('messaging: offline recipient gets store-and-forward on connect', async () => {
  const ctx = await setupLive();
  try {
    const alice = await createUser(ctx, makeClient(), 'alice');
    const bob = await createUser(ctx, makeClient(), 'bobby');

    const wsA = await connectWs(ctx.port, alice.token);
    await wsA.waitFor((m) => m.type === 'hello');

    // Bob is OFFLINE: message is persisted.
    const cid = 'cid-off-1';
    const { env } = buildEnvelope(alice, bob, bob.d, cid);
    wsA.send({ type: 'msg', msg: env });
    const ack = await wsA.waitFor((m) => m.type === 'ack' && m.cid === cid);
    assert.equal(ack.ok, true);

    const queued = await ctx.mongo.db.collection('messages').countDocuments({ 'to.ul': 'bobby' });
    assert.equal(queued, 1);

    // Bob connects later and gets the pending message.
    const wsB = await connectWs(ctx.port, bob.token);
    const incoming = await wsB.waitFor((m) => m.type === 'msg' && m.env.m.cid === cid);
    assert.equal(incoming.env.m.f, 'alice');

    wsB.send({ type: 'pulled', ids: [incoming.id] });
    await wsA.waitFor((m) => m.type === 'delivered' && m.cid === cid);

    const left = await ctx.mongo.db.collection('messages').countDocuments({ 'to.ul': 'bobby' });
    assert.equal(left, 0);

    wsA.ws.close();
    wsB.ws.close();
  } finally {
    await ctx.teardown();
  }
});

test('messaging: rejects bad HMAC, sender mismatch, unknown recipient', async () => {
  const ctx = await setupLive();
  try {
    const alice = await createUser(ctx, makeClient(), 'alice');
    const bob = await createUser(ctx, makeClient(), 'bobby');
    const wsA = await connectWs(ctx.port, alice.token);
    await wsA.waitFor((m) => m.type === 'hello');

    // Tampered HMAC.
    const tampered = buildEnvelope(alice, bob, bob.d, 'cid-bad-h', 'hmac');
    wsA.send({ type: 'msg', msg: tampered.env });
    const badH = await wsA.waitFor((m) => m.type === 'ack' && m.cid === 'cid-bad-h');
    assert.equal(badH.ok, false);
    assert.equal(badH.error, 'bad_hmac');

    // Sender mismatch: envelope claims mallory but the socket is alice's.
    const spoofed = buildEnvelope(alice, bob, bob.d, 'cid-spoof');
    spoofed.env.m.f = 'mallory';
    wsA.send({ type: 'msg', msg: spoofed.env });
    const spoofAck = await wsA.waitFor((m) => m.type === 'ack' && m.cid === 'cid-spoof');
    assert.equal(spoofAck.ok, false);
    assert.equal(spoofAck.error, 'sender_mismatch');

    // Unknown recipient: valid HMAC, but addressed to a user that doesn't
    // exist (the server checks integrity before recipient lookup).
    const cidGhost = 'cid-ghost';
    const mGhost = {
      d: 'AAAA',
      u: 'nonexistent-user',
      dv: 'device-ghost-99',
      f: alice.u,
      fd: alice.d,
      cid: cidGhost,
      t: nowEpoch(),
    };
    mGhost.h = createHmac('sha256', b64uDecode(alice.a)).update(canonical(mGhost)).digest('base64url');
    wsA.send({ type: 'msg', msg: { m: mGhost } });
    const ghostAck = await wsA.waitFor((m) => m.type === 'ack' && m.cid === cidGhost);
    assert.equal(ghostAck.ok, false);
    assert.equal(ghostAck.error, 'unknown_recipient');

    wsA.ws.close();
  } finally {
    await ctx.teardown();
  }
});

test('messaging: idempotent retries are not duplicated', async () => {
  const ctx = await setupLive();
  try {
    const alice = await createUser(ctx, makeClient(), 'alice');
    const bob = await createUser(ctx, makeClient(), 'bobby');
    const wsA = await connectWs(ctx.port, alice.token);
    await wsA.waitFor((m) => m.type === 'hello');

    const cid = 'cid-retry1';
    const { env } = buildEnvelope(alice, bob, bob.d, cid);
    wsA.send({ type: 'msg', msg: env });
    wsA.send({ type: 'msg', msg: env }); // retry of the same message

    const ack1 = await wsA.waitFor((m) => m.type === 'ack' && m.cid === cid);
    assert.equal(ack1.ok, true);
    const ack2 = await wsA.waitFor((m) => m !== ack1 && m.type === 'ack' && m.cid === cid);
    assert.equal(ack2.ok, true);

    const count = await ctx.mongo.db.collection('messages').countDocuments({ cid, 'from.ul': 'alice' });
    assert.equal(count, 1);

    wsA.ws.close();
  } finally {
    await ctx.teardown();
  }
});

test('ws: invalid token is closed with 4401', async () => {
  const ctx = await setupLive();
  try {
    await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws?token=garbage`);
      let closeCode = null;
      ws.on('close', (code) => {
        closeCode = code;
        resolve();
      });
      ws.on('error', () => {});
      setTimeout(() => {
        assert.equal(closeCode, 4401);
        resolve();
      }, 3000);
    });
  } finally {
    await ctx.teardown();
  }
});

test('keys endpoint: returns device keys, guards auth and existence', async () => {
  const ctx = await setupLive();
  try {
    const alice = await createUser(ctx, makeClient(), 'alice');
    const bob = await createUser(ctx, makeClient(), 'bobby');

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/users/bobby/keys',
      headers: { authorization: `Bearer ${alice.token}` },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.u, 'bobby');
    assert.equal(body.devices.length, 1);
    assert.equal(body.devices[0].d, bob.d);
    assert.equal(body.devices[0].p, bob.client.p);
    assert.equal(body.devices[0].x, bob.client.x);

    const unknown = await ctx.app.inject({
      method: 'GET',
      url: '/api/users/nobody-here/keys',
      headers: { authorization: `Bearer ${alice.token}` },
    });
    assert.equal(unknown.statusCode, 404);

    const noAuth = await ctx.app.inject({ method: 'GET', url: '/api/users/bobby/keys' });
    assert.equal(noAuth.statusCode, 401);
  } finally {
    await ctx.teardown();
  }
});
