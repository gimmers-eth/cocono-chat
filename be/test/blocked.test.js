// BLOCK feature: sever-both-ways, inbound gates, reason enum, relationships
// merge, unblock semantics. REST level (live ws gates are covered by the
// client suite, which drives the real SDK over a real socket).
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
  return { authorization: `Bearer ${verify.json().token}` };
}

test('block: severs both ways, gates re-adds, stores the reason; unblock resets', async () => {
  const { app, mongo, teardown } = await setupApp(LIMITS);
  try {
    const alice = makeClient();
    const bobby = makeClient();
    const dA = randomUUID();
    const dB = randomUUID();
    await signupUser(app, alice, 'alice', dA);
    await signupUser(app, bobby, 'bobby', dB);
    const aTok = await getToken(app, alice, 'alice', dA);
    const bTok = await getToken(app, bobby, 'bobby', dB);

    // a real relation with stages, so severing has something to destroy
    await app.inject({ method: 'PUT', url: '/api/me/friends/bobby', headers: aTok });
    await app.inject({ method: 'PUT', url: '/api/me/friends/alice', headers: bTok });
    const v = await app.inject({ method: 'PUT', url: '/api/me/friends/alice/verify', headers: bTok, payload: { verified: true } });
    assert.equal(v.statusCode, 200, 'mutual verify lands');

    // reason is REQUIRED
    const noReason = await app.inject({ method: 'PUT', url: '/api/me/friends/bobby/block', headers: aTok, payload: {} });
    assert.equal(noReason.statusCode, 400);
    assert.equal(noReason.json().error, 'invalid_request');
    const badReason = await app.inject({ method: 'PUT', url: '/api/me/friends/bobby/block', headers: aTok, payload: { r: 'mood' } });
    assert.equal(badReason.statusCode, 400, 'reason is an enum, not free text');

    const block = await app.inject({ method: 'PUT', url: '/api/me/friends/bobby/block', headers: aTok, payload: { r: 'scam' } });
    assert.equal(block.statusCode, 200);

    // severed BOTH ways — trust never survives on either side
    const aList = (await app.inject({ method: 'GET', url: '/api/me/friends', headers: aTok })).json().friends;
    const bList = (await app.inject({ method: 'GET', url: '/api/me/friends', headers: bTok })).json().friends;
    assert.deepEqual(aList, [], 'my list lost them');
    assert.deepEqual(bList, [], 'their list lost me too (stronger than un-add)');

    // the wall holds: their add attempt never lands
    const reAdd = await app.inject({ method: 'PUT', url: '/api/me/friends/alice', headers: bTok });
    assert.equal(reAdd.statusCode, 403);
    assert.equal(reAdd.json().error, 'blocked');

    // my own view: relationships merge carries the blocked row + reason
    const rel = (await app.inject({ method: 'GET', url: '/api/me/relationships', headers: aTok })).json();
    assert.deepEqual(rel.added, [], 'no added rows left');
    assert.equal(rel.blocked.length, 1);
    assert.equal(rel.blocked[0].peer, 'bobby');
    assert.equal(rel.blocked[0].reason, 'scam');
    assert.equal(rel.blocked[0].addedBack, false);

    const doc = await mongo.db.collection('users').findOne({ ul: 'alice' });
    assert.deepEqual(doc.blocked, ['bobby']);
    assert.equal(doc.blockReasons.bobby.r, 'scam', 'reason stored as the blocker’s own data');

    // unblock: wall lifts, nothing is restored — a rebuild is a fresh add
    const un = await app.inject({ method: 'DELETE', url: '/api/me/friends/bobby/block', headers: aTok });
    assert.equal(un.statusCode, 200);
    const afterUn = await mongo.db.collection('users').findOne({ ul: 'alice' });
    assert.deepEqual(afterUn.blocked ?? [], [], 'wall gone');
    assert.equal(afterUn.blockReasons?.bobby, undefined, 'reason purged with the block');
    const fresh = await app.inject({ method: 'PUT', url: '/api/me/friends/alice', headers: bTok });
    assert.equal(fresh.statusCode, 200, 'they can add again after unblock');
    const freshest = fresh.json().friends.find((f) => f.u === 'alice');
    assert.equal(freshest.verified, false, 'stages never resurrect');
    assert.equal(freshest.trust, false, 'trust never resurrects either');
  } finally { await teardown(); }
});

test('block: self and unknown targets rejected; blocking a stranger is fine', async () => {
  const { app, teardown } = await setupApp(LIMITS);
  try {
    const alice = makeClient();
    const dA = randomUUID();
    await signupUser(app, alice, 'carol', dA); // names distinct per run in CI-ish env
    const tok = await getToken(app, alice, 'carol', dA);
    const self = await app.inject({ method: 'PUT', url: '/api/me/friends/carol/block', headers: tok, payload: { r: 'unknown' } });
    assert.equal(self.statusCode, 400);
    assert.equal(self.json().error, 'self_block');
    const ghost = await app.inject({ method: 'PUT', url: '/api/me/friends/ghostster/block', headers: tok, payload: { r: 'nospeak' } });
    assert.equal(ghost.statusCode, 404);
    assert.equal(ghost.json().error, 'unknown_account');
    // blocking someone I have NO relation with is exactly the harassment case
    const other = makeClient();
    await signupUser(app, other, 'dave', randomUUID());
    const ok = await app.inject({ method: 'PUT', url: '/api/me/friends/dave/block', headers: tok, payload: { r: 'nospeak' } });
    assert.equal(ok.statusCode, 200, 'stranger blockable without any relation');
  } finally { await teardown(); }
});
