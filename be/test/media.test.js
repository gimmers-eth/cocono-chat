// Media blobs (milestone 4) — backend half: REST upload/download/ack for the
// BYTES (they never ride the 64 KB-capped WebSocket), the plaintext `att`
// descriptor in handleSend (the MESSAGE that references a blob keeps riding
// the E2EE store-and-forward path unchanged), and the lifecycle rule that
// decides when a blob dies (req 8: every authorised device has acked, or the
// retention/orphan sweep gets it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash, createHmac, createCipheriv, createDecipheriv, createPublicKey, diffieHellman, hkdfSync } from 'node:crypto';
import WebSocket from 'ws';
import { setupApp, setupAdmin, makeClient, randomAesKey, nowEpoch } from './helpers.js';
import { canonical } from '../src/lib/canon.js';
import { b64uDecode, b64uEncode } from '../src/lib/b64u.js';
import { config } from '../src/config.js';
import { sweepMedia } from '../src/lib/media.js';
import { LIMIT_CATALOG, effectiveLimit } from '../src/lib/limits.js';

const LIMITS = {
  signupIpLimit: 1000,
  challengeIpLimit: 1000,
  verifyAccountLimit: 1000,
  verifyIpLimit: 1000,
  msgAccountLimit: 1000,
  msgIpLimit: 1000,
  userKeysIpLimit: 1000,
  deviceEnrollIpLimit: 1000,
  deviceApproveAccountLimit: 1000,
  // pair as many devices as a test needs (premium caps are other suites' job)
  deviceLimitUnverified: 6,
};

// setupApp does not surface the merged config (the app is DI'd), so the test
// builds the same object it hands over.
async function setupLive(overrides = {}) {
  const conf = { ...config, coldSendRequiresVerification: false, ...LIMITS, ...overrides };
  const ctx = await setupApp({ ...LIMITS, ...overrides });
  await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  return {
    ...ctx,
    conf,
    media: ctx.mongo.db.collection('media'),
    port: ctx.app.server.address().port,
  };
}

async function createUser(ctx, client, u, d = randomUUID()) {
  const a = randomAesKey();
  const t = nowEpoch();
  const res = await ctx.app.inject({
    method: 'POST', url: '/api/signup',
    payload: { u, p: client.p, x: client.x, a, d, t, s: client.signSignup({ u, a, d, t }) },
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

// A SECOND device on an existing account, paired through the real approval
// flow — multi-device fan-out and per-device authorisation need it.
async function addDevice(ctx, user, client, d = randomUUID()) {
  const a = randomAesKey();
  const t = nowEpoch();
  const enroll = await ctx.app.inject({
    method: 'POST', url: '/api/devices/enroll',
    payload: { u: user.u, p: client.p, x: client.x, a, d, t, s: client.signSignup({ u: user.u, a, d, t }) },
  });
  assert.equal(enroll.statusCode, 201, `enroll failed: ${enroll.body}`);
  const approve = await ctx.app.inject({
    method: 'POST', url: '/api/devices/approve',
    payload: { code: enroll.json().code }, headers: auth(user.token),
  });
  assert.equal(approve.statusCode, 200, `approve failed: ${approve.body}`);
  return { d, a, client, ...(await login(ctx, client, user.u, d)) };
}

const auth = (token) => ({ authorization: `Bearer ${token}` });
const sha = (buf) => createHash('sha256').update(buf).digest('base64url');
// a stored Binary read back out of Mongo, as the exact bytes that went in
const plainOf = (v) => (Buffer.isBuffer(v) ? v : Buffer.from(v.value ? v.value() : v));

// POST /api/media. `bytes`/`thumbBytes` stand in for ciphertext — the server
// never looks inside, so random bytes are indistinguishable from real bytes.
async function upload(ctx, token, { kind = 'image', bytes = null, thumbBytes = null, sha256, raw = null } = {}) {
  const blob = bytes ?? randomBytes(200);
  const payload = raw ?? {
    kind,
    blob: b64uEncode(blob),
    ...(thumbBytes ? { thumb: b64uEncode(thumbBytes) } : {}),
    sha256: sha256 ?? sha(blob),
  };
  const res = await ctx.app.inject({ method: 'POST', url: '/api/media', payload, headers: auth(token) });
  return { res, blob };
}

let cidSeq = 0;
function connectWs(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    const received = [];
    const listeners = new Set();
    ws.on('message', (raw) => {
      received.push(JSON.parse(raw.toString()));
      for (const l of [...listeners]) l();
    });
    async function waitFor(pred, count = 1, timeoutMs = 10000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hits = received.filter(pred);
        if (hits.length >= count) return count === 1 ? hits[0] : hits;
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

// --- the FE's E2EE mirror (same as messaging.test.js) ---
function convKeyFor(sender, recipientUl, recipientDv, recipientX) {
  const parts = [`${sender.ul}:${sender.d}`, `${recipientUl}:${recipientDv}`].sort();
  const info = `cocono-conv-v1|${parts[0]}|${parts[1]}`;
  const pub = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: recipientX }, format: 'jwk' });
  const shared = diffieHellman({ privateKey: sender.client.xPriv, publicKey: pub });
  return Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from(info), 32));
}
function e2eeEncrypt(key, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return b64uEncode(Buffer.concat([iv, ct, cipher.getAuthTag()]));
}

// Builds a valid envelope exactly as the FE does, optionally carrying the
// plaintext attachment descriptor (inside the HMAC'd block, like `sync`).
function buildEnvelope(sender, recipient, recipientDv, cid, { att = null, payload = null, sync = false } = {}) {
  const key = convKeyFor(sender, recipient.ul, recipientDv, recipient.client.x);
  const m = {
    d: e2eeEncrypt(key, payload ?? `hello-${cid}`),
    u: recipient.u, dv: recipientDv, f: sender.u, fd: sender.d, cid, t: nowEpoch(),
  };
  if (att) m.att = att;
  if (sync) m.sync = 1;
  const h = createHmac('sha256', b64uDecode(sender.a)).update(canonical(m)).digest('base64url');
  return { env: { m: { ...m, h } }, key };
}

