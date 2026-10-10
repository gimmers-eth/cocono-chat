// The CLOSED-APP arm of the "X added you" headline (2026-10): the add route
// writes a per-account pendingAdds memory + fires a blind 'add' push, the
// recipient's own devices re-pull GET /api/me/pending-adds over the
// authenticated wire and ACK consumption. Doctrine guards pinned here:
// once per relationship (hadAdded gate), mute kills every emitter (the
// memory included), the list never leaks to anyone but the account itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupApp, makeClient, randomAesKey, nowEpoch } from './helpers.js';
import { randomUUID } from 'node:crypto';

async function signupUser(app, client, u, d = randomUUID()) {
  const a = randomAesKey();
  const t = nowEpoch();
  const s = client.signSignup({ u, a, d, t });
  const res = await app.inject({
    method: 'POST', url: '/api/signup',
    payload: { u, p: client.p, x: client.x, a, d, t, s },
  });
  assert.equal(res.statusCode, 201);
  return { a, d };
}

async function getToken(app, client, u, d) {
  const { n } = (await app.inject({ method: 'POST', url: '/api/auth/challenge', payload: { u, d } })).json();
  const ve = await app.inject({
    method: 'POST', url: '/api/auth/verify',
    payload: { u, d, n, s: client.signBytes(Buffer.from(n, 'utf8')) },
  });
  return ve.json().token;
}

async function makeUser(app, u) {
  const c = makeClient();
  const a = await signupUser(app, c, u);
  const token = await getToken(app, c, u, a.d);
  return { c, u, ul: u.toLowerCase(), d: a.d, token, auth: { authorization: `Bearer ${token}` } };
}

test('add writes the pendingAdds memory; GET returns it; ack consumes it', async () => {
  const { app, mongo, teardown } = await setupApp();
  try {
    const alice = await makeUser(app, 'alice');
    const bobby = await makeUser(app, 'bobby');

    // alice adds bobby — the freshAdd gate runs
    const add = await app.inject({ method: 'PUT', url: '/api/me/friends/bobby', headers: alice.auth });
    assert.equal(add.statusCode, 200);

    // the memory landed on BOBBY's account (the one being added)
    const doc = await mongo.db.collection('users').findOne({ ul: 'bobby' });
    assert.equal(doc.pendingAdds.length, 1);
    assert.equal(doc.pendingAdds[0].by, 'alice');
    assert.ok(doc.pendingAdds[0].at instanceof Date);

    // bobby's own device (the SW re-pull path) reads it — authed
    const got = await app.inject({ method: 'GET', url: '/api/me/pending-adds', headers: bobby.auth });
    assert.equal(got.statusCode, 200);
    assert.equal(got.json().adds[0].by, 'alice');

    // a stranger's token learns NOTHING (this is account-private data)
    const carol = await makeUser(app, 'carol');
    const peek = await app.inject({ method: 'GET', url: '/api/me/pending-adds', headers: carol.auth });
    assert.equal(peek.json().adds.length, 0, 'no cross-account leak');

    // no auth at all — no list
    const anon = await app.inject({ method: 'GET', url: '/api/me/pending-adds' });
    assert.equal(anon.statusCode, 401);

    // ack consumes; idempotent re-ack stays fine
    const ack = await app.inject({ method: 'POST', url: '/api/me/pending-adds/ack', headers: bobby.auth, payload: { by: 'ALICE' } });
    assert.equal(ack.statusCode, 200, ack.body);
    const after = (await app.inject({ method: 'GET', url: '/api/me/pending-adds', headers: bobby.auth })).json();
    assert.equal(after.adds.length, 0);
    const reack = await app.inject({ method: 'POST', url: '/api/me/pending-adds/ack', headers: bobby.auth, payload: { by: 'alice' } });
    assert.equal(reack.statusCode, 200, 'acking a consumed entry is a no-op, not an error');
  } finally {
    await teardown();
  }
});

test('pendingAdds is once per relationship: unadd/readd never re-queues a headline', async () => {
  const { app, mongo, teardown } = await setupApp();
  try {
    const alice = await makeUser(app, 'alice');
    const bobby = await makeUser(app, 'bobby');

    await app.inject({ method: 'PUT', url: '/api/me/friends/bobby', headers: alice.auth });
    // bobby consumes, then alice re-adds (unadd + add = the farm attempt)
    await app.inject({ method: 'DELETE', url: '/api/me/friends/bobby', headers: alice.auth });
    await app.inject({ method: 'PUT', url: '/api/me/friends/bobby', headers: alice.auth });

    const doc = await mongo.db.collection('users').findOne({ ul: 'bobby' });
    assert.equal(doc.pendingAdds.length, 1, 'exactly ONE headline queued, ever (hadAdded gate)');
    assert.equal(doc.pendingAdds[0].by, 'alice');
  } finally {
    await teardown();
  }
});

test('mute kills the push memory too: a muted adder queues nothing', async () => {
  const { app, mongo, teardown } = await setupApp();
  try {
    const alice = await makeUser(app, 'alice');
    const bobby = await makeUser(app, 'bobby');
    await mongo.db.collection('users').updateOne({ ul: 'bobby' }, { $set: { muted: ['alice'] } });

    const add = await app.inject({ method: 'PUT', url: '/api/me/friends/bobby', headers: alice.auth });
    assert.equal(add.statusCode, 200);

    const doc = await mongo.db.collection('users').findOne({ ul: 'bobby' });
    assert.ok(!doc.pendingAdds || doc.pendingAdds.length === 0,
      'mute is notifications-off, full stop — no blind-push wake, nothing to re-pull');
  } finally {
    await teardown();
  }
});

test('pendingAdds is capped: a grinding newcomer cannot grow the doc unbounded', async () => {
  const { app, mongo, teardown } = await setupApp({
    // 28 accounts through the REAL signup/auth path — raise the box limits
    signupIpLimit: 2000, challengeIpLimit: 2000, verifyIpLimit: 2000,
    verifyAccountLimit: 2000, friendsIpLimit: 5000, friendsChangeIpLimit: 5000,
  });
  try {
    const bobby = await makeUser(app, 'bobby');
    for (let i = 0; i < 27; i++) {
      const a = await makeUser(app, `adder${i}`);
      await app.inject({ method: 'PUT', url: '/api/me/friends/bobby', headers: a.auth });
    }
    const doc = await mongo.db.collection('users').findOne({ ul: 'bobby' });
    assert.equal(doc.pendingAdds.length, 25, '$slice keeps the newest 25');
    const bys = new Set(doc.pendingAdds.map((x) => x.by));
    assert.ok(bys.has('adder26'), 'the freshest headline survived the cap');
  } finally {
    await teardown();
  }
});
