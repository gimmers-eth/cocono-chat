import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setupApp, makeClient, randomAesKey, nowEpoch } from './helpers.js';
import { config } from '../src/config.js';
import limitsAdmin from '../src/routes/admin-routes/limits.js';

const LIMITS = {
  signupIpLimit: 1000,
  challengeIpLimit: 1000,
  verifyAccountLimit: 1000,
  verifyIpLimit: 1000,
  friendsIpLimit: 1000,
  friendsChangeIpLimit: 1000,
};

async function signupUser(app, client, u, d = randomUUID()) {
  const a = randomAesKey();
  const t = nowEpoch();
  const s = client.signSignup({ u, a, d, t });
  const res = await app.inject({
    method: 'POST',
    url: '/api/signup',
    payload: { u, p: client.p, x: client.x, a, d, t, s },
  });
  assert.equal(res.statusCode, 201);
  return { a, d };
}

async function getToken(app, client, u, d) {
  const challenge = await app.inject({ method: 'POST', url: '/api/auth/challenge', payload: { u, d } });
  const { n } = challenge.json();
  const verify = await app.inject({
    method: 'POST',
    url: '/api/auth/verify',
    payload: { u, d, n, s: client.signBytes(Buffer.from(n, 'utf8')) },
  });
  assert.equal(verify.statusCode, 200);
  return verify.json().token;
}

const names = (list) => list.map((f) => f.u);

test('friends: signup anchors account identity key', async () => {
  const { app, mongo, teardown } = await setupApp(LIMITS);
  try {
    const client = makeClient();
    await signupUser(app, client, 'alice');
    const doc = await mongo.db.collection('users').findOne({ ul: 'alice' });
    assert.equal(doc.identity.p, client.p, 'identity.p is the founder device key');
    assert.ok(doc.identity.d);
  } finally {
    await teardown();
  }
});

test('friends: add binds the target identity (server-stamped), flags resolve', async () => {
  const { app, mongo, teardown } = await setupApp(LIMITS);
  try {
    const alice = makeClient();
    const bobby = makeClient();
    const a = await signupUser(app, alice, 'alice');
    await signupUser(app, bobby, 'bobby');
    const token = await getToken(app, alice, 'alice', a.d);
    const auth = { authorization: `Bearer ${token}` };

    // auth gate + empty list
    assert.equal((await app.inject({ method: 'GET', url: '/api/me/friends' })).statusCode, 401);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/me/friends', headers: auth })).json().friends, []);

    // add: entry carries the SERVER-stamped identity key, trusted
    const add = await app.inject({ method: 'PUT', url: '/api/me/friends/bobby', headers: auth });
    assert.equal(add.statusCode, 200);
    const [entry] = add.json().friends;
    assert.equal(entry.u, 'bobby');
    assert.equal(entry.p, bobby.p, 'binding equals bobby identity key');
    assert.equal(entry.trusted, true);
    assert.equal(entry.gone, false);
    assert.equal(entry.changed, false);

    // idempotent re-add keeps a single bound entry
    const again = await app.inject({ method: 'PUT', url: '/api/me/friends/bobby', headers: auth });
    assert.equal(again.json().friends.length, 1);

    // validation
    assert.equal((await app.inject({ method: 'PUT', url: '/api/me/friends/nosuchuser', headers: auth })).statusCode, 404);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/me/friends/alice', headers: auth })).statusCode, 400);

    // delete bobby's account -> flag gone (not silently dropped from the list)
    await mongo.db.collection('users').deleteOne({ ul: 'bobby' });
    const goneList = (await app.inject({ method: 'GET', url: '/api/me/friends', headers: auth })).json().friends;
    assert.equal(goneList[0].gone, true);
    assert.equal(goneList[0].trusted, false);

    // re-registration with a NEW key -> changed: binding no longer matches
    const bobby2 = makeClient();
    await signupUser(app, bobby2, 'bobby');
    const changed = (await app.inject({ method: 'GET', url: '/api/me/friends', headers: auth })).json().friends;
    assert.equal(changed[0].gone, false);
    assert.equal(changed[0].changed, true);
    assert.equal(changed[0].trusted, false, 're-registered account is NOT trusted');

    // explicit re-add RE-BINDS to the new identity
    const rebind = await app.inject({ method: 'PUT', url: '/api/me/friends/bobby', headers: auth });
    const bound = rebind.json().friends;
    assert.equal(bound.length, 1);
    assert.equal(bound[0].p, bobby2.p);
    assert.equal(bound[0].trusted, true);
    assert.equal(bound[0].changed, false);

    // remove clears
    const del = await app.inject({ method: 'DELETE', url: '/api/me/friends/bobby', headers: auth });
    assert.deepEqual(del.json().friends, []);
  } finally {
    await teardown();
  }
});

