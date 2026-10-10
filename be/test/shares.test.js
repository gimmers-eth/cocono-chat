import test from 'node:test';
import assert from 'node:assert/strict';
import { setupAdmin, makeClient, signupUser } from './helpers.js';

// Share-link attribution (be/src/lib/shares.js): the CREATED edge written at
// signup, the SEEN edge reported by an existing account, and the admin Shares
// tab that reads both directions of the same two facts.
const LIMITS = { signupIpLimit: 1000, challengeIpLimit: 1000, verifyAccountLimit: 1000, verifyIpLimit: 1000 };

const hit = (app, token, o) => app.inject({
  method: 'POST', url: '/api/share/hit',
  headers: { authorization: `Bearer ${token}` },
  payload: { o },
});

test('signup with a share-link referrer records the parent on the account', async () => {
  const { app, db, teardown } = await setupAdmin(LIMITS);
  try {
    await signupUser(app, makeClient(), 'alice');
    const bob = await signupUser(app, makeClient(), 'bobby', { r: 'Alice' }); // case-insensitive
    assert.equal(bob.res.statusCode, 201);
    assert.equal(bob.res.json().ref, 'alice', 'the response echoes the parent');

    const doc = await db.collection('users').findOne({ ul: 'bobby' });
    assert.equal(doc.ref.by, 'alice');
    assert.ok(doc.ref.at instanceof Date);

    // the owner side of the same fact: one pair doc, marked as a creation
    // (and NOT counted as an extra click on top of it)
    const pair = await db.collection('shares').findOne({ o: 'alice', viewer: 'bobby' });
    assert.ok(pair, 'created edge stored');
    assert.ok(pair.created instanceof Date);
    assert.equal(pair.n, 0);
    assert.ok(pair.firstAt instanceof Date);

    // an organic signup keeps no ref at all
    await signupUser(app, makeClient(), 'carol');
    const carol = await db.collection('users').findOne({ ul: 'carol' });
    assert.equal(carol.ref, undefined);
  } finally {
    await teardown();
  }
});

test('signup ignores junk, unknown-format and self referrals — and still signs up', async () => {
  const { app, db, teardown } = await setupAdmin(LIMITS);
  try {
    for (const [name, r] of [['dave', 'not a name!'], ['erin', 'erin'], ['frank', 'x']]) {
      const res = await signupUser(app, makeClient(), name, { r });
      assert.equal(res.res.statusCode, 201, `${name}: signup must survive a bad referrer`);
      const doc = await db.collection('users').findOne({ ul: name });
      assert.equal(doc.ref, undefined, `${name}: '${r}' must not be recorded`);
    }
    // a referrer that does not exist is still recorded: the child's origin
    // story is about the LINK it followed, and the God View draws the missing
    // parent as a ghost node rather than silently rewriting history
    const res = await signupUser(app, makeClient(), 'grace', { r: 'deletedmentor' });
    assert.equal(res.res.statusCode, 201);
    assert.equal((await db.collection('users').findOne({ ul: 'grace' })).ref.by, 'deletedmentor');
  } finally {
    await teardown();
  }
});

test('POST /api/share/hit: an existing account opening a link is a "seen" edge', async () => {
  const { app, db, teardown } = await setupAdmin(LIMITS);
  try {
    await signupUser(app, makeClient(), 'alice');
    const bob = await signupUser(app, makeClient(), 'bobby');

    assert.equal((await hit(app, bob.token, 'alice')).json().recorded, true);
    // repeats bump the counter on the SAME pair — the collection stays
    // bounded by real relationships, not by clicks
    await hit(app, bob.token, 'alice');
    const res = await hit(app, bob.token, 'alice');
    assert.equal(res.statusCode, 200);
    const rows = await db.collection('shares').find({ o: 'alice', viewer: 'bobby' }).toArray();
    assert.equal(rows.length, 1, 'one doc per (owner, viewer) pair');
    assert.equal(rows[0].n, 3);
    assert.equal(rows[0].created, undefined, 'a click is not a creation');
    assert.ok(rows[0].firstAt <= rows[0].lastAt);

    // own link: nothing to attribute, and no row
    assert.equal((await hit(app, bob.token, 'bobby')).json().recorded, false);
    // unknown owner: refused, nothing written
    assert.equal((await hit(app, bob.token, 'nosuchuser')).statusCode, 404);
    assert.equal(await db.collection('shares').countDocuments({ o: 'nosuchuser' }), 0);
    // junk body
    assert.equal((await hit(app, bob.token, '!!!')).statusCode, 400);
    // and it is NOT a public endpoint: no token, no write
    const anon = await app.inject({ method: 'POST', url: '/api/share/hit', payload: { o: 'alice' } });
    assert.equal(anon.statusCode, 401);
  } finally {
    await teardown();
  }
});

