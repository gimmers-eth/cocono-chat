import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { setupApp, makeClient, randomAesKey, nowEpoch } from './helpers.js';
import { config } from '../src/config.js';
import adminUsers from '../src/routes/admin-routes/users.js';

const LIMITS = {
  // badge awards would shift CoCo numbers — these files test the vouch math
  earlyBirdDeadline: '2000-01-01T00:00:00Z',
  ogBadgeCap: 0, // badge points would shift the vouch math under test
  signupIpLimit: 1000,
  challengeIpLimit: 1000,
  verifyAccountLimit: 1000,
  verifyIpLimit: 1000,
  userKeysIpLimit: 1000,
  friendsIpLimit: 1000,
  friendsChangeIpLimit: 1000,
  deviceEnrollIpLimit: 1000,
  deviceApproveAccountLimit: 1000,
  enrollStatusIpLimit: 1000,
};

async function signupUser(app, client, u, d = randomUUID()) {
  const a = randomAesKey();
  const t = nowEpoch();
  const s = client.signSignup({ u, a, d, t });
  const res = await app.inject({
    method: 'POST', url: '/api/signup',
    payload: { u, p: client.p, x: client.x, a, d, t, s },
  });
  assert.equal(res.statusCode, 201, res.body);
  return { a, d };
}

async function getToken(app, client, u, d) {
  const challenge = await app.inject({ method: 'POST', url: '/api/auth/challenge', payload: { u, d } });
  const { n } = challenge.json();
  const verify = await app.inject({
    method: 'POST', url: '/api/auth/verify',
    payload: { u, d, n, s: client.signBytes(Buffer.from(n, 'utf8')) },
  });
  return verify.json().token;
}

const enroll = (app, client, u, d) => {
  const a = randomAesKey();
  const t = nowEpoch();
  const s = client.signSignup({ u, a, d, t });
  return app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { u, p: client.p, x: client.x, a, d, t, s } });
};

// Shipped policy defaults: 1 unverified / 2 verified / 5 premium, override wins.
test('device policy: tiers follow account state, override beats everything', async () => {
  const { app, mongo, teardown } = await setupApp(LIMITS);
  try {
    const main = makeClient();
    await signupUser(app, main, 'alice', 'alice-dev-0001');
    const token = await getToken(app, main, 'alice', 'alice-dev-0001');
    const auth = { authorization: `Bearer ${token}` };
    const users = mongo.db.collection('users');
    const devices = () => app.inject({ method: 'GET', url: '/api/devices', headers: auth });

    // unverified: the SECOND device is refused at enroll time
    const e1 = await enroll(app, makeClient(), 'alice', 'alice-dev-0002');
    assert.equal(e1.statusCode, 409);
    assert.equal(e1.json().error, 'device_limit');
    assert.equal((await devices()).json().maxDevices, 1, 'displayed cap is the effective one');

    // verified → 2: second device joins, third refused
    await users.updateOne({ ul: 'alice' }, { $set: { verified: true } });
    const e2 = await enroll(app, makeClient(), 'alice', 'alice-dev-0002');
    assert.equal(e2.statusCode, 201, e2.body);
    assert.equal((await app.inject({
      method: 'POST', url: '/api/devices/approve', headers: auth, payload: { code: e2.json().code },
    })).statusCode, 200);
    assert.equal((await enroll(app, makeClient(), 'alice', 'alice-dev-0003')).statusCode, 409);

    // premium → 5: third device joins
    await users.updateOne({ ul: 'alice' }, { $set: { premium: true } });
    const e3 = await enroll(app, makeClient(), 'alice', 'alice-dev-0003');
    assert.equal(e3.statusCode, 201, e3.body);
    assert.equal((await app.inject({
      method: 'POST', url: '/api/devices/approve', headers: auth, payload: { code: e3.json().code },
    })).statusCode, 200);
    assert.equal((await devices()).json().maxDevices, 5);

    // admin override beats premium DOWN: now at 3 devices, a 4th may still
    // join (3 < 4) but a 5th cannot — the premium tier would have allowed it
    await users.updateOne({ ul: 'alice' }, { $set: { maxDevicesOverride: 4 } });
    assert.equal((await devices()).json().maxDevices, 4);
    const e4 = await enroll(app, makeClient(), 'alice', 'alice-dev-0004');
    assert.equal(e4.statusCode, 201, e4.body);
    assert.equal((await app.inject({
      method: 'POST', url: '/api/devices/approve', headers: auth, payload: { code: e4.json().code },
    })).statusCode, 200);
    assert.equal((await enroll(app, makeClient(), 'alice', 'alice-dev-0005')).statusCode, 409,
      'override 4 caps below premium 5');
  } finally {
    await teardown();
  }
});

