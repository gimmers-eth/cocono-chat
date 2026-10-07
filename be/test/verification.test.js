// Identity verification: user ID-photo upload + state, admin toggle,
// admin view/delete of the photo. The peer trust ladder is a separate
// concern (friends.test.js) — this is the admin-checked real-person flag.

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { setupApp, makeClient, randomAesKey, nowEpoch } from './helpers.js';
import { b64uEncode } from '../src/lib/b64u.js';
import adminRoutes from '../src/routes/admin-routes/index.js';

async function signupUser(app, client, u, d = randomUUID()) {
  const a = randomAesKey();
  const t = nowEpoch();
  const s = client.signSignup({ u, a, d, t });
  const res = await app.inject({
    method: 'POST', url: '/api/signup',
    payload: { u, p: client.p, x: client.x, a, d, t, s },
  });
  assert.equal(res.statusCode, 201);
  return { a, d };
}

async function getToken(app, client, u, d) {
  const { n } = (await app.inject({ method: 'POST', url: '/api/auth/challenge', payload: { u, d } })).json();
  const ve = await app.inject({
    method: 'POST', url: '/api/auth/verify',
    payload: { u, d, n, s: client.signBytes(Buffer.from(n, 'utf8')) },
  });
  return ve.json().token;
}

// A tiny fake "photo" — the server validates type/size, never image-parses.
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(200),
]);
const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8]), randomBytes(200), Buffer.from([0xff, 0xd9]),
]);

function adminApp(ctx) {
  return (async () => {
    const admin = Fastify({ logger: false });
    await admin.register(adminRoutes, {
      users: ctx.mongo.db.collection('users'),
      redis: ctx.redis,
      config: (await import('../src/config.js')).config,
      diagnostics: ctx.mongo.db.collection('diagnostics'),
      settings: ctx.mongo.db.collection('settings'),
      messages: ctx.mongo.db.collection('messages'),
      idDocs: ctx.mongo.db.collection('id_docs'),
    });
    return admin;
  })();
}

test('identity: upload ID photo, state surfaces in /api/me, guards hold', async () => {
  const { app, mongo, teardown } = await setupApp({ idDocMaxBytes: 320, idDocAccountLimit: 50, idDocIpLimit: 50, idUploadRequiresTrustedVerifier: false });
  try {
    const c = makeClient();
    const a = await signupUser(app, c, 'iduser');
    const auth = { authorization: `Bearer ${await getToken(app, c, 'iduser', a.d)}` };

    const me0 = await app.inject({ method: 'GET', url: '/api/me', headers: auth });
    assert.equal(me0.json().verified, false);
    assert.equal(me0.json().idDoc ?? null, null);

    const up = await app.inject({
      method: 'POST', url: '/api/me/verify-id', headers: auth,
      payload: { contentType: 'image/png', data: b64uEncode(PNG_BYTES) },
    });
    assert.equal(up.statusCode, 200, up.body);
    assert.equal(up.json().bytes, PNG_BYTES.length);

    const me1 = await app.inject({ method: 'GET', url: '/api/me', headers: auth });
    assert.equal(me1.json().idDoc.contentType, 'image/png');
    assert.ok(me1.json().idDoc.uploadedAt);

    // not-a-real-image rejected despite claiming png
    const fake = await app.inject({
      method: 'POST', url: '/api/me/verify-id', headers: auth,
      payload: { contentType: 'image/png', data: b64uEncode(randomBytes(200)) },
    });
    assert.equal(fake.statusCode, 400);
    assert.equal(fake.json().error, 'not_an_image');

    // client's CLAIM is normalized to the sniffed truth: jpeg bytes
    const mislabeled = await app.inject({
      method: 'POST', url: '/api/me/verify-id', headers: auth,
      payload: { contentType: 'image/png', data: b64uEncode(JPEG_BYTES) },
    });
    assert.equal(mislabeled.json().contentType, 'image/jpeg');

    // content type + size guards
    const badType = await app.inject({
      method: 'POST', url: '/api/me/verify-id', headers: auth,
      payload: { contentType: 'image/svg+xml', data: b64uEncode(PNG_BYTES) },
    });
    assert.equal(badType.statusCode, 400);
    const tooBig = await app.inject({
      method: 'POST', url: '/api/me/verify-id', headers: auth,
      payload: { contentType: 'image/png', data: b64uEncode(Buffer.concat([PNG_BYTES.subarray(0, 8), randomBytes(320)])) },
    });
    assert.equal(tooBig.statusCode, 413);

    // verified users cannot (re-)upload
    await mongo.db.collection('users').updateOne({ ul: 'iduser' }, { $set: { verified: true } });
    const afterVerify = await app.inject({
      method: 'POST', url: '/api/me/verify-id', headers: auth,
      payload: { contentType: 'image/png', data: b64uEncode(PNG_BYTES) },
    });
    assert.equal(afterVerify.statusCode, 400);
    assert.equal(afterVerify.json().error, 'already_verified');
  } finally {
    await teardown();
  }
});