test('friends: legacy plain-string entries normalize to untrusted', async () => {
  const { app, mongo, teardown } = await setupApp(LIMITS);
  try {
    const alice = makeClient();
    const bobby = makeClient();
    const a = await signupUser(app, alice, 'alice');
    await signupUser(app, bobby, 'bobby');
    // simulate a pre-key-anchoring list
    await mongo.db.collection('users').updateOne({ ul: 'alice' }, { $set: { friends: ['bobby'] } });
    const token = await getToken(app, alice, 'alice', a.d);
    const list = (await app.inject({
      method: 'GET', url: '/api/me/friends', headers: { authorization: `Bearer ${token}` },
    })).json().friends;
    assert.equal(list[0].u, 'bobby');
    assert.equal(list[0].p, null);
    assert.equal(list[0].trusted, false, 'legacy entries are NOT trusted (strict policy)');
  } finally {
    await teardown();
  }
});

test('friends: cap enforced (friendsMax override)', async () => {
  const { app, teardown } = await setupApp({ ...LIMITS, friendsMax: 2 });
  try {
    const alice = makeClient();
    const others = ['friend1', 'friend2', 'friend3'].map((u) => ({ c: makeClient(), u }));
    for (const { c, u } of others) await signupUser(app, c, u);
    const a = await signupUser(app, alice, 'alice');
    const token = await getToken(app, alice, 'alice', a.d);
    const auth = { authorization: `Bearer ${token}` };

    assert.equal((await app.inject({ method: 'PUT', url: '/api/me/friends/friend1', headers: auth })).statusCode, 200);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/me/friends/friend2', headers: auth })).statusCode, 200);
    const full = await app.inject({ method: 'PUT', url: '/api/me/friends/friend3', headers: auth });
    assert.equal(full.statusCode, 409);
    assert.equal(full.json().error, 'friends_full');

    // re-adding an existing friend at the cap still succeeds (re-bind)
    const readd = await app.inject({ method: 'PUT', url: '/api/me/friends/friend1', headers: auth });
    assert.equal(readd.statusCode, 200);
    assert.deepEqual(names(readd.json().friends), ['friend1', 'friend2']);
  } finally {
    await teardown();
  }
});

