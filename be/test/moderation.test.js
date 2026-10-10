// STAFF MODERATION: the malicious-user TIMEOUT and the BAN
// (be/src/lib/moderation.js + admin PUT /api/admin/users/:ul/moderation).
// Timeout = "act like an unverified user" + danger marks for everyone +
// -1000 CoCo while the clock runs (expiry DERIVED from timeoutUntil — the
// stored `verified` flag is never touched). Ban = platform use refused,
// account data intact. Remaining time is ADMIN-ONLY.

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { setupApp, makeClient, randomAesKey, nowEpoch } from './helpers.js';
import { config } from '../src/config.js';
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

function adminApp(ctx) {
  return (async () => {
    const admin = Fastify({ logger: false });
    await admin.register(adminRoutes, {
      users: ctx.mongo.db.collection('users'),
      redis: ctx.redis,
      config,
      diagnostics: ctx.mongo.db.collection('diagnostics'),
      reports: ctx.mongo.db.collection('reports'),
      settings: ctx.mongo.db.collection('settings'),
      messages: ctx.mongo.db.collection('messages'),
      idDocs: ctx.mongo.db.collection('id_docs'),
      profiles: ctx.mongo.db.collection('profiles'),
      counters: ctx.mongo.db.collection('counters'),
      shares: ctx.mongo.db.collection('shares'),
      contacts: ctx.mongo.db.collection('contacts'),
      graph: ctx.mongo.db.collection('graph'),
    });
    return admin;
  })();
}

const putMod = (admin, ul, body) => admin.inject({
  method: 'PUT', url: `/api/admin/users/${ul}/moderation`, payload: body,
});

