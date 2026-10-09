// BLOCK feature: sever-both-ways, inbound gates, reason enum, relationships
// merge, unblock semantics. REST level (live ws gates are covered by the
// client suite, which drives the real SDK over a real socket).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setupApp, makeClient, randomAesKey, nowEpoch } from './helpers.js';
import Fastify from 'fastify';
import adminRoutes from '../src/routes/admin-routes/index.js';
import { config } from '../src/config.js';

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

test('admin relationships: a pure block (no friends ever) still shows in the panel', async () => {
  const { app, mongo, redis, teardown } = await setupApp(LIMITS);
  const admin = Fastify({ logger: false });
  await admin.register(adminRoutes, {
    users: mongo.db.collection('users'),
    redis,
    config,
    diagnostics: mongo.db.collection('diagnostics'),
    settings: mongo.db.collection('settings'),
    messages: mongo.db.collection('messages'),
    idDocs: mongo.db.collection('id_docs'),
    profiles: mongo.db.collection('profiles'),
  });
  try {
    const alice = makeClient();
    const bobby = makeClient();
    const dA = randomUUID();
    const dB = randomUUID();
    await signupUser(app, alice, 'edith', dA);
    await signupUser(app, bobby, 'frank', dB);
    const aTok = await getToken(app, alice, 'edith', dA);

    // NO friends on either side — the block is the whole relation (the user
    // repro: admin Relationships showed nothing because blocked pairs have
    // no friend entries left and the rows loop skipped them)
    const block = await app.inject({ method: 'PUT', url: '/api/me/friends/frank/block', headers: aTok, payload: { r: 'scam' } });
    assert.equal(block.statusCode, 200);

    const rel = (await admin.inject({ method: 'GET', url: '/api/admin/users/edith/relationships' })).json();
    const row = rel.relationships.find((r) => r.ul === 'frank');
    assert.ok(row, 'blocked stranger appears in admin relationships');
    assert.equal(row.blocks, true);
    assert.equal(row.blockReason, 'scam');
    assert.equal(row.added, false, 'no friend residue');
    assert.equal(row.theyAddedMe, false);

    // reverse direction: frank's own panel row shows blockedBy
    const back = (await admin.inject({ method: 'GET', url: '/api/admin/users/frank/relationships' })).json();
    const backRow = back.relationships.find((r) => r.ul === 'edith');
    assert.ok(backRow, 'the wall is visible from BOTH sides of the panel');
    assert.equal(backRow.blockedBy, true);
    assert.equal(backRow.blockedByReason, 'scam', 'the reason travels with the wall to either side');

    // the dedicated "Blocked by" tab endpoint: who walled frank off, with
    // the reason stored on the BLOCKER's doc (privacy: reverse scan)
    const fr = (await admin.inject({ method: 'GET', url: '/api/admin/users/frank/blockers' })).json();
    assert.deepEqual(fr.blockers.map((b) => b.ul), ['edith']);
    assert.equal(fr.blockers[0].reason, 'scam');
    assert.ok(fr.blockers[0].at, 'wall has a date');
    const ed = (await admin.inject({ method: 'GET', url: '/api/admin/users/edith/blockers' })).json();
    assert.deepEqual(ed.blockers, [], 'the blocker is not blocked by anyone');
    const ghost = await admin.inject({ method: 'GET', url: '/api/admin/users/nosuchuser/blockers' });
    assert.equal(ghost.statusCode, 404);
  } finally { await teardown(); }
});

// ---- MUTING: notification-only, account-level, relation-intact ----
test('mute: silences notifications without touching the relation; mirrors via relationships', async () => {
  const { app, mongo, teardown } = await setupApp(LIMITS);
  try {
    const alice = makeClient();
    const bobby = makeClient();
    const dA = randomUUID();
    const dB = randomUUID();
    await signupUser(app, alice, 'muted01', dA); // names >= 4 chars (USERNAME_RE)
    await signupUser(app, bobby, 'muted02', dB);
    const aTok = await getToken(app, alice, 'muted01', dA);
    const bTok = await getToken(app, bobby, 'muted02', dB);

    // a real friend relation first — muting must NOT sever it
    await app.inject({ method: 'PUT', url: '/api/me/friends/muted02', headers: aTok });
    await app.inject({ method: 'PUT', url: '/api/me/friends/muted01', headers: bTok });

    assert.equal((await app.inject({ method: 'PUT', url: '/api/me/friends/muted02/mute', headers: aTok })).statusCode, 200);

    // relation untouched
    const aList = (await app.inject({ method: 'GET', url: '/api/me/friends', headers: aTok })).json().friends;
    assert.deepEqual(aList.map((f) => f.u), ['muted02'], 'still friends');

    // the unified view carries the mute for every device to mirror
    const rel = (await app.inject({ method: 'GET', url: '/api/me/relationships', headers: aTok })).json();
    assert.deepEqual(rel.muted, ['muted02']);

    // guards
    assert.equal((await app.inject({ method: 'PUT', url: '/api/me/friends/muted01/mute', headers: aTok })).json().error, 'self_mute');
    assert.equal((await app.inject({ method: 'PUT', url: '/api/me/friends/ghost0000/mute', headers: aTok })).statusCode, 404);

    // unmute clears
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/me/friends/muted02/mute', headers: aTok })).json().muted, false);
    const rel2 = (await app.inject({ method: 'GET', url: '/api/me/relationships', headers: aTok })).json();
    assert.deepEqual(rel2.muted, []);
    const doc = await mongo.db.collection('users').findOne({ ul: 'muted01' });
    assert.deepEqual(doc.muted ?? [], []);

    // the OTHER account was never touched by any of this (invisible mute)
    const bDoc = await mongo.db.collection('users').findOne({ ul: 'muted02' });
    assert.equal(bDoc.blocked, undefined);
  } finally { await teardown(); }
});

test('add notice: headline only on the FIRST-ever add; unadd/readd stays silent', async () => {
  const { app, mongo, teardown } = await setupApp(LIMITS);
  try {
    const alice = makeClient();
    const bobby = makeClient();
    const dA = randomUUID();
    const dB = randomUUID();
    await signupUser(app, alice, 'addyn01', dA);
    await signupUser(app, bobby, 'addyn02', dB);
    const aTok = await getToken(app, alice, 'addyn01', dA);

    await app.inject({ method: 'PUT', url: '/api/me/friends/addyn02', headers: aTok });
    let doc = await mongo.db.collection('users').findOne({ ul: 'addyn01' });
    assert.deepEqual(doc.hadAdded, ['addyn02'], 'first add records the memory');

    await app.inject({ method: 'DELETE', url: '/api/me/friends/addyn02', headers: aTok });
    await app.inject({ method: 'PUT', url: '/api/me/friends/addyn02', headers: aTok });
    doc = await mongo.db.collection('users').findOne({ ul: 'addyn01' });
    assert.deepEqual(doc.hadAdded, ['addyn02'], 're-add does NOT reset the memory');
    assert.ok(doc.friends.some((f) => f.u === 'addyn02'), 'relation itself re-established');
  } finally { await teardown(); }
});
