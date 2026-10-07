import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setupApp, makeClient, randomAesKey, nowEpoch } from './helpers.js';

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