const mediaPayload = (id, kind, extra = {}) => JSON.stringify({
  media: { id, kind, mime: 'image/jpeg', name: 'holiday.jpg', size: 1834, key: 'a2V5', iv: 'aXYxMg', sha256: 'z'.repeat(43), ...extra },
});

// ================== REST: upload / download / ack ==================

test('media: upload then download round-trips identical bytes', async () => {
  const ctx = await setupLive();
  try {
    const alice = await createUser(ctx, makeClient(), 'alice');
    const { res, blob } = await upload(ctx, alice.token);
    assert.equal(res.statusCode, 201, res.body);
    const { id } = res.json();

    const doc = await ctx.media.findOne({ _id: id });
    assert.equal(doc.owner.ul, 'alice');
    assert.equal(doc.owner.fd, alice.d);
    assert.equal(doc.kind, 'image');
    assert.equal(doc.ctSize, blob.length);
    assert.equal(doc.thumbCtSize, null);
    assert.deepEqual(doc.devices, [], 'an upload alone authorises nobody');
    assert.deepEqual(doc.pending, []);
    assert.equal(doc.reported, false);

    // the uploader may fetch its own blob (retry flows) — as raw octet-stream,
    // NEVER as a browser-renderable mime from our origin
    const dl = await ctx.app.inject({ method: 'GET', url: `/api/media/${id}`, headers: auth(alice.token) });
    assert.equal(dl.statusCode, 200);
    assert.equal(dl.headers['content-type'], 'application/octet-stream');
    assert.equal(dl.headers['x-content-type-options'], 'nosniff');
    assert.equal(dl.headers['x-cocono-kind'], 'image');
    assert.equal(dl.headers.etag, `"${sha(blob)}"`);
    assert.deepEqual([...dl.rawPayload], [...blob]);
  } finally { await ctx.teardown(); }
});

test('media: download authorisation is per-DEVICE and every miss says unknown_media', async () => {
  const ctx = await setupLive();
  try {
    const alice = await createUser(ctx, makeClient(), 'alice');
    const bob = await createUser(ctx, makeClient(), 'bobby');
    const bobB = await addDevice(ctx, bob, makeClient());
    const { res, blob } = await upload(ctx, alice.token, { thumbBytes: randomBytes(40) });
    const id = res.json().id;

    // an unrelated account: same 404 + code as a blob that never existed
    const stranger = await ctx.app.inject({ method: 'GET', url: `/api/media/${id}`, headers: auth(bob.token) });
    assert.equal(stranger.statusCode, 404);
    assert.equal(stranger.json().error, 'unknown_media');
    const never = await ctx.app.inject({ method: 'GET', url: `/api/media/${randomUUID()}`, headers: auth(alice.token) });
    assert.equal(never.statusCode, 404);
    assert.equal(never.json().error, 'unknown_media');
    const malformed = await ctx.app.inject({ method: 'GET', url: `/api/media/${encodeURIComponent('a b')}`, headers: auth(alice.token) });
    assert.equal(malformed.statusCode, 404);

    // no session at all
    assert.equal((await ctx.app.inject({ method: 'GET', url: `/api/media/${id}` })).statusCode, 401);

    // bob's SECOND device is not authorised just for sharing the account —
    // it has to have been addressed by an envelope to enter `devices`
    const b2 = await ctx.app.inject({ method: 'GET', url: `/api/media/${id}`, headers: auth(bobB.token) });
    assert.equal(b2.statusCode, 404);

    // thumb part exists, and fetching it changes nothing
    const th = await ctx.app.inject({ method: 'GET', url: `/api/media/${id}?part=thumb`, headers: auth(alice.token) });
    assert.equal(th.statusCode, 200);
    assert.equal(th.rawPayload.length, 40);
    assert.equal((await ctx.media.findOne({ _id: id })).pending.length, 0);
    // full blob still intact
    const full = await ctx.app.inject({ method: 'GET', url: `/api/media/${id}`, headers: auth(alice.token) });
    assert.deepEqual([...full.rawPayload], [...blob]);
  } finally { await ctx.teardown(); }
});

test('media: caps — blob size, thumb size, lying sha, bad kind, empty blob', async () => {
  const ctx = await setupLive({ mediaMaxBytes: 4096, mediaThumbMaxBytes: 64 });
  try {
    const alice = await createUser(ctx, makeClient(), 'alice');

    const big = await upload(ctx, alice.token, { bytes: randomBytes(5000) });
    assert.equal(big.res.statusCode, 413);
    assert.equal(big.res.json().error, 'media_too_large');

    const bigThumb = await upload(ctx, alice.token, { bytes: randomBytes(500), thumbBytes: randomBytes(80) });
    assert.equal(bigThumb.res.statusCode, 413);
    assert.equal(bigThumb.res.json().error, 'thumb_too_large');

    const lying = await upload(ctx, alice.token, { bytes: randomBytes(64), sha256: sha(randomBytes(64)) });
    assert.equal(lying.res.statusCode, 400);
    assert.equal(lying.res.json().error, 'bad_sha256');

    const badKind = await upload(ctx, alice.token, { raw: { kind: 'exe', blob: b64uEncode(randomBytes(8)), sha256: sha(Buffer.from('x')) } });
    assert.equal(badKind.res.statusCode, 400);
    assert.equal(badKind.res.json().error, 'invalid_request');

    const empty = await upload(ctx, alice.token, { raw: { kind: 'file', blob: '', sha256: sha(Buffer.from('x')) } });
    assert.equal(empty.res.statusCode, 400);

    const notB64 = await upload(ctx, alice.token, { raw: { kind: 'file', blob: '!!!!', sha256: sha(Buffer.from('x')) } });
    assert.equal(notB64.res.statusCode, 400);

    // the accepted pair, and both parts fetchable
    const ok = await upload(ctx, alice.token, { bytes: randomBytes(500), thumbBytes: randomBytes(40) });
    assert.equal(ok.res.statusCode, 201, ok.res.body);
    const doc = await ctx.media.findOne({ _id: ok.res.json().id });
    assert.equal(doc.ctSize, 500);
    assert.equal(doc.thumbCtSize, 40);
  } finally { await ctx.teardown(); }
});

