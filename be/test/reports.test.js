// REPORTING: POST /api/me/report — reason enum + required description,
// transcript filtering (only the conversation's own senders survive),
// the optional auto-block applied through the SAME sever-both-ways path
// as a plain block, and the admin list/delete endpoints. REST level.
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
  reportIpLimit: 1000,
  reportAccountLimit: 1000,
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

const baseReport = (overrides = {}) => ({
  peer: 'bobby',
  r: 'scamming',
  description: 'he sold me a fake badge',
  messages: [
    { from: 'bobby', ts: 1, text: 'buy my badge' },
    { from: 'alice', ts: 2, text: 'no way' },
  ],
  ...overrides,
});

test('report: requires auth, a valid reason and a description', async () => {
  const { app, teardown } = await setupApp(LIMITS);
  try {
    const anon = await app.inject({ method: 'POST', url: '/api/me/report', payload: baseReport() });
    assert.equal(anon.statusCode, 401, 'auth required');

    const alice = makeClient();
    const dA = randomUUID();
    await signupUser(app, alice, 'alice', dA);
    const aTok = await getToken(app, alice, 'alice', dA);

    const badReason = await app.inject({ method: 'POST', url: '/api/me/report', headers: aTok, payload: baseReport({ r: 'vibes' }) });
    assert.equal(badReason.statusCode, 400);
    assert.equal(badReason.json().error, 'invalid_request');
    assert.equal((badReason.json().message ?? '').toLowerCase().includes('reason'), true);

    const noDesc = await app.inject({ method: 'POST', url: '/api/me/report', headers: aTok, payload: baseReport({ description: '   ' }) });
    assert.equal(noDesc.statusCode, 400, 'description is REQUIRED');

    const self = await app.inject({ method: 'POST', url: '/api/me/report', headers: aTok, payload: baseReport({ peer: 'alice' }) });
    assert.equal(self.statusCode, 400);
    assert.equal(self.json().error, 'self_report');

    const ghost = await app.inject({ method: 'POST', url: '/api/me/report', headers: aTok, payload: baseReport({ peer: 'ghostster' }) });
    assert.equal(ghost.statusCode, 404);
    assert.equal(ghost.json().error, 'unknown_account');
  } finally { await teardown(); }
});

test('report: stores the payload, filters foreign transcript lines, no block by default', async () => {
  const { app, mongo, teardown } = await setupApp(LIMITS);
  try {
    const alice = makeClient();
    const bobby = makeClient();
    const dA = randomUUID();
    const dB = randomUUID();
    await signupUser(app, alice, 'alice', dA);
    await signupUser(app, bobby, 'bobby', dB);
    const aTok = await getToken(app, alice, 'alice', dA);

    const res = await app.inject({
      method: 'POST',
      url: '/api/me/report',
      headers: aTok,
      payload: baseReport({ messages: [
        { from: 'bobby', ts: 1, text: 'buy my badge' },
        { from: 'mallory', ts: 2, text: 'I was not even in this chat' }, // dropped
        { from: 'alice', ts: 3, text: 'no way' },
      ] }),
    });
    assert.equal(res.statusCode, 202);
    assert.deepEqual(res.json(), { reported: true, blocked: false });

    const doc = await mongo.db.collection('reports').findOne({ account: 'alice' });
    assert.ok(doc, 'report stored');
    assert.equal(doc.peer, 'bobby');
    assert.equal(doc.reason, 'scamming');
    assert.equal(doc.description, 'he sold me a fake badge');
    assert.equal(doc.blocked, false);
    assert.equal(doc.messages.length, 2, 'foreign sender dropped');
    assert.deepEqual(doc.messages.map((m) => m.from), ['bobby', 'alice']);

    // and NO block happened: bobby can still reach alice's add seam
    const bTok = await getToken(app, bobby, 'bobby', dB);
    const add = await app.inject({ method: 'PUT', url: '/api/me/friends/alice', headers: bTok });
    assert.equal(add.statusCode, 200, 'plain report leaves the relation alone');
  } finally { await teardown(); }
});