test('premium: admin toggle exposes the flag to app + admin; max-devices is now an override', async () => {
  const ctx = await setupApp(LIMITS);
  const { app, mongo, redis, teardown } = ctx;
  const db = mongo.db;
  await app.register(adminUsers, {
    users: db.collection('users'),
    redis,
    // SAME merge the app runs with (setupApp LIMITS included) — the badge
    // evaluation inside the premium toggle reads caps from THIS config; the
    // raw singleton ignored the file's disabled-badge limits
    config: { ...config, coldSendRequiresVerification: false, ...LIMITS },
    messages: db.collection('messages'),
    idDocs: db.collection('id_docs'),
    profiles: db.collection('profiles'),
    settings: db.collection('settings'),
    diagnostics: db.collection('diagnostics'),
  });
  try {
    const alice = makeClient();
    const bobby = makeClient();
    const a = await signupUser(app, alice, 'alice');
    const b = await signupUser(app, bobby, 'bobby');
    const authA = { authorization: `Bearer ${await getToken(app, alice, 'alice', a.d)}` };
    const authB = { authorization: `Bearer ${await getToken(app, bobby, 'bobby', b.d)}` };

    const on = await app.inject({ method: 'PUT', url: '/api/admin/users/alice/premium', payload: { premium: true } });
    assert.equal(on.statusCode, 200);
    assert.equal(on.json().premium, true);

    // the app learns it via /api/me…
    const me = (await app.inject({ method: 'GET', url: '/api/me', headers: authA })).json();
    assert.equal(me.premium, true);
    // …and peers via profile views + key lookups
    const prof = (await app.inject({ method: 'GET', url: '/api/users/alice/profile', headers: authB })).json();
    assert.equal(prof.premium, true);
    const keys = (await app.inject({ method: 'GET', url: '/api/users/alice/keys', headers: authB })).json();
    assert.equal(keys.premium, true);

    // PREMIUM lifts CoCo reputation by the flat bonus — premium is ON right
    // now (toggled at the top of this test), so drop it and compare
    const statsPrem = (await app.inject({ method: 'GET', url: '/api/users/alice/stats', headers: authB })).json();
    assert.equal(statsPrem.coco, config.cocoPremiumBonus ?? 5, 'premium adds the flat +5');
    assert.equal(statsPrem.premium, true);
    await app.inject({ method: 'PUT', url: '/api/admin/users/alice/premium', payload: { premium: false } });
    const statsPlain = (await app.inject({ method: 'GET', url: '/api/users/alice/stats', headers: authB })).json();
    assert.equal(statsPlain.coco, 0, 'no vouches, no premium → zero');
    assert.equal(statsPlain.premium, false);
    await app.inject({ method: 'PUT', url: '/api/admin/users/alice/premium', payload: { premium: true } });

    // admin rows carry the flag + the policy-derived cap
    let row = (await app.inject({ method: 'GET', url: '/api/admin/users' })).json().find((u) => u.ul === 'alice');
    assert.equal(row.premium, true);
    assert.equal(row.maxDevices, 5, 'premium cap');

    // max-devices PATCH now WRITES AN OVERRIDE…
    await app.inject({ method: 'PATCH', url: '/api/admin/users/alice/max-devices', payload: { maxDevices: 9 } });
    row = (await app.inject({ method: 'GET', url: '/api/admin/users' })).json().find((u) => u.ul === 'alice');
    assert.equal(row.maxDevices, 9);
    assert.equal(row.maxDevicesOverride, 9);
    // …and null falls back to the policy tier
    await app.inject({ method: 'PATCH', url: '/api/admin/users/alice/max-devices', payload: { maxDevices: null } });
    row = (await app.inject({ method: 'GET', url: '/api/admin/users' })).json().find((u) => u.ul === 'alice');
    assert.equal(row.maxDevices, 5);
    assert.equal(row.maxDevicesOverride, null);

    // premium off → verified tier… alice is NOT verified → 1
    await app.inject({ method: 'PUT', url: '/api/admin/users/alice/premium', payload: { premium: false } });
    row = (await app.inject({ method: 'GET', url: '/api/admin/users' })).json().find((u) => u.ul === 'alice');
    assert.equal(row.maxDevices, 1);

    assert.equal((await app.inject({ method: 'PUT', url: '/api/admin/users/alice/premium', payload: {} })).statusCode, 400);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/admin/users/nosuchuser/premium', payload: { premium: true } })).statusCode, 404);
  } finally {
    await teardown();
  }
});