test('media: per-account quota bounds server-held bytes (413 media_quota)', async () => {
  // MEDIA_QUOTA_MB is stated in megabytes; the test passes a fraction of one
  // so the loop stays cheap — same arithmetic, same code path
  const ctx = await setupLive({ mediaQuotaMb: 300 / (1024 * 1024) });
  try {
    const alice = await createUser(ctx, makeClient(), 'alice');
    const bob = await createUser(ctx, makeClient(), 'bobby');
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const { res } = await upload(ctx, alice.token, { bytes: randomBytes(90) });
      assert.equal(res.statusCode, 201, res.body);
      ids.push(res.json().id);
    }
    const over = await upload(ctx, alice.token, { bytes: randomBytes(90) });
    assert.equal(over.res.statusCode, 413);
    assert.equal(over.res.json().error, 'media_quota');

    // the quota is PER ACCOUNT — bob is untouched by alice's full shelf
    const bobby = await upload(ctx, bob.token, { bytes: randomBytes(90) });
    assert.equal(bobby.res.statusCode, 201, bobby.res.body);

    // and it is summed from what is REALLY held: deleting frees room
    await ctx.media.deleteOne({ _id: ids[0] });
    const again = await upload(ctx, alice.token, { bytes: randomBytes(90) });
    assert.equal(again.res.statusCode, 201, again.res.body);
  } finally { await ctx.teardown(); }
});

test('media: upload + download rate limiters trip (and are catalog entries)', async () => {
  const ctx = await setupLive({ mediaUpIpLimit: 2, mediaDlIpLimit: 3, mediaUpAccountLimit: 100, mediaDlAccountLimit: 100 });
  try {
    const alice = await createUser(ctx, makeClient(), 'alice');
    const ids = [];
    for (let i = 0; i < 2; i++) {
      const { res } = await upload(ctx, alice.token);
      assert.equal(res.statusCode, 201, res.body);
      ids.push(res.json().id);
    }
    const capped = await upload(ctx, alice.token);
    assert.equal(capped.res.statusCode, 429);
    assert.ok(capped.res.headers['retry-after'], '429 carries Retry-After');

    // three GETs fit the (per-IP) budget, the fourth is refused
    const get = () => ctx.app.inject({ method: 'GET', url: `/api/media/${ids[0]}`, headers: auth(alice.token) });
    assert.equal((await get()).statusCode, 200);
    assert.equal((await get()).statusCode, 200);
    assert.equal((await get()).statusCode, 200);
    assert.equal((await get()).statusCode, 429);
  } finally { await ctx.teardown(); }
});

// ================== handleSend: the `att` descriptor ==================

test('media: a send with att registers the recipient device in devices+pending', async () => {
  const ctx = await setupLive();
  try {
    const alice = await createUser(ctx, makeClient(), 'alice');
    const bob = await createUser(ctx, makeClient(), 'bobby');
    const { res, blob } = await upload(ctx, alice.token, { kind: 'image' });
    const id = res.json().id;

    const wsA = await connectWs(ctx.port, alice.token);
    const wsB = await connectWs(ctx.port, bob.token);
    await wsA.waitFor((m) => m.type === 'hello');
    await wsB.waitFor((m) => m.type === 'hello');

    const cid = 'media-cid-1';
    const { env, key } = buildEnvelope(alice, bob, bob.d, cid, {
      att: { id, kind: 'image', size: blob.length },
      payload: mediaPayload(id, 'image'),
    });
    wsA.send({ type: 'msg', msg: env });
    const ack = await wsA.waitFor((m) => m.type === 'ack' && m.cid === cid);
    assert.equal(ack.ok, true, JSON.stringify(ack));

    const doc = await ctx.media.findOne({ _id: id });
    assert.deepEqual(doc.devices, [{ ul: 'bobby', dv: bob.d }]);
    assert.deepEqual(doc.pending, [{ ul: 'bobby', dv: bob.d }]);

    // bob can now download, and the download alone does NOT ack (req 8
    // waits for an explicit ack so a half-finished client keeps the blob)
    const dl = await ctx.app.inject({ method: 'GET', url: `/api/media/${id}`, headers: auth(bob.token) });
    assert.equal(dl.statusCode, 200);
    assert.deepEqual([...dl.rawPayload], [...blob]);
    assert.equal((await ctx.media.findOne({ _id: id })).pending.length, 1);

    // the envelope reached bob with its att visible to the server and its
    // media payload intact to him alone
    const incoming = await wsB.waitFor((m) => m.type === 'msg');
    assert.deepEqual(incoming.env.m.att, { id, kind: 'image', size: blob.length });
    assert.equal(JSON.parse(e2eeDecryptFor(key, incoming.env.m.d)).media.id, id);

    // RETRYING the same cid is idempotent: two acks, still one device row
    wsA.send({ type: 'msg', msg: env });
    const acks = await wsA.waitFor((m) => m.type === 'ack' && m.cid === cid, 2);
    assert.equal(acks.length, 2);
    assert.ok(acks.every((a) => a.ok), JSON.stringify(acks));
    const after = await ctx.media.findOne({ _id: id });
    assert.equal(after.devices.length, 1);
    assert.equal(after.pending.length, 1);
    wsA.ws.close(); wsB.ws.close();
  } finally { await ctx.teardown(); }
});

