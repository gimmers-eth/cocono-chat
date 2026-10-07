import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setupApp, makeClient, randomAesKey, nowEpoch } from './helpers.js';
import { canonical } from '../src/lib/canon.js';

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

test('friends: auth required, add/list/remove round-trip, validation', async () => {
  const { app, teardown } = await setupApp(LIMITS);
  try {
    const alice = makeClient();
    const bob = makeClient();
    const a = await signupUser(app, alice, 'alice');
    await signupUser(app, bob, 'bobby');
    const token = await getToken(app, alice, 'alice', a.d);
    const auth = { authorization: `Bearer ${token}` };

    // no token -> 401 on every friends endpoint
    assert.equal((await app.inject({ method: 'GET', url: '/api/me/friends' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/me/friends/bobby' })).statusCode, 401);

    // empty list, then add bob
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/me/friends', headers: auth })).json().friends, []);
    const add = await app.inject({ method: 'PUT', url: '/api/me/friends/bobby', headers: auth });
    assert.equal(add.statusCode, 200);
    assert.deepEqual(add.json().friends, ['bobby']);

    // idempotent re-add
    const again = await app.inject({ method: 'PUT', url: '/api/me/friends/bobby', headers: auth });
    assert.deepEqual(again.json().friends, ['bobby']);

    // validation: unknown user, self, garbage
    assert.equal((await app.inject({ method: 'PUT', url: '/api/me/friends/nosuchuser', headers: auth })).statusCode, 404);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/me/friends/alice', headers: auth })).statusCode, 400);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/me/friends/ab', headers: auth })).statusCode, 400);

    // case-insensitive target (URL has uppercase; stored lowercase)
    const caps = await app.inject({ method: 'PUT', url: '/api/me/friends/BOBBY', headers: auth });
    assert.deepEqual(caps.json().friends, ['bobby']);

    // one-way trust: alice's list only — bob must NOT suddenly trust alice
    const aliceList = await app.inject({ method: 'GET', url: '/api/me/friends', headers: auth });
    assert.deepEqual(aliceList.json().friends, ['bobby']);

    // remove
    const del = await app.inject({ method: 'DELETE', url: '/api/me/friends/bobby', headers: auth });
    assert.equal(del.statusCode, 200);
    assert.deepEqual(del.json().friends, []);
  } finally {
    await teardown();
  }
});

test('friends: cap enforced (friendsMax override)', async () => {
  const { app, teardown } = await setupApp({ ...LIMITS, friendsMax: 2 });
  try {
    const alice = makeClient();
    const others = ['friend1', 'friend2', 'friend3'].map((u) => { const c = makeClient(); return { c, u }; });
    for (const { c, u } of others) await signupUser(app, c, u);
    const a = await signupUser(app, alice, 'alice');
    const token = await getToken(app, alice, 'alice', a.d);
    const auth = { authorization: `Bearer ${token}` };

    assert.equal((await app.inject({ method: 'PUT', url: '/api/me/friends/friend1', headers: auth })).statusCode, 200);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/me/friends/friend2', headers: auth })).statusCode, 200);
    const full = await app.inject({ method: 'PUT', url: '/api/me/friends/friend3', headers: auth });
    assert.equal(full.statusCode, 409);
    assert.equal(full.json().error, 'friends_full');

    // still allowed to re-add an existing friend at cap (idempotent)
    const readd = await app.inject({ method: 'PUT', url: '/api/me/friends/friend1', headers: auth });
    assert.equal(readd.statusCode, 200);
    assert.deepEqual(readd.json().friends, ['friend1', 'friend2']);
  } finally {
    await teardown();
  }
});
