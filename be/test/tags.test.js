// PEER TAGS: PUT /api/me/friends/:ul/tags (enum-enforced whole-set replace,
// invisible to the tagged party), the relationships `.tags` mirror the app
// re-pulls, and the ADMIN relationships cell (a tag alone surfaces the row;
// account deletion sweeps others' tags aimed at the dead name).
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
    method: 'POST', url: '/api/signup',
    payload: { u, p: client.p, x: client.x, a, d, t, s },
  });
  assert.equal(res.statusCode, 201);
  return d;
}

async function getToken(app, client, u, d) {
  const challenge = await app.inject({ method: 'POST', url: '/api/auth/challenge', payload: { u, d } });
  const { n } = challenge.json();
  const verify = await app.inject({
    method: 'POST', url: '/api/auth/verify',
    payload: { u, d, n, s: client.signBytes(Buffer.from(n, 'utf8')) },
  });
  assert.equal(verify.statusCode, 200);
  return { authorization: `Bearer ${verify.json().token}` };
}

function setupAdmin(mongo, redis) {
  const admin = Fastify({ logger: false });
  return admin.register(adminRoutes, {
    users: mongo.db.collection('users'),
    redis,
    config,
    diagnostics: mongo.db.collection('diagnostics'),
    reports: mongo.db.collection('reports'),
    settings: mongo.db.collection('settings'),
    messages: mongo.db.collection('messages'),
    idDocs: mongo.db.collection('id_docs'),
    profiles: mongo.db.collection('profiles'),
  }).then(() => admin);
}

test('tags: enum-enforced whole-set writes, relationships mirror, tagged party never involved', async () => {
  const { app, mongo, teardown } = await setupApp(LIMITS);
  try {
    const alice = makeClient();
    const bobby = makeClient();
    const dA = await signupUser(app, alice, 'alice');
    const dB = await signupUser(app, bobby, 'bobby');
    const aTok = await getToken(app, alice, 'alice', dA);
    const bTok = await getToken(app, bobby, 'bobby', dB);

    // auth required + shape enforced
    assert.equal((await app.inject({ method: 'PUT', url: '/api/me/friends/bobby/tags', payload: { tags: ['work'] } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/me/friends/bobby/tags', headers: aTok, payload: {} })).statusCode, 400);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/me/friends/bad$name!/tags', headers: aTok, payload: { tags: ['work'] } })).statusCode, 400);

    // WHOLE-SET replace, normalised: lowercase + dedup + enum filter + sort
    const set = await app.inject({
      method: 'PUT', url: '/api/me/friends/bobby/tags', headers: aTok,
      payload: { tags: ['WORK', 'work', 'cultleader', 'Family'] },
    });
    assert.equal(set.statusCode, 200);
    assert.deepEqual(set.json().tags, ['family', 'work'], 'unknowns dropped, dupes merged, sorted');

    // relationships carries the peer → [ids] map (the app's reconcile source)
    const rel = (await app.inject({ method: 'GET', url: '/api/me/relationships', headers: aTok })).json();
    assert.deepEqual(rel.tags, { bobby: ['family', 'work'] });

    // THE TAGGED PARTY SEES NOTHING: bobby's own relationships (and friend
    // view) carry no hint of alice's labels — tags live on the tagger's doc
    const relB = (await app.inject({ method: 'GET', url: '/api/me/relationships', headers: bTok })).json();
    assert.deepEqual(relB.tags, {}, 'a tag is invisible to the tagged account');
    const docB = await mongo.db.collection('users').findOne({ ul: 'bobby' });
    assert.equal(docB.tags, undefined, 'nothing written on the tagged doc');

    // empty set CLEARS (key unset, no empty-array litter)
    const cleared = await app.inject({ method: 'PUT', url: '/api/me/friends/bobby/tags', headers: aTok, payload: { tags: [] } });
    assert.deepEqual(cleared.json().tags, []);
    const docA = await mongo.db.collection('users').findOne({ ul: 'alice' });
    assert.equal(docA.tags?.bobby, undefined, 'empty write unsets the key');

    // tagging does NOT require any relation — a stranger is taggable
    await signupUser(app, makeClient(), 'carol', 'carol-dev-0001');
    const stranger = await app.inject({ method: 'PUT', url: '/api/me/friends/carol/tags', headers: aTok, payload: { tags: ['starred'] } });
    assert.deepEqual(stranger.json().tags, ['starred']);
    // …and a name that no longer EXISTS is taggable too: a tag is the
    // tagger's own note about a name (labels on deleted contacts survive
    // until that name is purged — the server holds no directory truth here)
    const ghost = await app.inject({ method: 'PUT', url: '/api/me/friends/deadflame/tags', headers: aTok, payload: { tags: ['personal'] } });
    assert.equal(ghost.statusCode, 200, 'unknown-but-valid names accept tags');
  } finally { await teardown(); }
});

test('tags: admin relationships cell + delete-purge', async () => {
  const { app, mongo, redis, teardown } = await setupApp(LIMITS);
  const admin = await setupAdmin(mongo, redis);
  try {
    const alice = makeClient();
    const bobby = makeClient();
    const dA = await signupUser(app, alice, 'alice');
    const dB = await signupUser(app, bobby, 'bobby');
    const aTok = await getToken(app, alice, 'alice', dA);

    // NO relationship at all (never added each other): the tag alone must
    // surface the row for the operator
    await app.inject({ method: 'PUT', url: '/api/me/friends/bobby/tags', headers: aTok, payload: { tags: ['starred', 'work'] } });
    const rel = (await admin.inject({ method: 'GET', url: '/api/admin/users/alice/relationships' })).json();
    const row = rel.relationships.find((r) => r.ul === 'bobby');
    assert.ok(row, 'a tag on a stranger surfaces the admin row');
    assert.deepEqual(row.tags, ['starred', 'work'].sort());
    assert.equal(row.added, false);

    // and the REVERSE view (bobby's panel) shows nothing: tags are the
    // tagger's own labels, not a relation the other side carries
    const relB = (await admin.inject({ method: 'GET', url: '/api/admin/users/bobby/relationships' })).json();
    assert.equal(relB.relationships.find((r) => r.ul === 'alice'), undefined);

    // account deletion sweeps other accounts' tags aimed at the dead name
    // (removing the LAST device deletes the account outright — the delete
    // funnel in lib/accountState.js runs its tag purge)
    const bTok = await getToken(app, bobby, 'bobby', dB);
    await app.inject({ method: 'DELETE', url: '/api/devices/' + dB, headers: bTok });
    const docA = await mongo.db.collection('users').findOne({ ul: 'alice' });
    assert.equal(docA.tags?.bobby, undefined, 'tags aimed at the dead name were purged');
  } finally { await teardown(); }
});