test('account deletion purges the dead username from every friends list', async () => {
  const { app, teardown } = await setupApp(LIMITS);
  try {
    const alice = makeClient();
    const bobby = makeClient();
    const a = await signupUser(app, alice, 'alice');
    const b = await signupUser(app, bobby, 'bobby');
    const tokenA = await getToken(app, alice, 'alice', a.d);
    const tokenB = await getToken(app, bobby, 'bobby', b.d);

    const add = await app.inject({
      method: 'PUT', url: '/api/me/friends/bobby',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(add.json().friends[0].trusted, true);

    // bobby detaches his LAST device => account deleted outright
    const del = await app.inject({
      method: 'DELETE', url: `/api/devices/${b.d}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    assert.equal(del.json().accountDeleted, true);

    // alice's list is PURGED (not just flagged gone): a future owner of the
    // username can never inherit this trust, not even via a stale cache
    const list = await app.inject({
      method: 'GET', url: '/api/me/friends',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.deepEqual(list.json().friends, []);
  } finally {
    await teardown();
  }
});

test('deleted username can be RE-REGISTERED and re-bound (fresh identity)', async () => {
  const { app, teardown } = await setupApp(LIMITS);
  try {
    const alice = makeClient();
    const a = await signupUser(app, alice, 'alice');
    const tokenA = await getToken(app, alice, 'alice', a.d);
    const authA = { authorization: `Bearer ${tokenA}` };

    // first bobby: bind, then delete his account (last device detach)
    const b1 = makeClient();
    const b1d = await signupUser(app, b1, 'bobby');
    await app.inject({ method: 'PUT', url: '/api/me/friends/bobby', headers: authA });
    const tokenB1 = await getToken(app, b1, 'bobby', b1d.d);
    const del = await app.inject({
      method: 'DELETE', url: `/api/devices/${b1d.d}`,
      headers: { authorization: `Bearer ${tokenB1}` },
    });
    assert.equal(del.json().accountDeleted, true);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/me/friends', headers: authA })).json().friends, []);

    // same username re-registers cleanly with a NEW identity
    const b2 = makeClient();
    const re = await signupUser(app, b2, 'bobby');
    assert.ok(re.d, 'second bobby exists');

    // and alice can bind him again — fresh key, trusted
    const add2 = await app.inject({ method: 'PUT', url: '/api/me/friends/bobby', headers: authA });
    const e = add2.json().friends[0];
    assert.equal(e.trusted, true);
    assert.equal(e.p, b2.p, 'bound to the NEW identity, not the old ghost');
  } finally {
    await teardown();
  }
});

test('friends: verify + trust stages gate each other; rebind resets both', async () => {
  const { app, teardown } = await setupApp(LIMITS);
  try {
    const alice = makeClient();
    const bobby = makeClient();
    const a = await signupUser(app, alice, 'alice');
    const b = await signupUser(app, bobby, 'bobby');
    const tokenA = await getToken(app, alice, 'alice', a.d);
    const authA = { authorization: `Bearer ${tokenA}` };
    const tokenB = await getToken(app, bobby, 'bobby', b.d);
    const authB = { authorization: `Bearer ${tokenB}` };

    // stages need the add first
    assert.equal((await app.inject({ method: 'PUT', url: '/api/me/friends/bobby/verify',
      headers: authA, payload: { verified: true } })).statusCode, 404);

    await app.inject({ method: 'PUT', url: '/api/me/friends/bobby', headers: authA });

    // verification is a MUTUAL relation: a one-sided SET is rejected…
    const oneSided = await app.inject({ method: 'PUT', url: '/api/me/friends/bobby/verify',
      headers: authA, payload: { verified: true } });
    assert.equal(oneSided.statusCode, 409);
    assert.equal(oneSided.json().error, 'not_mutual');
    // …until bobby adds alice back
    await app.inject({ method: 'PUT', url: '/api/me/friends/alice', headers: authB });

    // trust requires verify (stage ladder is enforced server-side too)
    const earlyTrust = await app.inject({ method: 'PUT', url: '/api/me/friends/bobby/trust',
      headers: authA, payload: { trust: true } });
    assert.equal(earlyTrust.statusCode, 409);
    assert.equal(earlyTrust.json().error, 'stage_required');

    const v = await app.inject({ method: 'PUT', url: '/api/me/friends/bobby/verify',
      headers: authA, payload: { verified: true } });
    assert.equal(v.json().friends[0].verified, true);
    assert.equal(v.json().friends[0].trust, false);

    const t = await app.inject({ method: 'PUT', url: '/api/me/friends/bobby/trust',
      headers: authA, payload: { trust: true } });
    assert.equal(t.json().friends[0].trust, true);

    // un-verifying revokes trust automatically
    const un = await app.inject({ method: 'PUT', url: '/api/me/friends/bobby/verify',
      headers: authA, payload: { verified: false } });
    assert.equal(un.json().friends[0].verified, false);
    assert.equal(un.json().friends[0].trust, false);

    // re-trust, then RE-BIND (re-add) resets both stages
    await app.inject({ method: 'PUT', url: '/api/me/friends/bobby/verify', headers: authA, payload: { verified: true } });
    await app.inject({ method: 'PUT', url: '/api/me/friends/bobby/trust', headers: authA, payload: { trust: true } });
    const rebind = await app.inject({ method: 'PUT', url: '/api/me/friends/bobby', headers: authA });
    assert.equal(rebind.json().friends[0].verified, false, 'rebind resets verification');
    assert.equal(rebind.json().friends[0].trust, false, 'rebind resets trust');
  } finally {
    await teardown();
  }
});

test('friends: per-account verify/trust stage budgets (fvday/ftday) gate the endpoints', async () => {
  const ctx = await setupApp({
    ...LIMITS,
    friendVerifyDailyLimit: 2,
    friendTrustDailyLimit: 2,
  });
  const { app, redis, teardown } = ctx;
  try {
    const alice = makeClient();
    const bobby = makeClient();
    const a = await signupUser(app, alice, 'alice');
    const b = await signupUser(app, bobby, 'bobby');
    const authA = { authorization: `Bearer ${await getToken(app, alice, 'alice', a.d)}` };
    const authB = { authorization: `Bearer ${await getToken(app, bobby, 'bobby', b.d)}` };
    await app.inject({ method: 'PUT', url: '/api/me/friends/bobby', headers: authA });
    await app.inject({ method: 'PUT', url: '/api/me/friends/alice', headers: authB });

    const v = (on) => app.inject({ method: 'PUT', url: '/api/me/friends/bobby/verify',
      headers: authA, payload: { verified: on } });
    const t = (on) => app.inject({ method: 'PUT', url: '/api/me/friends/bobby/trust',
      headers: authA, payload: { trust: on } });

    // spend one verify, one trust; undoing neither spends nor refunds
    assert.equal((await v(true)).statusCode, 200); // fvday 1
    assert.equal((await t(true)).statusCode, 200); // ftday 1
    assert.equal((await t(false)).statusCode, 200);
    assert.equal((await v(false)).statusCode, 200);

    // an unverified entry cannot be trusted — and that rejection must NOT
    // consume the trust budget (impossible calls are free)
    const earlyTrust = await t(true);
    assert.equal(earlyTrust.statusCode, 409);
    assert.equal(earlyTrust.json().error, 'stage_required');
    assert.equal(await redis.get('rl:ftday:alice'), '1', 'stage_required did not spend ftday');

    // re-verify: spends the SECOND (final) daily verification
    assert.equal((await v(true)).statusCode, 200); // fvday 2 — budget spent
    // trust on the now-verified entry: allowed, spends the second trust
    assert.equal((await t(true)).statusCode, 200); // ftday 2

    // both budgets exhausted → stage_limited with human copy + retry-after
    const vCapped = await v(true);
    assert.equal(vCapped.statusCode, 429);
    assert.equal(vCapped.json().error, 'stage_limited');
    assert.match(vCapped.json().message, /Verification limit: 2 per day/);
    assert.ok(vCapped.headers['retry-after'], 'retry-after advertised');

    const tCapped = await t(true);
    assert.equal(tCapped.statusCode, 429);
    assert.match(tCapped.json().message, /Trust limit: 2 per day/);

    // the WEEKLY counters must not burn when the daily gate rejects first
    assert.equal(await redis.get('rl:fvweek:alice'), '2', 'fvweek saw only the 2 allowed calls');
    assert.equal(await redis.get('rl:ftweek:alice'), '2', 'ftweek likewise');
  } finally {
    await teardown();
  }
});

test('friends: ID-verified accounts get the bigger DAILY verify budget; the week is shared and unchanged', async () => {
  const ctx = await setupApp({
    ...LIMITS,
    friendVerifyDailyLimit: 1,
    friendVerifyDailyVerifiedLimit: 3,
    friendVerifyWeeklyLimit: 10,
  });
  const { app, mongo, redis, teardown } = ctx;
  try {
    const alice = makeClient();
    const bobby = makeClient();
    const a = await signupUser(app, alice, 'alice');
    const b = await signupUser(app, bobby, 'bobby');
    const authA = { authorization: `Bearer ${await getToken(app, alice, 'alice', a.d)}` };
    const authB = { authorization: `Bearer ${await getToken(app, bobby, 'bobby', b.d)}` };
    await app.inject({ method: 'PUT', url: '/api/me/friends/bobby', headers: authA });
    await app.inject({ method: 'PUT', url: '/api/me/friends/alice', headers: authB });

    const v = (on) => app.inject({ method: 'PUT', url: '/api/me/friends/bobby/verify',
      headers: authA, payload: { verified: on } });
    const limits = () => app.inject({ method: 'GET', url: '/api/me/stage-limits', headers: authA });

    // unverified: the SMALL daily budget applies (fvday, overridden to 1)
    assert.equal((await v(true)).statusCode, 200); // fvday 1 — spent
    const capped = await v(true); // attempts still consume (grinding gate)
    assert.equal(capped.statusCode, 429);
    assert.match(capped.json().message, /Verification limit: 1 per day/);
    assert.equal((await limits()).json().verifyDaily.limit, 1, 'display follows the same resolver');

    // admin flips alice to ID-verified (the users-doc flag the resolver reads)
    await mongo.db.collection('users').updateOne({ ul: 'alice' }, { $set: { verified: true } });
    const shown = (await limits()).json();
    assert.equal(shown.verifyDaily.limit, 3, 'verified account sees the fvdayv budget');
    assert.equal(shown.verifyWeekly.limit, 10, 'the WEEK is untouched by verification');
    assert.equal(shown.trustDaily.limit, config.friendTrustDailyLimit, 'trust budgets unchanged');

    // enforcement now charges fvdayv, NOT fvday: undoing is free, three
    // fresh verifications land, the fourth hits the verified-cap wording
    assert.equal((await v(false)).statusCode, 200);
    assert.equal((await v(true)).statusCode, 200);
    assert.equal((await v(false)).statusCode, 200);
    assert.equal((await v(true)).statusCode, 200);
    assert.equal((await v(false)).statusCode, 200);
    assert.equal((await v(true)).statusCode, 200);
    const vCapped = await v(true);
    assert.equal(vCapped.statusCode, 429);
    assert.match(vCapped.json().message, /Verification limit: 3 per day/, 'verified cap named');
    assert.equal(await redis.get('rl:fvday:alice'), '2', 'the unverified counter stands frozen');
    assert.equal(await redis.get('rl:fvdayv:alice'), '4', 'fvdayv charged (3 allowed + 1 capped attempt)');
    // the weekly counter is SHARED across the state flip: 4 allowed calls
    // spent it (1 unverified + 3 verified) — verification does not buy
    // extra WEEKLY vouching, exactly the point of keeping it at 10
    assert.equal(await redis.get('rl:fvweek:alice'), '4');
  } finally {
    await teardown();
  }
});

test('friends: GET /api/me/stage-limits reports own budgets, spend, and admin tuning', async () => {
  const { app, mongo, teardown } = await setupApp(LIMITS);
  await app.register(limitsAdmin, { config, settings: mongo.db.collection('settings') });
  try {
    const alice = makeClient();
    const bobby = makeClient();
    const a = await signupUser(app, alice, 'alice');
    const b = await signupUser(app, bobby, 'bobby');
    const authA = { authorization: `Bearer ${await getToken(app, alice, 'alice', a.d)}` };
    const authB = { authorization: `Bearer ${await getToken(app, bobby, 'bobby', b.d)}` };

    const fresh = (await app.inject({ method: 'GET', url: '/api/me/stage-limits', headers: authA })).json();
    assert.equal(fresh.verifyDaily.limit, 4);
    assert.equal(fresh.verifyDaily.used, 0);

    await app.inject({ method: 'PUT', url: '/api/me/friends/bobby', headers: authA });
    await app.inject({ method: 'PUT', url: '/api/me/friends/alice', headers: authB });
    await app.inject({ method: 'PUT', url: '/api/me/friends/bobby/verify', headers: authA, payload: { verified: true } });
    await app.inject({ method: 'PUT', url: '/api/me/friends/bobby/trust', headers: authA, payload: { trust: true } });

    const spent = (await app.inject({ method: 'GET', url: '/api/me/stage-limits', headers: authA })).json();
    assert.equal(spent.verifyDaily.used, 1);
    assert.equal(spent.verifyWeekly.used, 1);
    assert.equal(spent.trustDaily.used, 1);
    assert.ok(spent.verifyDaily.resetInSec > 0, 'window countdown present');

    // undoing is free: spend stays (no refund), nothing new is consumed
    await app.inject({ method: 'PUT', url: '/api/me/friends/bobby/verify', headers: authA, payload: { verified: false } });
    const undone = (await app.inject({ method: 'GET', url: '/api/me/stage-limits', headers: authA })).json();
    assert.equal(undone.verifyDaily.used, 1);

    // admin per-user tuning is visible on the SAME numbers the user sees
    await app.inject({
      method: 'PATCH', url: '/api/admin/limits',
      payload: { name: 'fvday', user: 'alice', value: { limit: 9 } },
    });
    const tuned = (await app.inject({ method: 'GET', url: '/api/me/stage-limits', headers: authA })).json();
    assert.equal(tuned.verifyDaily.limit, 9);
    assert.equal(tuned.verifyDaily.used, 1, 'spend survives the re-limit');

    // requires auth
    assert.equal((await app.inject({ method: 'GET', url: '/api/me/stage-limits' })).statusCode, 401);
  } finally {
    await teardown();
  }
});