test('admin: list flags, verify toggle, view + delete ID photo', async () => {
  const ctx = await setupApp({ idUploadRequiresTrustedVerifier: false });
  const admin = await adminApp(ctx);
  try {
    const c = makeClient();
    const a = await signupUser(ctx.app, c, 'admuser');
    const auth = { authorization: `Bearer ${await getToken(ctx.app, c, 'admuser', a.d)}` };
    await ctx.app.inject({
      method: 'POST', url: '/api/me/verify-id', headers: auth,
      payload: { contentType: 'image/jpeg', data: b64uEncode(JPEG_BYTES) },
    });

    const list = await admin.inject({ method: 'GET', url: '/api/admin/users' });
    const row = list.json().find((u) => u.ul === 'admuser');
    assert.equal(row.verified, false);
    assert.equal(row.idDoc.contentType, 'image/jpeg');

    // view the photo (admin-only endpoint serves the raw bytes)
    const view = await admin.inject({ method: 'GET', url: '/api/admin/users/admuser/id-doc' });
    assert.equal(view.statusCode, 200);
    assert.equal(view.headers['content-type'], 'image/jpeg');
    assert.deepEqual(Buffer.from(view.rawPayload), JPEG_BYTES);

    // toggle on -> app sees it; toggle off -> cold flag clears
    const on = await admin.inject({
      method: 'PUT', url: '/api/admin/users/admuser/verified',
      payload: { verified: true },
    });
    assert.equal(on.json().verified, true);
    const me = await ctx.app.inject({ method: 'GET', url: '/api/me', headers: auth });
    assert.equal(me.json().verified, true);

    // deleting the photo keeps the verification state
    const del = await admin.inject({ method: 'DELETE', url: '/api/admin/users/admuser/id-doc' });
    assert.equal(del.json().deleted, true);
    const list2 = await admin.inject({ method: 'GET', url: '/api/admin/users' });
    const row2 = list2.json().find((u) => u.ul === 'admuser');
    assert.equal(row2.verified, true);
    assert.equal(row2.idDoc, null);
    assert.equal((await admin.inject({ method: 'GET', url: '/api/admin/users/admuser/id-doc' })).statusCode, 404);

    // deleting the account removes the photo too (no orphaned ID images)
    await ctx.app.inject({ method: 'POST', url: '/api/me/verify-id',
      headers: auth, payload: { contentType: 'image/png', data: b64uEncode(PNG_BYTES) } }).catch(() => {});
  } finally {
    await admin.close();
    await ctx.teardown();
  }
});


// --- vouching gate + reputation stats (feature adds) ---

const LIMITS = {
  signupIpLimit: 1000, challengeIpLimit: 1000, verifyAccountLimit: 1000, verifyIpLimit: 1000,
  friendsIpLimit: 1000, friendsChangeIpLimit: 1000, idDocIpLimit: 50, idDocAccountLimit: 50,
  userKeysIpLimit: 1000,
};

async function trustAndVerifyTarget(app, target, token) {
  const h = { authorization: `Bearer ${token}` };
  await app.inject({ method: 'PUT', url: `/api/me/friends/${target}`, headers: h });
  await app.inject({ method: 'PUT', url: `/api/me/friends/${target}/verify`, headers: h, payload: { verified: true } });
  return app.inject({ method: 'PUT', url: `/api/me/friends/${target}/trust`, headers: h, payload: { trust: true } });
}