test('timeout: acts unverified, flags every client read, takes -1000 CoCo; clearing returns everything', async () => {
  const { app, mongo, redis, teardown } = await setupApp();
  const admin = await adminApp({ mongo, redis });
  const users = mongo.db.collection('users');
  try {
    // victim of nothing — a clean account WITH reputation: verified by the
    // admin, trusted by two verified vouchers
    const sus = makeClient();
    const s = await signupUser(app, sus, 'suspected');
    const hS = { authorization: `Bearer ${await getToken(app, sus, 'suspected', s.d)}` };
    await users.updateOne({ ul: 'suspected' }, { $set: { verified: true } });
    for (const name of ['vouchar1', 'vouchar2']) {
      const vc = makeClient();
      const v = await signupUser(app, vc, name);
      const hV = { authorization: `Bearer ${await getToken(app, vc, name, v.d)}` };
      await users.updateOne({ ul: name }, { $set: {
        verified: true,
        friends: [{ u: 'suspected', p: 'x', v: true, t: true }],
      } });
      void hV;
    }
    const before = (await app.inject({ method: 'GET', url: '/api/users/suspected/stats', headers: hS })).json();
    // two trusted verified vouches (6) plus whatever signup badges awarded —
    // the test asserts the DELTA, never the badge-dependent baseline
    assert.ok(before.coco >= 6, `baseline reputation built (got ${before.coco})`);
    assert.equal(before.malicious, false);
    assert.equal(before.banned, false);

    // the OWNER sees their verification before the timeout
    const me0 = (await app.inject({ method: 'GET', url: '/api/me', headers: hS })).json();
    assert.equal(me0.verified, true);

    // ---- admin applies a 7-day timeout ----
    const put = await putMod(admin, 'suspected', { timeoutDays: 7 });
    assert.equal(put.statusCode, 200, put.body);
    const state = put.json();
    assert.equal(state.malicious, true);
    assert.ok(state.timeoutRemainingSec > 6 * 86400 && state.timeoutRemainingSec <= 7 * 86400);
    const doc = await users.findOne({ ul: 'suspected' });
    assert.equal(doc.verified, true, 'stored verified flag is UNTOUCHED (derived expiry)');
    assert.ok(doc.timeoutUntil instanceof Date);

    // ...every client read now treats the account as UNVERIFIED + malicious
    const me = (await app.inject({ method: 'GET', url: '/api/me', headers: hS })).json();
    assert.equal(me.verified, false, 'the account sees itself unverified while timed out');
    const keys = (await app.inject({ method: 'GET', url: '/api/users/suspected/keys', headers: hS })).json();
    assert.equal(keys.verified, false);
    assert.equal(keys.malicious, true, 'danger mark for everyone');
    assert.equal(keys.banned, false);
    const prof = (await app.inject({ method: 'GET', url: '/api/users/suspected/profile', headers: hS })).json();
    assert.equal(prof.malicious, true);
    const stats = (await app.inject({ method: 'GET', url: '/api/users/suspected/stats', headers: hS })).json();
    assert.equal(stats.coco, before.coco - 1000, 'timeout costs exactly the -1000 CoCo penalty');
    assert.equal(stats.socialTrusted, false);
    assert.equal(stats.malicious, true);
    // NO CLOCK LEAKS: flags only — never timeoutUntil / remaining time
    assert.equal('timeoutUntil' in stats, false);
    assert.equal('timeoutUntil' in keys, false);
    assert.equal('timeoutUntil' in prof, false);
    assert.equal('timeoutRemainingSec' in keys, false);

    // unexpired-but-lapsed timeout = behaves as cleared (derived expiry)
    await users.updateOne({ ul: 'suspected' }, { $set: { timeoutUntil: new Date(Date.now() - 1000) } });
    const lapsed = (await app.inject({ method: 'GET', url: '/api/users/suspected/keys', headers: hS })).json();
    assert.equal(lapsed.verified, true, 'a lapsed timeout silently returns the verification');
    assert.equal(lapsed.malicious, false);

    // a live one again, then CLEARED by the admin
    await putMod(admin, 'suspected', { timeoutDays: 1 });
    const clear = await putMod(admin, 'suspected', { timeoutDays: null });
    assert.equal(clear.statusCode, 200);
    assert.equal(clear.json().malicious, false);
    assert.equal(clear.json().timeoutUntil, null);
    const after = (await app.inject({ method: 'GET', url: '/api/users/suspected/stats', headers: hS })).json();
    assert.equal(after.coco, before.coco, 'the penalty expires with the timeout');
    assert.equal(after.malicious, false);

    // ---- admin listing carries the REMAINING TIME (admin-only surface) ----
    await putMod(admin, 'suspected', { timeoutDays: 30 });
    const rows = (await admin.inject({ method: 'GET', url: '/api/admin/users' })).json();
    const row = rows.find((r) => r.ul === 'suspected');
    assert.equal(row.malicious, true);
    assert.ok(row.timeoutRemainingSec > 29 * 86400, 'remaining time is live in the admin listing');
    assert.ok(new Date(row.timeoutUntil).getTime() > Date.now());
  } finally {
    await admin.close();
    await teardown();
  }
});