test('relationships endpoint maps both directions with the app-matching gates', async () => {
  const ctx = await setupApp(LIMITS);
  const { app, mongo, redis, teardown } = ctx;
  const db = mongo.db;
  await app.register(adminUsers, {
    users: db.collection('users'), redis, config,
    messages: db.collection('messages'), idDocs: db.collection('id_docs'),
    profiles: db.collection('profiles'), settings: db.collection('settings'),
    diagnostics: db.collection('diagnostics'),
  });
  try {
    const alice = makeClient();
    const bobby = makeClient();
    const carol = makeClient();
    const a = await signupUser(app, alice, 'alice');
    const b = await signupUser(app, bobby, 'bobby');
    await signupUser(app, carol, 'carol');
    const authA = { authorization: `Bearer ${await getToken(app, alice, 'alice', a.d)}` };
    const authB = { authorization: `Bearer ${await getToken(app, bobby, 'bobby', b.d)}` };

    // alice adds bobby, verifies+trusts him once MUTUAL; carol never connects
    await app.inject({ method: 'PUT', url: '/api/me/friends/bobby', headers: authA });
    let rel = (await app.inject({ method: 'GET', url: '/api/admin/users/alice/relationships', headers: authA })).json().relationships;
    let bRow = rel.find((r) => r.ul === 'bobby');
    assert.equal(bRow.added, true);
    assert.equal(bRow.verified, false, 'one-sided add cannot be verified (mutuality gate)');

    await app.inject({ method: 'PUT', url: '/api/me/friends/alice', headers: authB });
    await app.inject({ method: 'PUT', url: '/api/me/friends/bobby/verify', headers: authA, payload: { verified: true } });
    await app.inject({ method: 'PUT', url: '/api/me/friends/bobby/trust', headers: authA, payload: { trust: true } });

    rel = (await app.inject({ method: 'GET', url: '/api/admin/users/alice/relationships' })).json().relationships;
    bRow = rel.find((r) => r.ul === 'bobby');
    assert.deepEqual(
      { added: bRow.added, theyAddedMe: bRow.theyAddedMe, verified: bRow.verified, trust: bRow.trust },
      { added: true, theyAddedMe: true, verified: true, trust: true },
    );
    assert.ok(!rel.some((r) => r.ul === 'carol'), 'unrelated accounts are omitted');

    // reverse view: bobby added alice but never verified her
    const bRel = (await app.inject({ method: 'GET', url: '/api/admin/users/bobby/relationships' })).json().relationships;
    const aRow = bRel.find((r) => r.ul === 'alice');
    assert.deepEqual({ added: aRow.added, verified: aRow.verified }, { added: true, verified: false });
  } finally {
    await teardown();
  }
});
