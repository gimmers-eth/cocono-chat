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
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), randomBytes(48)]);

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
  const { app, mongo, teardown } = await setupApp({ idDocMaxBytes: 128 });
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

    // content type + size guards
    const badType = await app.inject({
      method: 'POST', url: '/api/me/verify-id', headers: auth,
      payload: { contentType: 'image/svg+xml', data: b64uEncode(PNG_BYTES) },
    });
    assert.equal(badType.statusCode, 400);
    const tooBig = await app.inject({
      method: 'POST', url: '/api/me/verify-id', headers: auth,
      payload: { contentType: 'image/png', data: b64uEncode(randomBytes(129)) },
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
  const ctx = await setupApp();
  const admin = await adminApp(ctx);
  try {
    const c = makeClient();
    const a = await signupUser(ctx.app, c, 'admuser');
    const auth = { authorization: `Bearer ${await getToken(ctx.app, c, 'admuser', a.d)}` };
    await ctx.app.inject({
      method: 'POST', url: '/api/me/verify-id', headers: auth,
      payload: { contentType: 'image/jpeg', data: b64uEncode(PNG_BYTES) },
    });

    const list = await admin.inject({ method: 'GET', url: '/api/admin/users' });
    const row = list.json().find((u) => u.ul === 'admuser');
    assert.equal(row.verified, false);
    assert.equal(row.idDoc.contentType, 'image/jpeg');

    // view the photo (admin-only endpoint serves the raw bytes)
    const view = await admin.inject({ method: 'GET', url: '/api/admin/users/admuser/id-doc' });
    assert.equal(view.statusCode, 200);
    assert.equal(view.headers['content-type'], 'image/jpeg');
    assert.deepEqual(Buffer.from(view.rawPayload), PNG_BYTES);

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
