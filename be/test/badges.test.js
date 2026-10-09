import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setupApp, makeClient, randomAesKey, nowEpoch } from './helpers.js';
import { config } from '../src/config.js';

const LIMITS = {
  signupIpLimit: 1000,
  challengeIpLimit: 1000,
  verifyAccountLimit: 1000,
  verifyIpLimit: 1000,
  userKeysIpLimit: 1000,
};

async function signupUser(app, client, u, d = randomUUID()) {
  const a = randomAesKey();
  const t = nowEpoch();
  const res = await app.inject({
    method: 'POST', url: '/api/signup',
    payload: { u, p: client.p, x: client.x, a, d, t, s: client.signSignup({ u, a, d, t }) },
  });
  assert.equal(res.statusCode, 201, res.body);
  return d;
}

async function login(app, client, u) {
  const d = await signupUser(app, client, u);
  const n = (await app.inject({ method: 'POST', url: '/api/auth/challenge', payload: { u, d } })).json().n;
  const token = (await app.inject({
    method: 'POST', url: '/api/auth/verify',
    payload: { u, d, n, s: client.signBytes(Buffer.from(n, 'utf8')) },
  })).json().token;
  return { d, auth: { authorization: `Bearer ${token}` } };
}

const poll = (app, auth) => app.inject({ method: 'GET', url: '/api/me/badges', headers: auth });

// THE dispatch protocol (client contract): the GET is read-only; the app
// ACKs the gids only after the modal was actually dispatched — a poll whose
// response never rendered (tab died, socket raced login) must NOT silently
// consume the badge. This helper mimics a successful dispatch.
async function pollAndAck(app, auth) {
  const res = await poll(app, auth);
  const gids = res.json().new.map((b) => b.gid);
  if (gids.length) {
    const ack = await app.inject({
      method: 'POST', url: '/api/me/badges/ack', headers: auth, payload: { gids },
    });
    assert.equal(ack.statusCode, 200);
  }
  return res;
}

// The OG ten + Early Bird: awarded from the queue after signup, picked up on
// the client's next poll (login + periodic), acked exactly once.
test('badges: first ten get OG+EarlyBird, the next ones only EarlyBird', async () => {
  const { app, mongo, teardown } = await setupApp(LIMITS);
  try {
    const first = [];
    for (let i = 0; i < 11; i++) first.push(`early${i}`);
    const sessions = [];
    for (const u of first) sessions.push(await login(app, makeClient(), u));

    const held = (await poll(app, sessions[0].auth)).json();
    const ids = held.badges.map((b) => b.id).sort();
    assert.deepEqual(ids, ['earlybird', 'og'], 'rank-1 account earned both');
    // nobody auto-wears a badge any more — default is none
    assert.equal(held.displayBadge, null, 'no auto-wear');
    // read-only GET + explicit ack: `new` persists until DISPATCHED
    assert.equal(held.new.length, 2, 'first poll dispatches the fresh awards');
    assert.equal((await poll(app, sessions[0].auth)).json().new.length, 2, 'GET alone never acks');
    await pollAndAck(app, sessions[0].auth);
    assert.equal((await poll(app, sessions[0].auth)).json().new.length, 0, 'acked once shown');

    const eleventh = (await poll(app, sessions[10].auth)).json();
    assert.deepEqual(eleventh.badges.map((b) => b.id), ['earlybird'], '11th misses the OG cap');

    // caps are hard: exactly ten OG holders
    const ogHolders = await mongo.db.collection('users').countDocuments({ 'awards.og': { $exists: true } });
    assert.equal(ogHolders, config.ogBadgeCap ?? 10);
  } finally {
    await teardown();
  }
});

