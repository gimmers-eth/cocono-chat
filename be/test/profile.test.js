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
  return { h: { authorization: `Bearer ${ve.json().token}` } };
}

const JPEG = Buffer.from([0xff, 0xd8, ...Buffer.from('x'.repeat(64)), 0xff, 0xd9]).toString('base64');

test('profile: bio limits, avatar validation, owner round-trip', async () => {
  const { app, teardown } = await setupApp(LIMITS);
  try {
    const { h } = await signup(app, makeClient(), 'palpha1');
    assert.equal((await app.inject({ method: 'PUT', url: '/api/me/profile', headers: h, payload: { bio: 'x'.repeat(251) } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/me/profile', headers: h, payload: { avatar: Buffer.from('notajpeg').toString('base64') } })).statusCode, 400);
    const save = await app.inject({ method: 'PUT', url: '/api/me/profile', headers: h, payload: { bio: 'hi there', avatar: JPEG } });
    assert.equal(save.statusCode, 200);
    const mine = await app.inject({ method: 'GET', url: '/api/me/profile', headers: h });
    assert.equal(mine.json().bio, 'hi there');
    assert.ok(mine.json().avatar, 'owner always sees own avatar');
  } finally { await teardown(); }
});

test('profile: avatar needs mutual add AND verification; vanishes on unfriend/unverify', async () => {
  const { app, mongo, teardown } = await setupApp(LIMITS);
  try {
    const a = await signup(app, makeClient(), 'paula1');
    const b = await signup(app, makeClient(), 'bennet');
    await app.inject({ method: 'PUT', url: '/api/me/profile', headers: b.h, payload: { bio: 'bobby bio', avatar: JPEG } });
    const viewAsA = () => app.inject({ method: 'GET', url: '/api/users/bennet/profile', headers: a.h });
    const setVerified = (v) => mongo.db.collection('users').updateOne({ ul: 'bennet' }, { $set: { verified: v } });

    // mutual, but bennet NOT verified -> initials only
    await app.inject({ method: 'PUT', url: '/api/me/friends/bennet', headers: a.h });
    await app.inject({ method: 'PUT', url: '/api/me/friends/paula1', headers: b.h });
    let v = await viewAsA();
    assert.equal(v.json().bio, 'bobby bio');
    assert.equal(v.json().avatar, null, 'unverified peers show initials only');

    // verified -> photo unlocks
    await setVerified(true);
    assert.ok((await viewAsA()).json().avatar, 'mutual + verified unlocks the photo');

    // bennet unfriends paula -> photo gone (read-time rule, no cleanup jobs)
    await app.inject({ method: 'DELETE', url: '/api/me/friends/paula1', headers: b.h });
    assert.equal((await viewAsA()).json().avatar, null, 'unfriending removes the photo instantly');

    // re-mutual then revoked verification -> hidden again
    await app.inject({ method: 'PUT', url: '/api/me/friends/paula1', headers: b.h });
    assert.ok((await viewAsA()).json().avatar);
    await setVerified(false);
    assert.equal((await viewAsA()).json().avatar, null, 'revoked verification hides the photo');
  } finally { await teardown(); }
});
