import test from 'node:test';
import assert from 'node:assert/strict';
import { setupAdmin, makeClient, signupUser } from './helpers.js';
import { buildGraphSnapshot } from '../src/routes/admin-routes/graph.js';

// God View: the on-demand, server-stored social graph (admin-routes/graph.js).
// Three edge kinds, one snapshot doc, and a layout that survives a reload.
const LIMITS = { signupIpLimit: 1000, challengeIpLimit: 1000, verifyAccountLimit: 1000, verifyIpLimit: 1000 };

const hit = (app, token, o) => app.inject({
  method: 'POST', url: '/api/share/hit',
  headers: { authorization: `Bearer ${token}` }, payload: { o },
});

/** A small but complete world: a referrer tree, a seen click, a message pair. */
async function seedWorld({ app, admin, db }) {
  const alice = await signupUser(app, makeClient(), 'alice');
  const bobby = await signupUser(app, makeClient(), 'bobby', { r: 'alice' });
  const cyrus = await signupUser(app, makeClient(), 'cyrus', { r: 'bobby' });
  const derek = await signupUser(app, makeClient(), 'derek');
  await hit(app, derek.token, 'alice');   // existing account opened alice's link
  await hit(app, alice.token, 'derek');   // and the other way round
  // the durable "has messaged" edges (written by the ws send path — see
  // messaging.test.js; inserted directly here to keep this suite about graphs)
  await db.collection('contacts').insertMany([
    { from: 'alice', to: 'bobby', n: 4, firstAt: new Date(), lastAt: new Date() },
    { from: 'bobby', to: 'alice', n: 2, firstAt: new Date(), lastAt: new Date() },
  ]);
  // a verified + premium account, so node flags have something to assert
  await admin.inject({ method: 'PUT', url: '/api/admin/users/derek/verified', payload: { verified: true } });
  await admin.inject({ method: 'PUT', url: '/api/admin/users/derek/premium', payload: { premium: true } });
  return { alice, bobby, cyrus, derek };
}

const byUl = (snap) => new Map(snap.nodes.map((n) => [n.ul, n]));
const edgesOf = (snap, k) => snap.edges.filter((e) => e.k === k);

test('god view: POST builds the three edge kinds with direction', async () => {
  const { admin, app, db, teardown } = await setupAdmin(LIMITS);
  try {
    await seedWorld({ app, admin, db });
    const res = await admin.inject({ method: 'POST', url: '/api/admin/graph' });
    assert.equal(res.statusCode, 200);
    const snap = res.json().snapshot;

    // created: alice -> bobby -> cyrus, exactly the direction the link flows
    assert.deepEqual(
      edgesOf(snap, 'created').map((e) => `${e.s}->${e.t}`).sort(),
      ['alice->bobby', 'bobby->cyrus'],
    );
    // seen: both directions are separate directed edges, never merged
    assert.deepEqual(
      edgesOf(snap, 'seen').map((e) => `${e.s}->${e.t}`).sort(),
      ['alice->derek', 'derek->alice'],
    );
    // msg: directed, with the message count carried for the tooltip
    const msg = edgesOf(snap, 'msg').map((e) => `${e.s}->${e.t}:${e.n}`).sort();
    assert.deepEqual(msg, ['alice->bobby:4', 'bobby->alice:2']);

    assert.equal(snap.stats.users, 4);
    assert.equal(snap.stats.created, 2);
    assert.equal(snap.stats.seen, 2);
    assert.equal(snap.stats.msg, 2);
    assert.equal(snap.stats.nodes, 4);
    assert.ok(snap.generatedAt);
    assert.equal(snap.layout, null, 'a fresh build has no saved positions');
  } finally {
    await teardown();
  }
});