test('media: att refuses a foreign blob, kind/size mismatch, junk shapes', async () => {
  const ctx = await setupLive();
  try {
    const alice = await createUser(ctx, makeClient(), 'alice');
    const bob = await createUser(ctx, makeClient(), 'bobby');
    const { res, blob } = await upload(ctx, alice.token, { kind: 'image' });
    const id = res.json().id;
    const wsA = await connectWs(ctx.port, alice.token);
    await wsA.waitFor((m) => m.type === 'hello');

    const send = async (att, cid) => {
      const { env } = buildEnvelope(alice, bob, bob.d, cid, { att });
      wsA.send({ type: 'msg', msg: env });
      return wsA.waitFor((m) => m.type === 'ack' && m.cid === cid);
    };
    const good = { id, kind: 'image', size: blob.length };

    // the happy path first (this is what puts bobby in `devices`)
    assert.equal((await send(good, 'media-att-ok')).ok, true);

    // not YOUR upload: flip the owner and the same descriptor is refused
    await ctx.media.updateOne({ _id: id }, { $set: { owner: { ul: 'bobby', fd: bob.d } } });
    const notMine = await send(good, 'media-foreign');
    assert.equal(notMine.ok, false);
    assert.equal(notMine.error, 'unknown_attachment');
    await ctx.media.updateOne({ _id: id }, { $set: { owner: { ul: 'alice', fd: alice.d } } });

    // a blob that is gone (swept / never uploaded)
    const gone = await send({ id: randomUUID(), kind: 'image', size: blob.length }, 'media-gone');
    assert.equal(gone.ok, false);
    assert.equal(gone.error, 'unknown_attachment');

    // kind / size must match the doc — otherwise the sender corrupts their
    // own lifecycle bookkeeping (att is HMAC'd, so only THEY can be wrong)
    const wrongKind = await send({ id, kind: 'file', size: blob.length }, 'media-kindbad');
    assert.equal(wrongKind.ok, false);
    assert.equal(wrongKind.error, 'invalid_envelope');
    const wrongSize = await send({ id, kind: 'image', size: blob.length + 7 }, 'media-sizebad');
    assert.equal(wrongSize.ok, false);
    assert.equal(wrongSize.error, 'invalid_envelope');

    // structural gate (envelope.js) — before the DB is ever consulted
    const badKind = await send({ id, kind: 'exe', size: blob.length }, 'media-attkind');
    assert.equal(badKind.ok, false);
    assert.equal(badKind.error, 'invalid_envelope');
    const strSize = await send({ id, kind: 'image', size: '12' }, 'media-attsize');
    assert.equal(strSize.ok, false);
    assert.equal(strSize.error, 'invalid_envelope');
    const huge = await send({ id, kind: 'image', size: ctx.conf.mediaMaxBytes + 1 }, 'media-atthuge');
    assert.equal(huge.ok, false);
    assert.equal(huge.error, 'invalid_envelope');
    const badId = await send({ id: 'no', kind: 'image', size: blob.length }, 'media-attbadid');
    assert.equal(badId.ok, false);
    assert.equal(badId.error, 'invalid_envelope');
    const notObj = await send('att', 'media-attstr');
    assert.equal(notObj.ok, false);
    assert.equal(notObj.error, 'invalid_envelope');

    // a TAMPERED att (HMAC computed over the honest one) fails at the mac
    const { env } = buildEnvelope(alice, bob, bob.d, 'media-atttamper', { att: good });
    env.m.att = { id: randomUUID(), kind: 'file', size: 1 };
    wsA.send({ type: 'msg', msg: env });
    const tampered = await wsA.waitFor((m) => m.type === 'ack' && m.cid === 'media-atttamper');
    assert.equal(tampered.ok, false);
    assert.equal(tampered.error, 'bad_hmac');

    // nothing illegitimate moved the bookkeeping
    const doc = await ctx.media.findOne({ _id: id });
    assert.deepEqual(doc.pending, [{ ul: 'bobby', dv: bob.d }]);
    wsA.ws.close();
  } finally { await ctx.teardown(); }
});

test('media: sync copies (sender own other devices) enter pending too', async () => {
  const ctx = await setupLive();
  try {
    const alice = await createUser(ctx, makeClient(), 'alice');
    const aliceB = await addDevice(ctx, alice, makeClient());
    const { res, blob } = await upload(ctx, alice.token, { kind: 'image' });
    const id = res.json().id;

    const wsA = await connectWs(ctx.port, alice.token);
    await wsA.waitFor((m) => m.type === 'hello');
    const cid = 'sync-media-1';
    const { env } = buildEnvelope(alice, alice, aliceB.d, cid, {
      att: { id, kind: 'image', size: blob.length },
      payload: JSON.stringify({ sync: 1, id: 'local-1', peer: 'bobby', ts: Date.now(), media: { id, kind: 'image' } }),
      sync: true,
    });
    wsA.send({ type: 'msg', msg: env });
    assert.equal((await wsA.waitFor((m) => m.type === 'ack' && m.cid === cid)).ok, true);

    const doc = await ctx.media.findOne({ _id: id });
    assert.deepEqual(doc.pending, [{ ul: 'alice', dv: aliceB.d }],
      'an own-device sync copy owes a download+ack like any recipient (req 8 counts it)');
  } finally { await ctx.teardown(); }
});

// ================== lifecycle (req 8) ==================