test('ID upload requires a VERIFIED user to trust you first (vouching gate)', async () => {
  const { app, mongo, teardown } = await setupApp(LIMITS);
  try {
    const alice = makeClient(); const bob = makeClient();
    const a = await signupUser(app, alice, 'alice');
    const b = await signupUser(app, bob, 'bobby');
    const tA = await getToken(app, alice, 'alice', a.d);
    const tB = await getToken(app, bob, 'bobby', b.d);
    const hA = { authorization: `Bearer ${tA}` };
    const png = { contentType: 'image/png', data: b64uEncode(PNG_BYTES) };

    // 1) cold: no vouch -> gate closed
    const denied = await app.inject({ method: 'POST', url: '/api/me/verify-id', headers: hA, payload: png });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().error, 'needs_trusted_verifier');
    let me = await app.inject({ method: 'GET', url: '/api/me', headers: hA });
    assert.equal(me.json().canUploadId, false);

    // 2) bob trusts alice but is NOT verified himself -> still locked
    await trustAndVerifyTarget(app, 'alice', tB);
    me = await app.inject({ method: 'GET', url: '/api/me', headers: hA });
    assert.equal(me.json().canUploadId, false, 'unverified vouch must not unlock');

    // 3) admin verifies bob -> alice unlocked
    await mongo.db.collection('users').updateOne({ ul: 'bobby' }, { $set: { verified: true } });
    me = await app.inject({ method: 'GET', url: '/api/me', headers: hA });
    assert.equal(me.json().canUploadId, true);
    const up = await app.inject({ method: 'POST', url: '/api/me/verify-id', headers: hA, payload: png });
    assert.equal(up.statusCode, 200, up.body);
  } finally {
    await teardown();
  }
});

async function trustAndVerifyTargetStep2(app, carolToken) {
  // carol vouches for bobby and verifies (but does NOT trust) -> bobby's
  // verifiedBy bucket gets exactly 1
  const h = { authorization: `Bearer ${carolToken}` };
  await app.inject({ method: 'PUT', url: '/api/me/friends/bobby', headers: h });
  await app.inject({ method: 'PUT', url: '/api/me/friends/bobby/verify', headers: h, payload: { verified: true } });
}

test('user stats: vouch counts are EXCLUSIVE stage buckets', async () => {
  const { app, mongo, teardown } = await setupApp(LIMITS);
  try {
    const alice = makeClient(); const bob = makeClient(); const carol = makeClient();
    const a = await signupUser(app, alice, 'alice');
    const b = await signupUser(app, bob, 'bobby');
    const c = await signupUser(app, carol, 'carol');
    const tB = await getToken(app, bob, 'bobby', b.d);
    const tC = await getToken(app, carol, 'carol', c.d);
    const hB = { authorization: `Bearer ${tB}` };

    // bob adds + verifies + trusts carol: he alone is ONE trusted vouch,
    // not one of each
    await trustAndVerifyTarget(app, 'carol', tB);

    const stats = await app.inject({ method: 'GET', url: '/api/users/carol/stats', headers: hB });
    assert.equal(stats.statusCode, 200);
    assert.deepEqual(stats.json(), { u: 'carol', addedBy: 0, verifiedBy: 0, trustedBy: 1, coco: 3, socialTrusted: false });

    // carol's own token works too, and stages stay exclusive when a second
    // vouch sits mid-ladder (alice adds+verifies dave… use carol as voucher)
    await trustAndVerifyTargetStep2(app, tC);
    const bStats = await app.inject({ method: 'GET', url: '/api/users/bobby/stats', headers: { authorization: `Bearer ${tC}` } });
    assert.deepEqual(bStats.json(), { u: 'bobby', addedBy: 0, verifiedBy: 1, trustedBy: 0, coco: 1, socialTrusted: false });

    // unknown -> 404, counts never expose WHO
    assert.equal((await app.inject({ method: 'GET', url: '/api/users/nosuchuser/stats', headers: hB })).statusCode, 404);
  } finally {
    await teardown();
  }
});