test('badges: CoCo score integrates badge points; admin award + display rules', async () => {
  // OG seats pre-filled to the cap (ogBadgeCap: 1) by the FIRST login below,
  // so every later OG must come through admin award — and hits the cap guard
  const cfg = { ...config, ...LIMITS, earlyBirdDeadline: '2000-01-01T00:00:00Z', ogBadgeCap: 1 };
  const ctx = await setupApp(cfg);
  const { app, mongo, teardown } = ctx;
  let admin = null;
  try {
    const db = mongo.db;
    const { default: adminUsers } = await import('../src/routes/admin-routes/users.js');
    const Fastify = (await import('fastify')).default;
    admin = Fastify({ logger: false });
    await admin.register(adminUsers, {
      users: db.collection('users'), redis: ctx.redis, config: cfg,
      messages: db.collection('messages'), idDocs: db.collection('id_docs'),
      profiles: db.collection('profiles'), settings: db.collection('settings'),
      diagnostics: db.collection('diagnostics'),
    });

    const first = await login(app, makeClient(), 'firstseed'); // takes the single OG seat
    const badgey = await login(app, makeClient(), 'badgey');    // no OG available
    const authB = { authorization: badgey.auth.authorization };
    assert.deepEqual((await poll(app, first.auth)).json().badges.map((b) => b.id), ['og']);
    assert.deepEqual((await poll(app, badgey.auth)).json().badges, [], 'rank-2 missed the capped OG');

    // overview route: full shapes (score + cap + fullness)
    const ov = (await admin.inject({ method: 'GET', url: '/api/admin/badges' })).json().badges;
    assert.equal(ov.find((b) => b.id === 'og').score, 10);
    assert.equal(ov.find((b) => b.id === 'og').cap, 1);
    assert.equal(ov.find((b) => b.id === 'og').full, true);
    assert.equal(ov.find((b) => b.id === 'premium').cap, null);

    // ADMIN award: cap full → honest 409…
    const denied = await admin.inject({ method: 'PUT', url: '/api/admin/users/badgey/badge', payload: { id: 'og' } });
    assert.equal(denied.statusCode, 409);
    assert.equal(denied.json().error, 'badge_full');
    // …and awarding the (uncapped-in-this-setup? no: earlybird deadline-passed but
    // admin awards bypass eligibility) Early Bird succeeds and dispatches
    const aw = await admin.inject({ method: 'PUT', url: '/api/admin/users/badgey/badge', payload: { id: 'earlybird' } });
    assert.equal(aw.statusCode, 200, aw.body);
    assert.equal(aw.json().awarded, true);
    const polled = (await poll(app, badgey.auth)).json();
    assert.equal(polled.badges[0].at, aw.json().at);
    assert.deepEqual(polled.new.map((b) => b.id), ['earlybird']);
    assert.equal(polled.displayBadge, null, 'awards never auto-wear');

    // score: badge points for viewers…
    let stats = (await app.inject({ method: 'GET', url: '/api/users/badgey/stats', headers: authB })).json();
    assert.equal(stats.coco, 3, 'earlybird only');
    // premium adds its badge-derived +5, exactly once
    await admin.inject({ method: 'PUT', url: '/api/admin/users/badgey/premium', payload: { premium: true } });
    stats = (await app.inject({ method: 'GET', url: '/api/users/badgey/stats', headers: authB })).json();
    assert.equal(stats.coco, 3 + (config.cocoPremiumBonus ?? 5));
    const prof = (await app.inject({ method: 'GET', url: '/api/users/badgey/profile', headers: authB })).json();
    assert.deepEqual(prof.badges.map((b) => b.id).sort(), ['earlybird', 'premium']);
    // self-view is easy — the profile sheet for OTHERS was the broken path
    const outsider = await login(app, makeClient(), 'outsider');
    const profTo = (await app.inject({
      method: 'GET', url: '/api/users/badgey/profile',
      headers: outsider.auth, // login() already returns the full header object
    })).json();
    assert.ok(Array.isArray(profTo.badges), JSON.stringify(profTo)); assert.deepEqual(profTo.badges.map((b) => b.id).sort(), ["earlybird", "premium"],
      'viewers other than the owner must see the badge list');
    assert.equal(profTo.displayBadge, null, 'badgey is unverified — chip hidden regardless of choice');

    // wearer choice: switch among held, reject not-held, explicit none sticks
    assert.equal((await app.inject({ method: 'PUT', url: '/api/me/profile', headers: badgey.auth, payload: { displayBadge: 'earlybird' } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/me/profile', headers: badgey.auth, payload: { displayBadge: 'og' } })).json().error, 'badge_not_held');
    assert.equal((await app.inject({ method: 'PUT', url: '/api/me/profile', headers: badgey.auth, payload: { displayBadge: '' } })).statusCode, 200);
    assert.equal((await poll(app, badgey.auth)).json().displayBadge, '');
    // a later award does NOT overwrite the explicit none
    await admin.inject({ method: 'PUT', url: '/api/admin/users/badgey/badge', payload: { id: 'premium' } }); // premium IS held → held:true
    await admin.inject({ method: 'PUT', url: '/api/admin/users/firstseed/badge', payload: { id: 'earlybird' } });
    // wearing is the user's own call — and only VISIBLE once verified
    await app.inject({ method: 'PUT', url: '/api/me/profile', headers: first.auth, payload: { displayBadge: 'og' } });
    assert.equal((await poll(app, first.auth)).json().displayBadge, 'og', 'stored choice persists across awards');
    const shownTo = (await app.inject({ method: 'GET', url: '/api/users/firstseed/profile', headers: badgey.auth })).json();
    assert.equal(shownTo.displayBadge, null, 'unverified accounts show no badge');
    await mongo.db.collection('users').updateOne({ ul: 'firstseed' }, { $set: { verified: true } });
    const shownAfter = (await app.inject({ method: 'GET', url: '/api/users/firstseed/profile', headers: badgey.auth })).json();
    assert.equal(shownAfter.displayBadge, 'og', 'verified + chosen = visible');
  } finally {
    if (admin) await admin.close();
    await teardown();
  }
});

test("badges: Teacher's Pet is admin-only (+1 CoCo), awardable and revocable", async () => {
  // ONE config for app + admin instance: the admin award route drains the
  // badge queue with ITS config object — defaults here would silently award
  // og/earlybird under production rules instead of these test overrides
  const cfg = { ...LIMITS, earlyBirdDeadline: '2000-01-01T00:00:00Z', ogBadgeCap: 0 };
  const ctx = await setupApp(cfg);
  const { app, mongo, teardown } = ctx;
  let admin = null;
  try {
    const { default: adminUsers } = await import('../src/routes/admin-routes/users.js');
    const Fastify = (await import('fastify')).default;
    admin = Fastify({ logger: false });
    admin.register(adminUsers, {
      users: mongo.db.collection('users'), redis: ctx.redis, config: cfg,
      messages: mongo.db.collection('messages'), idDocs: mongo.db.collection('id_docs'),
      profiles: mongo.db.collection('profiles'), settings: mongo.db.collection('settings'),
      diagnostics: mongo.db.collection('diagnostics'),
    });
    const petty = await login(app, makeClient(), 'petty');
    const viewer = await login(app, makeClient(), 'petview');

    // NO signup path ever awards it: capped badges are all ineligible here,
    // and teacherspet is mode 'admin' regardless
    assert.deepEqual((await poll(app, petty.auth)).json().badges, [], 'nothing auto-awards');

    // admin award → +1 point visible in stats, dispatched by next poll
    const aw = await admin.inject({ method: 'PUT', url: '/api/admin/users/petty/badge', payload: { id: 'teacherspet' } });
    assert.equal(aw.json().awarded, true, aw.body);
    const polled = (await poll(app, petty.auth)).json();
    assert.deepEqual(polled.new.map((b) => b.id), ['teacherspet'], 'modal will fire exactly once');
    assert.deepEqual(polled.badges.map((b) => b.id), ['teacherspet']);
    await pollAndAck(app, petty.auth); // modal shown → acked
    assert.equal((await poll(app, petty.auth)).json().new.length, 0, 'acked once shown');
    const stats = (await app.inject({
      method: 'GET', url: '/api/users/petty/stats',
      headers: { authorization: viewer.auth.authorization },
    })).json();
    assert.equal(stats.coco, 1, 'exactly +1 CoCo');

    // overview: awardable + auto flags surface admin-only vs earned badges
    const ov = (await admin.inject({ method: 'GET', url: '/api/admin/badges' })).json().badges;
    const tp = ov.find((b) => b.id === 'teacherspet');
    assert.equal(tp.awardable, true);
    assert.equal(tp.auto, false);
    assert.equal(tp.holders, 1);
    assert.equal(ov.find((b) => b.id === 'premium').awardable, false, 'premium stays a toggle');

    // revoke works and clears the worn chip if it was the chosen one
    await app.inject({ method: 'PUT', url: '/api/me/profile', headers: petty.auth, payload: { displayBadge: 'teacherspet' } });
    const rev = await admin.inject({ method: 'DELETE', url: '/api/admin/users/petty/badge/teacherspet' });
    assert.equal(rev.json().revoked, true);
    const after = (await poll(app, petty.auth)).json();
    assert.deepEqual(after.badges, []);
    assert.equal(after.displayBadge, null, 'worn revoked badge is cleared');
  } finally {
    if (admin) await admin.close();
    await teardown();
  }
});

// THE COUNTER BADGE: 'You've got mail' rides the shared evaluation on the
// client poll; the counter lives in its OWN username-keyed collection so a
// deleted-then-re-registered account keeps its progress (deleteAccountFully
// deliberately never touches counters).
test('badges: mail award at 5 sent; counter survives deletion + name re-use', async () => {
  const { app, mongo, teardown } = await setupApp({ ...LIMITS, ogBadgeCap: 0, earlyBirdCap: 0 });
  try {
    const sender = await login(app, makeClient(), 'sender');
    const auth = sender.auth;
    const d = sender.d;

    // below the target: poll evaluates and awards NOTHING
    await mongo.db.collection('counters').insertOne({ _id: 'sent:sender', n: 4 });
    let polled = (await poll(app, auth)).json();
    assert.deepEqual(polled.badges.map((b) => b.id), [], '4 messages: not yet');

    // reach the target -> the SHARED evaluation (this very poll) awards it
    await mongo.db.collection('counters').updateOne({ _id: 'sent:sender' }, { $set: { n: 5 } });
    polled = (await poll(app, auth)).json();
    assert.deepEqual(polled.badges.map((b) => b.id), ['mail'], '5 messages: awarded');
    assert.deepEqual(polled.new.map((b) => b.id), ['mail'], 'dispatched as new');
    assert.equal(polled.new[0].gid, polled.badges[0].gid, 'grant gid is stable until ack');
    await pollAndAck(app, auth);
    assert.equal((await poll(app, auth)).json().new.length, 0, 'acked once shown');

    // delete the account outright… then re-register the SAME name: the old
    // counter stands, so the first evaluation awards again (as a NEW grant)
    const del = await app.inject({ method: 'DELETE', url: `/api/devices/${d}`, headers: auth });
    assert.equal(del.json().accountDeleted, true);
    assert.equal(
      (await mongo.db.collection('counters').findOne({ _id: 'sent:sender' })).n, 5,
      'counter survives account deletion by design',
    );
    // login() signs up + authenticates in one step: the fresh identity on
    // the recycled username starts with the OLD counter already at 5
    const revived2 = await login(app, makeClient(), 'sender');
    const revived = (await poll(app, revived2.auth)).json();
    assert.deepEqual(revived.badges.map((b) => b.id), ['mail'], 'earned again on the kept counter');
    assert.equal(revived.new.length, 1, 'fresh grant dispatched');
  } finally {
    await teardown();
  }
});