test('media: N devices — N-1 acks keep the blob, the last one deletes it', async () => {
  const ctx = await setupLive();
  try {
    const alice = await createUser(ctx, makeClient(), 'alice');
    const bob = await createUser(ctx, makeClient(), 'bobby');
    const bobB = await addDevice(ctx, bob, makeClient());
    const { res, blob } = await upload(ctx, alice.token, { kind: 'file' });
    const id = res.json().id;

    const wsA = await connectWs(ctx.port, alice.token);
    await wsA.waitFor((m) => m.type === 'hello');
    for (const [dv, cid] of [[bob.d, 'lifecycle-1'], [bobB.d, 'lifecycle-2']]) {
      const { env } = buildEnvelope(alice, bob, dv, cid, { att: { id, kind: 'file', size: blob.length } });
      wsA.send({ type: 'msg', msg: env });
      assert.equal((await wsA.waitFor((m) => m.type === 'ack' && m.cid === cid)).ok, true);
    }
    assert.equal((await ctx.media.findOne({ _id: id })).pending.length, 2);

    // device 1 downloads + acks: the blob must survive for device 2
    assert.equal((await ctx.app.inject({ method: 'GET', url: `/api/media/${id}`, headers: auth(bob.token) })).statusCode, 200);
    const first = await ctx.app.inject({
      method: 'POST', url: `/api/media/${id}/ack`, payload: { downloaded: true }, headers: auth(bob.token),
    });
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.json(), { ok: true, deleted: false });
    assert.ok(await ctx.media.findOne({ _id: id }));

    // an ack from a device NOT on `devices` (the sender) is refused exactly
    // like a gone blob — and changes nothing
    const intruder = await ctx.app.inject({
      method: 'POST', url: `/api/media/${id}/ack`, payload: { downloaded: true }, headers: auth(alice.token),
    });
    assert.equal(intruder.statusCode, 404);
    assert.equal(intruder.json().error, 'unknown_media');
    assert.equal((await ctx.media.findOne({ _id: id })).pending.length, 1);

    // re-ack is idempotent (a client that retries its ack must not be able
    // to delete the blob for a device that never got it)
    const again = await ctx.app.inject({
      method: 'POST', url: `/api/media/${id}/ack`, payload: { downloaded: true }, headers: auth(bob.token),
    });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().deleted, false);

    // a junk body is refused
    assert.equal((await ctx.app.inject({
      method: 'POST', url: `/api/media/${id}/ack`, payload: {}, headers: auth(bobB.token),
    })).statusCode, 400);

    // device 2 DECLINES (req 6: delete before downloading = received). Last
    // pending device => the blob is gone, bytes and all (req 8).
    const decline = await ctx.app.inject({
      method: 'POST', url: `/api/media/${id}/ack`, payload: { downloaded: false }, headers: auth(bobB.token),
    });
    assert.equal(decline.statusCode, 200);
    assert.deepEqual(decline.json(), { ok: true, deleted: true });
    assert.equal(await ctx.media.findOne({ _id: id }), null);

    // a late replay of the envelope now simply 404s (the app renders the
    // 'no longer available' placeholder — see the client side)
    const late = await ctx.app.inject({ method: 'GET', url: `/api/media/${id}`, headers: auth(bob.token) });
    assert.equal(late.statusCode, 404);
    const lateAck = await ctx.app.inject({
      method: 'POST', url: `/api/media/${id}/ack`, payload: { downloaded: true }, headers: auth(bob.token),
    });
    assert.equal(lateAck.statusCode, 200, 'an ack for a dead blob is satisfied, not an error');
    wsA.ws.close();
  } finally { await ctx.teardown(); }
});

test('media: self-chat media keeps the sender own device in pending', async () => {
  const ctx = await setupLive();
  try {
    const alice = await createUser(ctx, makeClient(), 'alice');
    const { res, blob } = await upload(ctx, alice.token, { kind: 'image' });
    const id = res.json().id;
    const wsA = await connectWs(ctx.port, alice.token);
    await wsA.waitFor((m) => m.type === 'hello');
    // a self-chat copy routed to alice's OWN other device
    const aliceB = await addDevice(ctx, alice, makeClient());
    const cid = 'self-media-1';
    const { env } = buildEnvelope(alice, alice, aliceB.d, cid, { att: { id, kind: 'image', size: blob.length }, payload: mediaPayload(id, 'image') });
    wsA.send({ type: 'msg', msg: env });
    assert.equal((await wsA.waitFor((m) => m.type === 'ack' && m.cid === cid)).ok, true);
    const doc = await ctx.media.findOne({ _id: id });
    assert.deepEqual(doc.pending, [{ ul: 'alice', dv: aliceB.d }]);
    wsA.ws.close();
  } finally { await ctx.teardown(); }
});

test('media: sweeper — retention delete, orphan delete, report pin survives', async () => {
  const ctx = await setupLive({ mediaRetentionDays: 7, mediaOrphanMaxSec: 3600 });
  try {
    const alice = await createUser(ctx, makeClient(), 'alice');
    const mk = async (_id, { ageMs, devices, reported = false }) => ctx.media.insertOne({
      _id, owner: { ul: 'alice', fd: alice.d }, kind: 'file', ctSize: 10, thumbCtSize: null,
      sha256: 'x', blob: randomBytes(10), thumb: null, devices, pending: devices, reported,
      ts: new Date(Date.now() - ageMs),
    });
    await mk('stale-unacked', { ageMs: 8 * 86400_000, devices: [{ ul: 'bobby', dv: 'd1' }] });
    await mk('stale-reported', { ageMs: 8 * 86400_000, devices: [{ ul: 'bobby', dv: 'd1' }], reported: true });
    await mk('orphan-upload', { ageMs: 2 * 3600_000, devices: [] });
    await mk('fresh-sent', { ageMs: 60_000, devices: [{ ul: 'bobby', dv: 'd1' }] });

    assert.deepEqual(await sweepMedia(ctx.media, ctx.conf), { expired: 1, orphans: 1 });
    assert.deepEqual(
      (await ctx.media.find({}).toArray()).map((d) => d._id).sort(),
      ['fresh-sent', 'stale-reported'],
      'a report-pinned blob outlives every sweep (req 9), a fresh one survives',
    );
  } finally { await ctx.teardown(); }
});

test('media: account deletion removes the owned blobs', async () => {
  const ctx = await setupLive();
  try {
    const alice = await createUser(ctx, makeClient(), 'alice');
    const bob = await createUser(ctx, makeClient(), 'bobby');
    const mine = await upload(ctx, alice.token);
    const theirs = await upload(ctx, bob.token);

    const { deleteAccountFully } = await import('../src/lib/accountState.js');
    const db = ctx.mongo.db;
    await deleteAccountFully({
      users: db.collection('users'), profiles: db.collection('profiles'),
      idDocs: db.collection('id_docs'), messages: db.collection('messages'),
      diagnostics: db.collection('diagnostics'), settings: db.collection('settings'),
      redis: ctx.redis, shares: db.collection('shares'), contacts: db.collection('contacts'),
      media: ctx.media,
    }, 'alice');

    assert.equal(await ctx.media.countDocuments({ 'owner.ul': 'alice' }), 0, 'owned uploads go with the account');
    assert.equal(await ctx.media.findOne({ _id: mine.res.json().id }), null);
    assert.ok(await ctx.media.findOne({ _id: theirs.res.json().id }), "someone else's blob is untouched");
  } finally { await ctx.teardown(); }
});

// ================== reports: server-decryptable media (req 9) ==================
// The server holds ciphertext and NO key. Reporting is the act that hands one
// over — the reporter's client legitimately holds the file keys of its own
// conversation. These tests are about what that makes possible, and about the
// two things it must NOT make possible: decrypting a blob you were not given,
// and failing a report because one attachment was mis-recorded.