test('ban: platform use refused (API + login), data intact, unban resumes', async () => {
  const { app, mongo, redis, teardown } = await setupApp();
  const admin = await adminApp({ mongo, redis });
  const users = mongo.db.collection('users');
  try {
    const c = makeClient();
    const a = await signupUser(app, c, 'banneduser');
    const auth = { authorization: `Bearer ${await getToken(app, c, 'banneduser', a.d)}` };
    assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: auth })).statusCode, 200);

    const ban = await putMod(admin, 'banneduser', { banned: true });
    assert.equal(ban.statusCode, 200);
    assert.equal(ban.json().banned, true);
    assert.ok(ban.json().bannedAt, 'ban is stamped');

    // every authenticated call is refused — the BAN fix in the bearer hook
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: auth });
    assert.equal(me.statusCode, 403);
    assert.equal(me.json().error, 'account_banned');
    const friends = await app.inject({ method: 'GET', url: '/api/me/friends', headers: auth });
    assert.equal(friends.statusCode, 403, 'the whole authenticated surface is locked');

    // login is refused too (fresh challenge + verify)
    const { n } = (await app.inject({ method: 'POST', url: '/api/auth/challenge', payload: { u: 'banneduser', d: a.d } })).json();
    const ve = await app.inject({
      method: 'POST', url: '/api/auth/verify',
      payload: { u: 'banneduser', d: a.d, n, s: c.signBytes(Buffer.from(n, 'utf8')) },
    });
    assert.equal(ve.statusCode, 403);
    assert.equal(ve.json().error, 'account_banned');

    // ACCOUNT DATA INTACT: the doc, its device and the flags all survive
    const doc = await users.findOne({ ul: 'banneduser' });
    assert.ok(doc.devices.length === 1, 'devices untouched');
    assert.equal(doc.banned, true);

    // OTHER users still see the account — with the ban marks (warning icon
    // + staff notice come from these flags client-side)
    const watcher = makeClient();
    const w = await signupUser(app, watcher, 'watcher');
    const hW = { authorization: `Bearer ${await getToken(app, watcher, 'watcher', w.d)}` };
    const keys = (await app.inject({ method: 'GET', url: '/api/users/banneduser/keys', headers: hW })).json();
    assert.equal(keys.banned, true);
    assert.equal(keys.malicious, false);

    // unban: exactly where it stopped
    const unban = await putMod(admin, 'banneduser', { banned: false });
    assert.equal(unban.statusCode,200);
    assert.equal(unban.json().banned, false);
    const me2 = await app.inject({ method: 'GET', url: '/api/me', headers: auth });
    assert.equal(me2.statusCode, 200, 'unban resumes the session with nothing rebuilt');
  } finally {
    await admin.close();
    await teardown();
  }
});

test('moderation route guards: validation + unknown account', async () => {
  const { app, mongo, redis, teardown } = await setupApp();
  const admin = await adminApp({ mongo, redis });
  try {
    const c = makeClient();
    await signupUser(app, c, 'guarduser');
    assert.equal((await putMod(admin, 'guarduser', {})).statusCode, 400);
    assert.equal((await putMod(admin, 'guarduser', { timeoutDays: 0 })).statusCode, 400);
    assert.equal((await putMod(admin, 'guarduser', { timeoutDays: 1.5 })).statusCode, 400);
    assert.equal((await putMod(admin, 'guarduser', { timeoutDays: 36501 })).statusCode, 400);
    assert.equal((await putMod(admin, 'guarduser', { banned: 'yes' })).statusCode, 400);
    assert.equal((await putMod(admin, 'nosuchuser', { banned: true })).statusCode, 404);
    // the presets the panel offers are all valid
    for (const days of [1, 7, 30, 36500]) {
      assert.equal((await putMod(admin, 'guarduser', { timeoutDays: days })).statusCode, 200, `${days}d preset accepted`);
    }
  } finally {
    await admin.close();
    await teardown();
  }
});

test('timeout also drops the bigger verify budget (fvdayv needs EFFECTIVE verified)', async () => {
  const { app, mongo, redis, teardown } = await setupApp();
  const admin = await adminApp({ mongo, redis });
  const users = mongo.db.collection('users');
  try {
    const c = makeClient();
    const a = await signupUser(app, c, 'verifier');
    const auth = { authorization: `Bearer ${await getToken(app, c, 'verifier', a.d)}` };
    await users.updateOne({ ul: 'verifier' }, { $set: { verified: true } });
    const stage = async () => (await app.inject({ method: 'GET', url: '/api/me/stage-limits', headers: auth })).json();
    const clean = await stage();
    // un-timed-out verified: the verified daily budget (fvdayv) is the
    // bigger one; the timeout drops it to the unverified tier (fvday)
    await putMod(admin, 'verifier', { timeoutDays: 7 });
    const timed = await stage();
    assert.ok(timed.verifyDaily.limit < clean.verifyDaily.limit,
      `timed-out verifier falls to the unverified budget (${clean.verifyDaily.limit} -> ${timed.verifyDaily.limit})`);
  } finally {
    await admin.close();
    await teardown();
  }
});