test('report: block=true severs both ways through the shared block path', async () => {
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
    await app.inject({ method: 'PUT', url: '/api/me/friends/bobby', headers: aTok });
    await app.inject({ method: 'PUT', url: '/api/me/friends/alice', headers: bTok });

    const res = await app.inject({
      method: 'POST',
      url: '/api/me/report',
      headers: aTok,
      payload: baseReport({ block: true }),
    });
    assert.equal(res.statusCode, 202);
    assert.deepEqual(res.json(), { reported: true, blocked: true });

    const doc = await mongo.db.collection('users').findOne({ ul: 'alice' });
    assert.deepEqual(doc.blocked, ['bobby']);
    // scamming maps onto the block enum's 'scam' (reason for MY recall,
    // never shown to the blocked party)
    assert.equal(doc.blockReasons.bobby.r, 'scam');
    // severed BOTH ways like a plain block
    const aList = (await app.inject({ method: 'GET', url: '/api/me/friends', headers: aTok })).json().friends;
    const bList = (await app.inject({ method: 'GET', url: '/api/me/friends', headers: bTok })).json().friends;
    assert.deepEqual(aList, []);
    assert.deepEqual(bList, []);
    // the wall holds: their add never lands
    const reAdd = await app.inject({ method: 'PUT', url: '/api/me/friends/alice', headers: bTok });
    assert.equal(reAdd.statusCode, 403);
    assert.equal(reAdd.json().error, 'blocked');
  } finally { await teardown(); }
});

test('admin reports: list newest-first, delete one, purge all', async () => {
  const { app, mongo, redis, teardown } = await setupApp(LIMITS);
  const admin = Fastify({ logger: false });
  await admin.register(adminRoutes, {
    users: mongo.db.collection('users'),
    redis,
    config,
    diagnostics: mongo.db.collection('diagnostics'),
    reports: mongo.db.collection('reports'),
    settings: mongo.db.collection('settings'),
    messages: mongo.db.collection('messages'),
    idDocs: mongo.db.collection('id_docs'),
    profiles: mongo.db.collection('profiles'),
  });
  try {
    const alice = makeClient();
    const bobby = makeClient();
    const dA = randomUUID();
    await signupUser(app, alice, 'alice', dA);
    await signupUser(app, bobby, 'bobby', randomUUID());
    const aTok = await getToken(app, alice, 'alice', dA);

    const first = await app.inject({ method: 'POST', url: '/api/me/report', headers: aTok, payload: baseReport() });
    assert.equal(first.statusCode, 202);
    const second = await app.inject({
      method: 'POST',
      url: '/api/me/report',
      headers: aTok,
      payload: baseReport({ r: 'harassment', description: 'slurs', block: true }),
    });
    assert.equal(second.statusCode, 202);

    const list = (await admin.inject({ method: 'GET', url: '/api/admin/reports' })).json();
    assert.equal(list.length, 2);
    assert.equal(list[0].reason, 'harassment', 'newest first');
    assert.equal(list[0].blocked, true);
    assert.equal(list[0].peer, 'bobby');
    assert.equal(list[0].messages.length, 2);

    const del = await admin.inject({ method: 'DELETE', url: `/api/admin/reports/${list[0].id}` });
    assert.equal(del.statusCode, 200);
    const after = (await admin.inject({ method: 'GET', url: '/api/admin/reports' })).json();
    assert.equal(after.length, 1);
    assert.equal(after[0].reason, 'scamming');

    const bad = await admin.inject({ method: 'DELETE', url: '/api/admin/reports/not-an-oid' });
    assert.equal(bad.statusCode, 400);

    const purge = await admin.inject({ method: 'DELETE', url: '/api/admin/reports' });
    assert.equal(purge.json().deleted, 1);
    assert.equal((await admin.inject({ method: 'GET', url: '/api/admin/reports' })).json().length, 0);
  } finally { await teardown(); }
});