test('god view: nodes carry the card facts (photo, trust, badge, coco, generation)', async () => {
  const { admin, app, db, teardown } = await setupAdmin(LIMITS);
  try {
    const world = await seedWorld({ app, admin, db });
    // a worn badge only shows for a VERIFIED account (lib/badges.js
    // visibleDisplayBadge) — award it, verify the wearer, then wear it
    await admin.inject({ method: 'PUT', url: '/api/admin/users/alice/badge', payload: { id: 'teacherspet' } });
    await admin.inject({ method: 'PUT', url: '/api/admin/users/alice/verified', payload: { verified: true } });
    await app.inject({
      method: 'PUT', url: '/api/me/profile',
      headers: { authorization: `Bearer ${world.alice.token}` },
      payload: { displayBadge: 'teacherspet' },
    });
    const snap = (await admin.inject({ method: 'POST', url: '/api/admin/graph' })).json().snapshot;
    const nodes = byUl(snap);

    const derek = nodes.get('derek');
    assert.equal(derek.verified, true);
    assert.equal(derek.premium, true);
    assert.equal(derek.gone, false);
    assert.equal(derek.invited, 0);
    assert.equal(derek.viewers, 1, 'alice opened derek\'s link');
    assert.equal(derek.sentTo, 0);
    assert.equal(derek.heardFrom, 0);
    // premium carries badge points into the score (lib/cocoScore.js)
    assert.ok(derek.coco >= 5, `premium coco should include the badge bonus, got ${derek.coco}`);

    const alice = nodes.get('alice');
    assert.equal(alice.invited, 1, 'bobby was created from alice\'s link');
    assert.equal(alice.tree, 2, 'alice sits above bobby AND cyrus');
    assert.equal(alice.gen, 0, 'alice has no parent: generation 0');
    assert.equal(alice.viewers, 1);
    assert.equal(alice.sentTo, 1);
    assert.equal(alice.heardFrom, 1);
    assert.equal(nodes.get('bobby').gen, 1);
    assert.equal(nodes.get('cyrus').gen, 2);
    assert.equal(nodes.get('cyrus').ref, 'bobby');
    assert.equal(snap.stats.deepest, 2);

    // the worn badge is what a card shows next to the name
    assert.equal(alice.badge, 'teacherspet', 'display badge resolved for a verified wearer');
    assert.ok(alice.badges.includes('teacherspet'));
    assert.equal(alice.verified, true);
    assert.equal(derek.badge, null, 'premium with no explicitly worn badge shows none');

    // the coco score in the graph is the SAME number the app shows
    const stats = (await app.inject({
      method: 'GET', url: '/api/users/alice/stats',
      headers: { authorization: `Bearer ${world.bobby.token}` },
    })).json();
    assert.equal(alice.coco, stats.coco);
    assert.equal(alice.trusted, stats.socialTrusted);
    assert.equal(alice.hasAvatar, false);
  } finally {
    await teardown();
  }
});

test('god view: a deleted parent stays in the picture as a ghost node', async () => {
  const { admin, app, db, teardown } = await setupAdmin(LIMITS);
  try {
    await signupUser(app, makeClient(), 'mentor');
    await signupUser(app, makeClient(), 'pupil', { r: 'mentor' });
    await admin.inject({ method: 'DELETE', url: '/api/admin/users/mentor' });

    const snap = (await admin.inject({ method: 'POST', url: '/api/admin/graph' })).json().snapshot;
    const nodes = byUl(snap);
    assert.ok(nodes.has('mentor'), 'the ghost is drawn');
    assert.equal(nodes.get('mentor').gone, true);
    assert.equal(nodes.get('mentor').devices, 0);
    assert.equal(nodes.get('pupil').ref, 'mentor', 'the child still knows where it came from');
    assert.deepEqual(edgesOf(snap, 'created').map((e) => `${e.s}->${e.t}`), ['mentor->pupil']);
    assert.equal(snap.stats.ghosts, 1);
    assert.equal(snap.stats.users, 1, 'ghosts are not counted as users');
  } finally {
    await teardown();
  }
});

test('god view: GET serves the STORED snapshot and never recomputes', async () => {
  const { admin, app, db, teardown } = await setupAdmin(LIMITS);
  try {
    await seedWorld({ app, admin, db });
    assert.equal((await admin.inject({ method: 'GET', url: '/api/admin/graph' })).json().snapshot, null,
      'nothing stored yet');

    const built = (await admin.inject({ method: 'POST', url: '/api/admin/graph' })).json().snapshot;
    // a new account AFTER the build must not appear until someone regenerates
    await signupUser(app, makeClient(), 'newbie');
    const read = (await admin.inject({ method: 'GET', url: '/api/admin/graph' })).json().snapshot;
    assert.deepEqual(read.nodes.map((n) => n.ul).sort(), built.nodes.map((n) => n.ul).sort());
    assert.equal(read.nodes.some((n) => n.ul === 'newbie'), false);
    assert.equal(String(read.generatedAt), String(built.generatedAt));
    assert.equal(read.stats.users, 4);

    // ...and regeneration picks it up
    const fresh = (await admin.inject({ method: 'POST', url: '/api/admin/graph' })).json().snapshot;
    assert.equal(fresh.stats.users, 5);
  } finally {
    await teardown();
  }
});