function encryptFile(keyB64u, plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', b64uDecode(keyB64u), iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { blob: Buffer.concat([iv, ct, cipher.getAuthTag()]), iv: b64uEncode(iv) };
}
const FILE_KEY = b64uEncode(randomBytes(32));
const PLAIN = Buffer.from('a picture worth reviewing'.repeat(8));

// upload + send a real ciphertext blob to bob, and return everything a report
// needs (bob's session, the blob id, the key he was given)
async function sentBlobTo(ctx, alice, bob, { ws } = {}) {
  const { blob, iv } = encryptFile(FILE_KEY, PLAIN);
  const up = await ctx.app.inject({
    method: 'POST', url: '/api/media', headers: auth(alice.token),
    payload: { kind: 'image', blob: b64uEncode(blob), sha256: sha(blob) },
  });
  assert.equal(up.statusCode, 201, up.body);
  const id = up.json().id;
  // The caller OWNS the socket: a second connection for the same device
  // REPLACES the first (4000 replaced) and the ack being waited on would vanish
  // with it — which is how a multi-blob test used to race itself.
  const socket = ws;
  const cid = `report-${id.slice(0, 8)}-${++cidSeq}`;
  const { env } = buildEnvelope(alice, bob, bob.d, cid, {
    att: { id, kind: 'image', size: blob.length },
    payload: JSON.stringify({ media: { id, kind: 'image', mime: 'image/png', name: 'evidence.png', size: PLAIN.length, key: FILE_KEY, iv, sha256: sha(blob) } }),
  });
  socket.send({ type: 'msg', msg: env });
  const ack = await socket.waitFor((m) => m.type === 'ack' && m.cid === cid);
  assert.equal(ack.ok, true, JSON.stringify(ack));
  if (!ws) socket.ws.close();  // a helper-owned socket does not outlive the call
  return { id, iv, blob };
}

async function reportMedia(ctx, reporter, peer, media, overrides = {}) {
  return ctx.app.inject({
    method: 'POST', url: '/api/me/report', headers: auth(reporter.token),
    payload: {
      peer, r: 'harassment', description: 'sent me this',
      messages: [{ from: peer, ts: 1, text: 'look at this' }],
      media, ...overrides,
    },
  });
}

test('reports: a reported attachment is decrypted server-side and pinned', async () => {
  const ctx = await setupLive();
  try {
    const alice = await createUser(ctx, makeClient(), 'alice');
    const bob = await createUser(ctx, makeClient(), 'bobby');
    const wsA = await connectWs(ctx.port, alice.token);
    const { id } = await sentBlobTo(ctx, alice, bob, { ws: wsA });

    const res = await reportMedia(ctx, bob, 'alice', [
      { blobId: id, kind: 'image', name: 'evidence.png', mime: 'image/png', key: FILE_KEY },
    ]);
    assert.equal(res.statusCode, 202, res.body);

    const rep = await ctx.mongo.db.collection('reports').findOne({});
    assert.equal(rep.media.length, 1);
    assert.equal(rep.media[0].source, 'server');
    assert.equal(rep.media[0].undecryptable, undefined);
    assert.equal(rep.media[0].bytes, PLAIN.length);
    assert.equal(rep.media[0].plain, undefined, 'the report doc carries METADATA only');
    const held = await ctx.mongo.db.collection('report_media').findOne({ report: rep._id, index: 0 });
    assert.equal(plainOf(held.plain).toString(), PLAIN.toString(),
      'req 9: moderation can READ the attachment, not just store a blob');
    assert.equal(held.kind, 'image');

    // pinned: the sweep must not destroy evidence under review, however old
    const doc = await ctx.media.findOne({ _id: id });
    assert.equal(doc.reported, true);
    await ctx.media.updateOne({ _id: id }, { $set: { ts: new Date(Date.now() - 99 * 86400_000) } });
    assert.deepEqual(await sweepMedia(ctx.media, ctx.conf), { expired: 0, orphans: 0 });
    assert.ok(await ctx.media.findOne({ _id: id }));
    wsA.ws.close();
  } finally { await ctx.teardown(); }
});

test('reports: a blob the caller was never given is dropped, not decrypted', async () => {
  const ctx = await setupLive();
  try {
    const alice = await createUser(ctx, makeClient(), 'alice');
    const bob = await createUser(ctx, makeClient(), 'bobby');
    const carol = await createUser(ctx, makeClient(), 'carol');
    const wsA = await connectWs(ctx.port, alice.token);
    const { id } = await sentBlobTo(ctx, alice, bob, { ws: wsA });

    // carol guessed a blob id and read the key out of nothing: no access, no
    // plaintext, and the blob is NOT pinned by a stranger's report
    const res = await reportMedia(ctx, carol, 'alice', [
      { blobId: id, kind: 'image', name: 'x.png', mime: 'image/png', key: FILE_KEY, data: b64uEncode(PLAIN) },
    ]);
    assert.equal(res.statusCode, 202, res.body);
    const rep = await ctx.mongo.db.collection('reports').findOne({});
    assert.deepEqual(rep.media, [], 'an unauthorised media entry never lands');
    assert.equal((await ctx.media.findOne({ _id: id })).reported, false);
    wsA.ws.close();
  } finally { await ctx.teardown(); }
});

