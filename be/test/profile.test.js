import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setupApp, makeClient, randomAesKey, nowEpoch } from './helpers.js';

const LIMITS = {
  signupIpLimit: 1000, challengeIpLimit: 1000, verifyAccountLimit: 1000, verifyIpLimit: 1000,
  friendsIpLimit: 1000, friendsChangeIpLimit: 1000, profileEditAccountLimit: 100,
};

async function signup(app, c, u) {
  const d = randomUUID();
  const a = randomAesKey();
  const t = nowEpoch();
  const res = await app.inject({ method: 'POST', url: '/api/signup', payload: { u, p: c.p, x: c.x, a, d, t, s: c.signSignup({ u, a, d, t }) } });
  assert.equal(res.statusCode, 201);
  const { n } = (await app.inject({ method: 'POST', url: '/api/auth/challenge', payload: { u, d } })).json();
  const ve = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { u, d, n, s: c.signBytes(Buffer.from(n, 'utf8')) } });
  return { token: ve.json().token, h: { authorization: `Bearer ${ve.json().token}` } };
}

// tiny valid JPEG (SOI + junk + EOI) for upload tests
const JPEG = Buffer.from([0xff, 0xd8, ...Buffer.from('x'.repeat(64)), 0xff, 0xd9]).toString('base64');

test('profile: bio limits, avatar validation, owner round-trip', async () => {
  const { app, teardown } = await setupApp(LIMITS);
  try {
    const { h } = await signup(app, makeClient(), 'palpha1');
    const bad = await app.inject({ method: 'PUT', url: '/api/me/profile', headers: h, payload: { bio: 'x'.repeat(251) } });
    assert.equal(bad.statusCode, 400);
    const junk = await app.inject({ method: 'PUT', url: '/api/me/profile', headers: h, payload: { avatar: Buffer.from('notajpeg').toString('base64') } });
    assert.equal(junk.statusCode, 400);

    const save = await app.inject({ method: 'PUT', url: '/api/me/profile', headers: h, payload: { bio: 'hi there', avatar: JPEG } });
    assert.equal(save.statusCode, 200);
    const mine = await app.inject({ method: 'GET', url: '/api/me/profile', headers: h });
    assert.equal(mine.json().bio, 'hi there');
    assert.ok(mine.json().avatar, 'owner always sees own avatar');
  } finally { await teardown(); }
});

test('profile: avatar visible ONLY on mutual add; vanishes on unfriend', async () => {
  const { app, teardown } = await setupApp(LIMITS);
  try {
    const a = await signup(app, makeClient(), 'paula');
    const b = await signup(app, makeClient(), 'bennet');
    await app.inject({ method: 'PUT', url: '/api/me/profile', headers: b.h, payload: { bio: 'bobby bio', avatar: JPEG } });

    // one-way: A adds B -> no avatar, but bio is public
    await app.inject({ method: 'PUT', url: '/api/me/friends/bennet', headers: a.h });
    let view = await app.inject({ method: 'GET', url: '/api/users/bennet/profile', headers: a.h });
    assert.equal(view.json().bio, 'bobby bio');
    assert.equal(view.json().avatar, null);

    // mutual: B adds A -> avatar appears
    await app.inject({ method: 'PUT', url: '/api/me/friends/paula', headers: b.h });
    view = await app.inject({ method: 'GET', url: '/api/users/bennet/profile', headers: a.h });
    assert.ok(view.json().avatar, 'mutual add unlocks the photo');

    // B unfriends A -> photo gone again (no cleanup: read-time rule)
    await app.inject({ method: 'DELETE', url: '/api/me/friends/paula', headers: b.h });
    view = await app.inject({ method: 'GET', url: '/api/users/bennet/profile', headers: a.h });
    assert.equal(view.json().avatar, null);
  } finally { await teardown(); }
});