test('god view: the layout round-trips through the server', async () => {
  const { admin, app, db, teardown } = await setupAdmin(LIMITS);
  try {
    await seedWorld({ app, admin, db });
    await admin.inject({ method: 'POST', url: '/api/admin/graph' });

    // before anything is generated the panel has no positions to save
    const bad = await admin.inject({ method: 'PUT', url: '/api/admin/graph/layout', payload: { positions: 'nope' } });
    assert.equal(bad.statusCode, 400);

    const save = await admin.inject({
      method: 'PUT', url: '/api/admin/graph/layout',
      payload: {
        positions: {
          alice: [10.25, -40],
          bobby: [120, 80],
          cyrus: [200.75, 90.5],
          derek: [-300, 12],
          nobody: [1, 2],            // not in the snapshot -> dropped
          alice2: [Number.NaN, 3],   // nonsense -> dropped
        },
      },
    });
    assert.equal(save.statusCode, 200);
    assert.equal(save.json().saved, 4);

    const read = (await admin.inject({ method: 'GET', url: '/api/admin/graph' })).json().snapshot;
    assert.deepEqual(read.layout.alice, [10.3, -40], 'rounded to 0.1 for a compact doc');
    assert.deepEqual(read.layout.derek, [-300, 12]);
    assert.equal(read.layout.nobody, undefined);
    assert.equal(Object.keys(read.layout).length, 4);
    assert.ok(read.layoutSavedAt);

    // regenerating WITHOUT keepLayout drops the stale positions...
    const plain = (await admin.inject({ method: 'POST', url: '/api/admin/graph', payload: {} })).json().snapshot;
    assert.equal(plain.layout, null);
    // ...and WITH keepLayout they come back for the nodes that survived
    await admin.inject({ method: 'PUT', url: '/api/admin/graph/layout', payload: { positions: { alice: [5, 5], derek: [6, 6] } } });
    const kept = (await admin.inject({
      method: 'POST', url: '/api/admin/graph', payload: { keepLayout: true },
    })).json().snapshot;
    assert.deepEqual(kept.layout, { alice: [5, 5], derek: [6, 6] });

    // clearing is explicit
    const cleared = await admin.inject({ method: 'PUT', url: '/api/admin/graph/layout', payload: { positions: null } });
    assert.equal(cleared.json().cleared, true);
    assert.equal((await admin.inject({ method: 'GET', url: '/api/admin/graph' })).json().snapshot.layout, null);
  } finally {
    await teardown();
  }
});

test('god view: builder is pure over the collections (no snapshot needed)', async () => {
  const { app, db, mongo, teardown } = await setupAdmin(LIMITS);
  try {
    await signupUser(app, makeClient(), 'alice');
    await signupUser(app, makeClient(), 'bobby', { r: 'alice' });
    const snap = await buildGraphSnapshot({
      users: db.collection('users'),
      shares: db.collection('shares'),
      contacts: db.collection('contacts'),
      profiles: db.collection('profiles'),
      config: (await import('../src/config.js')).config,
    });
    assert.equal(snap.nodes.length, 2);
    assert.deepEqual(snap.edges.map((e) => `${e.k}:${e.s}->${e.t}`), ['created:alice->bobby']);
    assert.ok(mongo, 'harness sanity');
  } finally {
    await teardown();
  }
});

test('god view: an empty box generates an empty (but valid) snapshot', async () => {
  const { admin, teardown } = await setupAdmin(LIMITS);
  try {
    const snap = (await admin.inject({ method: 'POST', url: '/api/admin/graph' })).json().snapshot;
    assert.deepEqual(snap.nodes, []);
    assert.deepEqual(snap.edges, []);
    assert.equal(snap.stats.users, 0);
    assert.equal(snap.stats.deepest, 0);
  } finally {
    await teardown();
  }
});