test('reports: blob already gone → the reporter copy is stored; bad key → undecryptable, report still lands', async () => {
  const ctx = await setupLive();
  try {
    const alice = await createUser(ctx, makeClient(), 'alice');
    const bob = await createUser(ctx, makeClient(), 'bobby');
    const wsA = await connectWs(ctx.port, alice.token);
    const one = await sentBlobTo(ctx, alice, bob, { ws: wsA });
    const two = await sentBlobTo(ctx, alice, bob, { ws: wsA });

    // the lifecycle already did its job: every device acked, the bytes are gone
    await ctx.media.deleteOne({ _id: one.id });

    const res = await reportMedia(ctx, bob, 'alice', [
      { blobId: one.id, kind: 'image', name: 'from-reporter.png', mime: 'image/png', key: FILE_KEY, data: b64uEncode(PLAIN) },
      { blobId: two.id, kind: 'image', name: 'bad-key.png', mime: 'image/png', key: b64uEncode(randomBytes(32)) },
    ]);
    assert.equal(res.statusCode, 202, res.body, 'one broken item never fails the report');

    const rep = await ctx.mongo.db.collection('reports').findOne({});
    assert.equal(rep.media.length, 2);
    const [gone, wrong] = rep.media;
    assert.equal(gone.source, 'reporter');
    assert.equal(wrong.undecryptable, true);
    assert.equal(wrong.reason, 'undecryptable');
    const wrongDocs = await ctx.mongo.db.collection('report_media').countDocuments({ report: rep._id });
    assert.equal(wrongDocs, 1, 'only the readable item writes a byte doc');
    const stored = await ctx.mongo.db.collection('report_media').findOne({ report: rep._id, index: 0 });
    assert.equal(plainOf(stored.plain).toString(), PLAIN.toString());
    assert.equal((await ctx.media.findOne({ _id: two.id })).reported, true,
      'even an undecryptable item pins its blob for review');
    wsA.ws.close();
  } finally { await ctx.teardown(); }
});

test('reports: media caps — three items reach the route, the shelf is total', async () => {
  const ctx = await setupLive();
  try {
    const alice = await createUser(ctx, makeClient(), 'alice');
    const bob = await createUser(ctx, makeClient(), 'bobby');
    const wsA = await connectWs(ctx.port, alice.token);
    const blobs = [];
    for (let i = 0; i < 4; i++) blobs.push(await sentBlobTo(ctx, alice, bob, { ws: wsA }));
    const res = await reportMedia(ctx, bob, 'alice', blobs.map((b, i) => ({
      blobId: b.id, kind: 'file', name: `f${i}.png`, mime: 'image/png', key: FILE_KEY,
    })));
    assert.equal(res.statusCode, 202, res.body);
    const rep = await ctx.mongo.db.collection('reports').findOne({});
    assert.equal(rep.media.length, 3, 'the FOURTH item is never read (sliced at the door)');
    assert.equal(rep.mediaBytes, PLAIN.length * 3);

    assert.equal(await ctx.mongo.db.collection('report_media').countDocuments({ report: rep._id }), 3,
      'one doc per readable attachment (a 3x10 MB report could never fit one Mongo doc)');
    wsA.ws.close();
  } finally { await ctx.teardown(); }
});

test('reports: an attachment over the media budget is recorded without bytes', async () => {
  // the cap is a CONFIG value (REPORT_MEDIA_MAX_BYTES), shrunk here so the
  // test does not have to move 30 MB around
  const ctx = await setupLive({ reportMediaMaxBytes: 64 });
  try {
    const alice = await createUser(ctx, makeClient(), 'alice');
    const bob = await createUser(ctx, makeClient(), 'bobby');
    const wsA = await connectWs(ctx.port, alice.token);
    const b = await sentBlobTo(ctx, alice, bob, { ws: wsA });
    const res = await reportMedia(ctx, bob, 'alice', [
      { blobId: b.id, kind: 'image', name: 'too-big.png', mime: 'image/png', key: FILE_KEY },
    ]);
    assert.equal(res.statusCode, 202, res.body);
    const rep = await ctx.mongo.db.collection('reports').findOne({});
    assert.equal(rep.media.length, 1);
    assert.equal(rep.media[0].reason, 'over_report_media_cap');
    assert.equal(rep.media[0].undecryptable, true);
    assert.equal(rep.mediaBytes, 0);
    assert.equal(await ctx.mongo.db.collection('report_media').countDocuments({ report: rep._id }), 0);
    assert.equal((await ctx.media.findOne({ _id: b.id })).reported, true,
      'even a capped-out item pins the blob — the bytes are still evidence');
    wsA.ws.close();
  } finally { await ctx.teardown(); }
});

test('reports: the admin serves decrypted bytes with a SNIFFED content type', async () => {
  const ctx = await setupAdmin();
  try {
    const admin = ctx.admin;
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 3)]);
    const html = Buffer.from('<script>alert(1)</script>');
    const rid = (await ctx.db.collection('reports').insertOne({
      ts: new Date(), account: 'alice', peer: 'bobby', reason: 'harassment', description: 'x',
      messages: [], mediaCount: 2, mediaBytes: png.length + html.length,
      media: [
        { blobId: 'aaaa1111', kind: 'image', name: 'a.png', mime: 'image/png', bytes: png.length, source: 'server' },
        { blobId: 'bbbb2222', kind: 'file', name: 'evil.html', mime: 'text/html', bytes: html.length, source: 'reporter' },
      ],
    })).insertedId;
    // the BYTES live one doc each (a three-attachment report would not fit in a
    // single Mongo document); the report itself carries metadata only
    await ctx.db.collection('report_media').insertMany([
      { report: rid, index: 0, blobId: 'aaaa1111', kind: 'image', name: 'a.png', mime: 'image/png', bytes: png.length, source: 'server', plain: png, ts: new Date() },
      { report: rid, index: 1, blobId: 'bbbb2222', kind: 'file', name: 'evil.html', mime: 'text/html', bytes: html.length, source: 'reporter', plain: html, ts: new Date() },
    ]);

    const list = await admin.inject({ method: 'GET', url: '/api/admin/reports' });
    assert.equal(list.statusCode, 200);
    const rep = list.json()[0];
    assert.equal(rep.media.length, 2);
    assert.deepEqual(rep.media.map((m) => m.hasBytes), [true, true]);
    assert.equal(rep.media[0].name, 'a.png');
    assert.equal(rep.media[0].plain, undefined, 'the LIST carries metadata only');

    const ok = await admin.inject({ method: 'GET', url: `/api/admin/reports/${rid}/media/0` });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers['content-type'], 'image/png');
    assert.match(ok.headers['content-disposition'], /^inline/);
    assert.deepEqual([...ok.rawPayload], [...png]);

    // the claimed mime is a LIE and the bytes are HTML: never rendered as such
    // on the admin origin — forced download, and nosniff stays on
    const bad = await admin.inject({ method: 'GET', url: `/api/admin/reports/${rid}/media/1` });
    assert.equal(bad.statusCode, 200);
    assert.equal(bad.headers['content-type'], 'application/octet-stream');
    assert.match(bad.headers['content-disposition'] ?? '', /attachment/);
    assert.equal(bad.headers['x-content-type-options'], 'nosniff');

    const missing = await admin.inject({ method: 'GET', url: `/api/admin/reports/${rid}/media/7` });
    assert.equal(missing.statusCode, 404);
    const badId = await admin.inject({ method: 'GET', url: '/api/admin/reports/not-an-id/media/0' });
    assert.equal(badId.statusCode, 400);

    // closing the report takes its attachments with it
    const del = await admin.inject({ method: 'DELETE', url: `/api/admin/reports/${rid}` });
    assert.equal(del.statusCode, 200);
    assert.equal(await ctx.db.collection('report_media').countDocuments({ report: rid }), 0,
      'no decrypted bytes outlive the moderation record');
  } finally { await ctx.teardown(); }
});