test('GET /api/me/share-link reports what the link produced (counts only)', async () => {
  const { app, teardown } = await setupAdmin(LIMITS);
  try {
    const alice = await signupUser(app, makeClient(), 'alice');
    const bob = await signupUser(app, makeClient(), 'bobby', { r: 'alice' });
    await hit(app, bob.token, 'alice');

    const res = await app.inject({
      method: 'GET', url: '/api/me/share-link',
      headers: { authorization: `Bearer ${alice.token}` },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.path, '/?chat=alice');
    assert.equal(body.created, 1);
    assert.equal(body.clicked, 1, 'the created pair is the same row the click bumped');
    assert.deepEqual(Object.keys(body).sort(), ['clicked', 'created', 'path', 'ul'], 'no WHO in the response');

    const anon = await app.inject({ method: 'GET', url: '/api/me/share-link' });
    assert.equal(anon.statusCode, 401);
  } finally {
    await teardown();
  }
});

test('admin Shares tab: created / seen / clicked / came-from, in both directions', async () => {
  const { admin, app, teardown } = await setupAdmin(LIMITS);
  try {
    const alice = await signupUser(app, makeClient(), 'alice');
    const bob = await signupUser(app, makeClient(), 'bobby', { r: 'alice' });   // created by alice
    await signupUser(app, makeClient(), 'cyrus', { r: 'alice' });   // created by alice
    const derek = await signupUser(app, makeClient(), 'derek');   // organic
    await hit(app, derek.token, 'alice');   // derek opened alice's link
    await hit(app, bob.token, 'derek');     // bob opened derek's link

    const res = await admin.inject({ method: 'GET', url: '/api/admin/users/alice/shares' });
    assert.equal(res.statusCode, 200);
    const a = res.json();
    assert.equal(a.ul, 'alice');
    assert.equal(a.ref, null, 'alice has no parent');
    assert.deepEqual(a.created.map((r) => r.ul).sort(), ['bobby', 'cyrus']);
    assert.equal(a.created.every((r) => r.at), true, 'each creation is dated');
    assert.deepEqual(a.seen.map((r) => r.ul), ['derek']);
    assert.equal(a.seen[0].clicks, 1);
    assert.deepEqual(a.clicked, [], 'alice opened nobody\'s link');

    // and the other end of the same facts
    const b = (await admin.inject({ method: 'GET', url: '/api/admin/users/bobby/shares' })).json();
    assert.deepEqual(b.created, []);
    assert.equal(b.ref.ul, 'alice');
    assert.ok(b.ref.at instanceof Date || typeof b.ref.at === 'string');
    // the link bob was BORN from is part of "links bob clicked" too — flagged
    // in place, so the list and the parent row can never disagree
    assert.deepEqual(b.clicked.map((r) => r.ul).sort(), ['alice', 'derek']);
    assert.equal(b.clicked.find((r) => r.ul === 'alice').createdMe, true);
    assert.equal(b.clicked.find((r) => r.ul === 'derek').createdMe, false);

    const d = (await admin.inject({ method: 'GET', url: '/api/admin/users/derek/shares' })).json();
    assert.deepEqual(d.clicked.map((r) => r.ul), ['alice']);
    assert.deepEqual(d.seen.map((r) => r.ul), ['bobby'], 'derek\'s link was opened by bob');

    // case-insensitive handle, unknown account 404s
    assert.equal((await admin.inject({ method: 'GET', url: '/api/admin/users/ALICE/shares' })).statusCode, 200);
    assert.equal((await admin.inject({ method: 'GET', url: '/api/admin/users/nobody/shares' })).statusCode, 404);
  } finally {
    await teardown();
  }
});

test('admin users list carries the parent, and Details can show it', async () => {
  const { admin, app, teardown } = await setupAdmin(LIMITS);
  try {
    await signupUser(app, makeClient(), 'alice');
    await signupUser(app, makeClient(), 'bobby', { r: 'alice' });
    await signupUser(app, makeClient(), 'carol');

    const rows = (await admin.inject({ method: 'GET', url: '/api/admin/users' })).json();
    const byUl = new Map(rows.map((r) => [r.ul, r]));
    assert.equal(byUl.get('bobby').ref.by, 'alice');
    assert.equal(byUl.get('alice').ref, null);
    assert.equal(byUl.get('carol').ref, null);
  } finally {
    await teardown();
  }
});

test('deleting an account purges its share rows but leaves children their origin', async () => {
  const { admin, app, db, teardown } = await setupAdmin(LIMITS);
  try {
    await signupUser(app, makeClient(), 'alice');
    await signupUser(app, makeClient(), 'bobby', { r: 'alice' });
    const dee = await signupUser(app, makeClient(), 'derek');
    await hit(app, dee.token, 'alice');

    assert.ok(await db.collection('shares').findOne({ o: 'alice' }));
    const del = await admin.inject({ method: 'DELETE', url: '/api/admin/users/alice' });
    assert.equal(del.statusCode, 200);

    // both directions gone: referral metadata is data ABOUT the account
    assert.equal(await db.collection('shares').countDocuments({ o: 'alice' }), 0);
    assert.equal(await db.collection('shares').countDocuments({ viewer: 'alice' }), 0);
    // the child keeps its own origin story — the parent is now a ghost node
    const bobby = await db.collection('users').findOne({ ul: 'bobby' });
    assert.equal(bobby.ref.by, 'alice');
    const story = (await admin.inject({ method: 'GET', url: '/api/admin/users/bobby/shares' })).json();
    assert.equal(story.ref.ul, 'alice');
    assert.equal(story.ref.gone, true, 'the deleted parent is flagged, not hidden');
  } finally {
    await teardown();
  }
});