function e2eeDecryptFor(key, d) {
  const buf = b64uDecode(d);
  const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([decipher.update(buf.subarray(12, buf.length - 16)), decipher.final()]).toString('utf8');
}

test('media: the new limiters join the catalog (admin labels, overrides, clear-by-IP)', async () => {
  const ctx = await setupAdmin();
  try {
    const IP = '192.0.2.77';
    // four buckets, two shapes: IP-scoped (the 'clear limits for IP' sweep
    // must reach them) and account-scoped (they belong to the account, not to
    // whatever network it happens to be on)
    await ctx.redis.incr(`rl:mediaup:${IP}`);
    await ctx.redis.incr(`rl:mediadl:${IP}`);
    await ctx.redis.incr('rl:mediaupacct:alice');

    const listed = (await ctx.admin.inject({ method: 'GET', url: '/api/admin/rate-limits' })).json();
    for (const name of ['mediaup', 'mediadl', 'mediaupacct', 'mediadlacct']) {
      assert.ok(LIMIT_CATALOG[name], `${name} is in the catalog (the ONE source of limit truth)`);
      assert.match(LIMIT_CATALOG[name].label, /Media/, `${name} carries a human label`);
    }
    const seen = (key) => listed.find((e) => e.key === key);
    assert.ok(seen(`rl:mediaup:${IP}`), 'the admin Traffic page lists the upload guard');
    assert.equal(seen(`rl:mediaup:${IP}`).scope, 'ip');
    assert.equal(seen('rl:mediaupacct:alice')?.scope, 'account');

    const cleared = await ctx.admin.inject({
      method: 'POST', url: '/api/admin/rate-limits/clear', payload: { ip: IP },
    });
    assert.equal(cleared.statusCode, 200);
    assert.equal(await ctx.redis.exists(`rl:mediaup:${IP}`, `rl:mediadl:${IP}`), 0, 'IP buckets swept');
    assert.equal(await ctx.redis.exists('rl:mediaupacct:alice'), 1, 'the account budget survives an IP clear');

    // an admin override on the catalog name moves the effective limit
    const put = await ctx.admin.inject({
      method: 'PATCH', url: '/api/admin/limits',
      payload: { name: 'mediaupacct', user: 'alice', value: { limit: 3 } },
    });
    assert.equal(put.statusCode, 200, put.body);
    assert.equal(put.json().effective.limit, 3, 'per-account media override lands');
    // (setupAdmin has no merged-config shortcut like setupLive's `conf`, so
    // this asserts against the real defaults the route itself would use)
    assert.deepEqual(await effectiveLimit(ctx.mongo.db.collection('settings'), config, 'mediaupacct', 'alice'),
      { limit: 3, windowSec: config.mediaUpWindowSec });
    // and an IP-scoped name refuses a per-subject override (there is no
    // meaningful 'this IP' knob — that would be a ban, not a limit)
    const nope = await ctx.admin.inject({
      method: 'PATCH', url: '/api/admin/limits',
      payload: { name: 'mediaup', user: 'alice', value: { limit: 3 } },
    });
    assert.equal(nope.statusCode, 400);
  } finally { await ctx.teardown(); }
});

test('media: a staff-BANNED account cannot move bytes either (M4 × moderation)', async () => {
  const ctx = await setupLive();
  try {
    const alice = await createUser(ctx, makeClient(), 'alice');
    const bob = await createUser(ctx, makeClient(), 'bobby');
    const up = await upload(ctx, alice.token, { kind: 'image' });
    assert.equal(up.res.statusCode, 201, up.res.body);
    const id = up.res.json().id;

    // BAN the account the way the admin does (the flag on the user doc): the
    // bearer hook then refuses EVERY authenticated call, and the media routes
    // are authenticated calls — the blob locker is not a side door.
    await ctx.mongo.db.collection('users').updateOne({ ul: 'alice' }, { $set: { banned: true } });
    const after = await upload(ctx, alice.token, { kind: 'image' });
    assert.equal(after.res.statusCode, 403);
    assert.equal(after.res.json().error, 'account_banned');
    assert.equal((await ctx.app.inject({ method: 'GET', url: `/api/media/${id}`, headers: auth(alice.token) })).statusCode, 403);
    assert.equal((await ctx.app.inject({
      method: 'POST', url: `/api/media/${id}/ack`, payload: { downloaded: true }, headers: auth(alice.token),
    })).statusCode, 403);
    // and there is no live channel either: the upgrade itself is refused with
    // 4403 (lib/moderation.js — a dead-session code, so the SDK stops
    // reconnecting), which means a banned account cannot even deliver the
    // envelope that would reference a blob
    const closed = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws?token=${alice.token}`);
      const timer = setTimeout(() => { ws.close(); reject(new Error('the banned session was never closed')); }, 8000);
      ws.on('close', (code) => { clearTimeout(timer); resolve(code); });
      ws.on('error', () => { clearTimeout(timer); resolve('error'); });
    });
    assert.equal(closed, 4403);
  } finally { await ctx.teardown(); }
});
