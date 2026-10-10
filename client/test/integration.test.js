// SDK integration tests: every scenario boots the REAL backend in-process
// (Fastify + in-memory MongoDB + Redis), exercises the public SDK API
// end-to-end, then deletes the created users and shuts the server down.

import test from 'node:test';
import assert from 'node:assert/strict';

import { startServer, waitFor, waitOpen, sleep, randUser } from './helpers.js';
import { MemoryStorage } from '../src/index.js';

test('sdk: register -> me -> devices -> logout -> login', async (t) => {
  const srv = await startServer();
  const username = randUser();
  t.after(async () => {
    await srv.deleteUser(username);
    await srv.stop();
  });

  const alice = srv.client({ storage: new MemoryStorage() });
  const seen = [];
  alice.on('ready', (p) => seen.push(p));

  const reg = await alice.register(username);
  assert.equal(reg.username, username);
  assert.ok(reg.deviceId);
  assert.ok(reg.token.split('.').length === 3, 'token is a JWT');
  assert.equal(seen.length, 1);
  assert.equal(alice.username, username);

  const me = await alice.me();
  assert.equal(me.u, username);

  const { devices, maxDevices } = await alice.devices();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].current, true); // devices have no roles — only the viewer marker
  assert.equal(maxDevices, 5); // unverified policy tier (test harness relaxes it to 5)

  alice.logout();
  assert.equal(alice.token, null);
  await assert.rejects(alice.me(), /Not logged in/);

  const token = await alice.login(); // identity persisted in storage
  assert.ok(token);
  assert.equal(seen.length, 2, 'ready fired again');

  // Registering the same username again fails cleanly.
  const squatter = srv.client({ storage: new MemoryStorage() });
  await assert.rejects(squatter.register(username), (err) => {
    assert.equal(err.status, 409);
    return true;
  });
});

test('sdk: pairing adds a second device; both log in and see each other', async (t) => {
  const srv = await startServer();
  const username = randUser();
  t.after(async () => {
    await srv.deleteUser(username);
    await srv.stop();
  });

  const dev1 = srv.client({ storage: new MemoryStorage() });
  await dev1.register(username);

  // New device requests to join; approving device checks + approves the code.
  const dev2 = srv.client({ storage: new MemoryStorage() });
  const { code, expiresInSec, deviceId: newDeviceId } = await dev2.beginPairing(username);
  assert.match(code, /^\d{6}$/);
  assert.ok(expiresInSec > 0);

  const pending = await dev1.pendingPairing(code);
  assert.equal(pending.d, newDeviceId, 'approving device sees exactly what it approves');

  const approved = await dev1.approvePairing(code);
  assert.ok(approved.approved);

  const res = await dev2.completePairing({ pollIntervalMs: 100 });
  assert.equal(res.username, username);
  assert.notEqual(res.deviceId, dev1.deviceId);

  const { devices } = await dev1.devices();
  assert.equal(devices.length, 2);

  // Both devices can authenticate independently.
  assert.ok(await dev1.login());
  assert.ok(await dev2.login());

  // dev2's identity is durable in its storage; a brand-new client logs in.
  const dev2b = srv.client({ storage: dev2.storage });
  await dev2b.login();
  assert.equal(dev2b.deviceId, dev2.deviceId);
});

test('sdk: message exchange — ack, message event (decrypted), delivered receipt', async (t) => {
  const srv = await startServer();
  const aliceName = randUser('alice');
  const bobName = randUser('bob');
  t.after(async () => {
    await srv.deleteUser(aliceName);
    await srv.deleteUser(bobName);
    await srv.stop();
  });

  const alice = srv.client();
  const bob = srv.client();
  await alice.register(aliceName);
  await bob.register(bobName);

  const opened = Promise.all([waitOpen(alice), waitOpen(bob)]);
  alice.connect();
  bob.connect();
  await opened;

  const incoming = waitFor(bob, 'message', (m) => m.text === 'hi bob');
  const receipt = waitFor(alice, 'delivered');

  const sent = await alice.sendMessage(bobName, 'hi bob');
  assert.equal(sent.cids.length, 1);
  const ack = await waitFor(alice, 'ack', (a) => a.cid === sent.cids[0]);
  assert.equal(ack.ok, true);
  assert.equal(ack.localId, sent.localId);

  const msg = await incoming;
  assert.equal(msg.from, aliceName);
  assert.equal(msg.self, false);
  assert.ok(msg.ts > 0);

  const delivered = await receipt;
  assert.equal(delivered.to, bobName);
  assert.equal(delivered.localId, sent.localId);

  // Retention: pulled copies are kept (pulledAt-marked) for the resync window.
  const kept = await srv.mongo.db.collection('messages').find({}).toArray();
  assert.equal(kept.length, 1);
  assert.ok(kept[0].pulledAt instanceof Date, 'copy marked pulled');
  assert.ok(kept[0].expireAt instanceof Date, 'TTL expiry scheduled');

  alice.disconnect();
  bob.disconnect();
});

test('sdk: multi-device recipient — each device gets exactly one copy', async (t) => {
  const srv = await startServer();
  const gimmersName = randUser('gimmers');
  const mikeName = randUser('mike');
  t.after(async () => {
    await srv.deleteUser(gimmersName);
    await srv.deleteUser(mikeName);
    await srv.stop();
  });

  // gimmers on two devices, via the real pairing flow.
  const g1 = srv.client();
  await g1.register(gimmersName);
  const g2 = srv.client();
  const { code } = await g2.beginPairing(gimmersName);
  await g1.approvePairing(code);
  await g2.completePairing({ pollIntervalMs: 100 });

  const mike = srv.client();
  await mike.register(mikeName);

  const opened = Promise.all([waitOpen(g1), waitOpen(g2), waitOpen(mike)]);
  g1.connect();
  g2.connect();
  mike.connect();
  await opened;

  // Mike must learn about BOTH devices (peer keys), then fan out.
  const keys = await mike.peerKeys(gimmersName);
  assert.equal(keys.devices.length, 2);

  const g1Msgs = [];
  const g2Msgs = [];
  const acks = [];
  const receipts = [];
  g1.on('message', (m) => g1Msgs.push(m));
  g2.on('message', (m) => g2Msgs.push(m));
  mike.on('ack', (a) => acks.push(a));
  mike.on('delivered', (d) => receipts.push(d));

  const sent = await mike.sendMessage(gimmersName, 'dual delivery');
  assert.equal(sent.cids.length, 2, 'one envelope per device');

  await Promise.all([
    waitFor(g1, 'message', (m) => m.text === 'dual delivery'),
    waitFor(g2, 'message', (m) => m.text === 'dual delivery'),
  ]);
  await sleep(400); // quiet period: no duplicate deliveries may follow

  assert.equal(g1Msgs.length, 1, 'device 1 got a duplicate');
  assert.equal(g2Msgs.length, 1, 'device 2 got a duplicate');
  assert.notEqual(g1Msgs[0].mid, g2Msgs[0].mid, 'each copy is per-device');
  assert.equal(g1Msgs[0].self, false);

  // Mike gets exactly two acks + two delivered receipts for the one logical
  // message (both cids map to the same localId).
  assert.equal(acks.length, 2);
  assert.ok(acks.every((a) => a.ok && a.localId === sent.localId));
  assert.equal(receipts.length, 2);
  assert.ok(receipts.every((r) => r.to === gimmersName && r.localId === sent.localId));
  const kept = await srv.mongo.db.collection('messages').find({}).toArray();
  assert.equal(kept.length, 2, 'pulled copies retained for resync');
  assert.ok(kept.every((d) => d.pulledAt instanceof Date), 'store pulled-marked');

  mike.disconnect();
  g1.disconnect();
  g2.disconnect();
});

test('sdk: offline recipient gets store-and-forward on connect', async (t) => {
  const srv = await startServer();
  const senderName = randUser('send');
  const offlineName = randUser('offl');
  t.after(async () => {
    await srv.deleteUser(senderName);
    await srv.deleteUser(offlineName);
    await srv.stop();
  });

  const sender = srv.client();
  await sender.register(senderName);
  await sender.connect();
  await waitOpen(sender);

  const offline = srv.client();
  await offline.register(offlineName); // registered but never connected

  const sent = await sender.sendMessage(offlineName, 'queued for you');
  const ack = await waitFor(sender, 'ack', (a) => a.cid === sent.cids[0]);
  assert.equal(ack.ok, true);

  // Queued server-side.
  await sleep(150);
  assert.equal(await srv.mongo.db.collection('messages').countDocuments({ 'to.ul': offlineName }), 1);

  // ...and delivered the moment the device connects.
  const got = waitFor(offline, 'message', (m) => m.text === 'queued for you');
  await offline.connect();
  await waitOpen(offline);
  const msg = await got;
  assert.equal(msg.from, senderName);

  const receipt = await waitFor(sender, 'delivered');
  assert.equal(receipt.localId, sent.localId);
  const keptAfterPull = await srv.mongo.db.collection('messages').find({ 'to.ul': offlineName }).toArray();
  assert.equal(keptAfterPull.length, 1, 'copy retained after pull');
  assert.ok(keptAfterPull[0].pulledAt instanceof Date);
  sender.disconnect();
  offline.disconnect();
});

test('sdk: cancelPairing aborts a pending/completePairing poll', async (t) => {
  const srv = await startServer();
  const username = randUser();
  t.after(async () => {
    await srv.deleteUser(username);
    await srv.stop();
  });

  const dev1 = srv.client();
  await dev1.register(username);

  const dev2 = srv.client();
  await dev2.beginPairing(username);
  dev2.cancelPairing();
  await assert.rejects(dev2.completePairing({ pollIntervalMs: 50 }), (err) => {
    assert.equal(err.code, 'no_pending_pairing'); // never started post-cancel
    return true;
  });

  // Cancel DURING polling: completePairing is running in the background...
  await dev2.beginPairing(username);
  const polling = dev2.completePairing({ pollIntervalMs: 50 });
  setTimeout(() => dev2.cancelPairing(), 100);
  await assert.rejects(polling, (err) => {
    assert.equal(err.code, 'pairing_cancelled');
    return true;
  });

  // ...and a fresh pairing still works afterwards.
  const { code } = await dev2.beginPairing(username);
  await dev1.approvePairing(code);
  const res = await dev2.completePairing({ pollIntervalMs: 50 });
  assert.equal(res.username, username);
});

test('sdk: sendMessage without a connection fails with a clear error', async (t) => {
  const srv = await startServer();
  const username = randUser();
  t.after(async () => {
    await srv.deleteUser(username);
    await srv.stop();
  });

  const client = srv.client();
  await client.register(username);
  await assert.rejects(
    client.sendMessage(randUser('someone'), 'noop'),
    (err) => err.code === 'not_connected',
  );
});

test('sdk: recipient self-heals when sender re-creates their account (stale peer cache)', async () => {
  const srv = await startServer();
  const aliceName = randUser('stalealice');
  const bobName = randUser('stalebob');
  let alice = srv.client();
  await alice.register(aliceName);
  const bob = srv.client();
  await bob.register(bobName);
  await alice.connect(); await waitOpen(alice);
  await bob.connect(); await waitOpen(bob);

  try {
    // Baseline exchange — also primes bob's peer-key cache with OLD alice.
    const first = waitFor(bob, 'message', (m) => m.from === aliceName);
    await alice.sendMessage(bobName, 'pre-recreate');
    await first;

    // Alice is wiped and re-registered: brand-new identity, new device id.
    await srv.deleteUser(aliceName);
    alice.disconnect();
    alice = srv.client();
    await alice.register(aliceName);
    await alice.connect(); await waitOpen(alice);

    const notices = [];
    bob.on('peerIdentityChanged', (e) => notices.push(e));

    // Previously: bob's cached peer data lacked the new device -> frame was
    // dropped as "unknown/device-less sender" and never recovered while the
    // app stayed open. Now: refresh-and-retry delivers it.
    const second = waitFor(bob, 'message', (m) => m.text === 'post-recreate');
    await alice.sendMessage(bobName, 'post-recreate');
    const msg = await second;
    assert.equal(msg.from, aliceName);
    assert.ok(notices.length >= 1, 'peerIdentityChanged surfaced to the UI');
    assert.ok(['new-device', 'key-changed'].includes(notices[0].reason));
  } finally {
    alice.disconnect();
    bob.disconnect();
    await srv.deleteUser(aliceName);
    await srv.deleteUser(bobName);
    await srv.stop();
  }
});

test('sdk: dead session (4401) surfaces authFailed and stops reconnecting', async () => {
  const srv = await startServer();
  const name = randUser('deadsession');
  try {
    const c1 = srv.client();
    await c1.register(name);
    c1.connect();
    await waitOpen(c1);
    // Invalidate the session exactly like a server-side detach would, then
    // reconnect: the WS handshake must fail 4401 and surface authFailed.
    c1.token = 'expired.' + c1.token.slice(8);
    c1.disconnect();
    const failed = waitFor(c1, 'authFailed');
    c1.connect();
    const ev = await failed;
    assert.equal(ev.error.code, 'session_expired');
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(c1.connectionState, 'closed', 'no zombie reconnect loop');
    assert.equal(c1.token, null, 'token dropped');
    c1.disconnect();
    await srv.deleteUser(name);
  } finally {
    await srv.stop();
  }
});

test('sdk: share-link attribution — referrer at signup, hit report afterwards', async (t) => {
  const srv = await startServer();
  const owner = randUser('share');
  const joiner = randUser('join');
  t.after(async () => {
    await srv.deleteUser(owner);
    await srv.deleteUser(joiner);
    await srv.stop();
  });

  const alice = srv.client({ storage: new MemoryStorage() });
  await alice.register(owner);

  // A signup that followed alice's /?chat= link names her as the parent.
  const bobby = srv.client({ storage: new MemoryStorage() });
  await bobby.register(joiner, { referrer: owner.toUpperCase() }); // normalised server-side
  const users = srv.mongo.db.collection('users');
  const doc = await users.findOne({ ul: joiner });
  assert.equal(doc.ref.by, owner);
  const pair = await srv.mongo.db.collection('shares').findOne({ o: owner, viewer: joiner });
  assert.ok(pair?.created instanceof Date, 'created edge recorded at signup');
  assert.equal(pair.n, 0, 'creation is not also counted as a click');

  // An EXISTING account opening the same link reports a 'seen' click...
  const res = await bobby.reportShareHit(owner);
  assert.equal(res.ok, true);
  assert.equal(res.recorded, true);
  const after = await srv.mongo.db.collection('shares').findOne({ o: owner, viewer: joiner });
  assert.equal(after.n, 1);

  // ...your own link is not an attribution event, and is not even sent.
  assert.deepEqual(await bobby.reportShareHit(joiner), { ok: true, recorded: false });
  assert.equal(await srv.mongo.db.collection('shares').countDocuments({ o: joiner }), 0);

  // A deleted/unknown owner is reported as a soft failure, never a throw:
  // attribution must not be able to disturb the app's boot path.
  const gone = await bobby.reportShareHit('nobody-here-at-all');
  assert.equal(gone.ok, false);
  assert.equal(gone.error, 'unknown_account');

  // Without an identity/session the call is refused outright (the app-side
  // wrapper in js/shares.js never gets that far — it checks for a session
  // first and leaves the link parked for the next entry).
  const anon = srv.client({ storage: new MemoryStorage() });
  await assert.rejects(anon.reportShareHit(owner), /No identity|Not logged in/);

  // The owner can see what its link produced — counts only, never who.
  const mine = await alice.myShareLink();
  assert.equal(mine.path, `/?chat=${owner}`);
  assert.equal(mine.created, 1);
  assert.equal(mine.clicked, 1);
});

test('sdk: outgoing sync — own other devices mirror outgoing messages quietly', async (t) => {
  const srv = await startServer();
  const aliceName = randUser('alice');
  const bobName = randUser('bob');
  t.after(async () => {
    await srv.deleteUser(aliceName);
    await srv.deleteUser(bobName);
    await srv.stop();
  });

  // Alice on two devices (real pairing flow), Bob on one.
  const a1 = srv.client();
  await a1.register(aliceName);
  const a2 = srv.client();
  const { code } = await a2.beginPairing(aliceName);
  await a1.approvePairing(code);
  await a2.completePairing({ pollIntervalMs: 100 });
  const bob = srv.client();
  await bob.register(bobName);

  const opened = Promise.all([waitOpen(a1), waitOpen(a2), waitOpen(bob)]);
  a1.connect();
  a2.connect();
  bob.connect();
  await opened;

  const a2Syncs = [];
  const a2Msgs = [];
  const a1Acks = [];
  const a1Receipts = [];
  const bobMsgs = [];
  a2.on('sync', (m) => a2Syncs.push(m));
  a2.on('message', (m) => a2Msgs.push(m));
  a1.on('ack', (a) => a1Acks.push(a));
  a1.on('delivered', (d) => a1Receipts.push(d));
  bob.on('message', (m) => bobMsgs.push(m));

  const sent = await a1.sendMessage(bobName, 'mirror me');

  // Bob gets the real message; Alice's second device gets a SYNC event
  // (never 'message' — that is what keeps every notification emitter off it).
  const [bobMsg, syncEv] = await Promise.all([
    waitFor(bob, 'message', (m) => m.text === 'mirror me'),
    waitFor(a2, 'sync', (m) => m.text === 'mirror me'),
  ]);
  assert.equal(bobMsg.text, 'mirror me');
  assert.equal(syncEv.id, sent.localId, 'sync carries the original localId (same record id on every device)');
  assert.equal(syncEv.peer, bobName);
  assert.ok(syncEv.fromDeviceId && syncEv.fromDeviceId === a1.deviceId);
  assert.ok(typeof syncEv.ts === 'number');
  await sleep(400); // quiet period
  assert.equal(a2Msgs.length, 0, 'sync copies must never surface as messages');

  // Sync acks/receipts are swallowed by the SDK: the visible state on the
  // originating device belongs to the PEER copies only — one ack, and one
  // delivered receipt when Bob pulls (a2 pulling its sync copy is silent).
  assert.equal(a1Acks.length, 1, 'only the peer copy acks surface');
  assert.equal(a1Acks[0].localId, sent.localId);
  assert.equal(a1Acks[0].ok, true);
  assert.equal(a1Receipts.length, 1, "own-device pulls are not 'delivered'");
  assert.equal(a1Receipts[0].localId, sent.localId);
  assert.equal(a1Receipts[0].to, bobName);

  // Server bookkeeping: bob's copy + a2's sync copy, both pulled; no push
  // coalesce key for the sync copy (alice→alice), one for the peer send.
  const kept = await srv.mongo.db.collection('messages').find({ 'from.ul': aliceName.toLowerCase() }).toArray();
  assert.equal(kept.length, 2, 'peer copy + sync copy');
  assert.ok(kept.every((d) => d.pulledAt instanceof Date), 'both pulled');
  assert.ok(kept.every((d) => d.expireAt instanceof Date), 'queue cap stamped on every copy');
  const syncPush = await srv.redis.keys(`pushsent:${aliceName.toLowerCase()}:${a2.deviceId}:*`);
  assert.equal(syncPush.length, 0, 'sync copies never push');

  // Self-chat is untouched: it already reaches every own device as a normal
  // copy — no second sync fan-out, no sync events.
  a2Syncs.length = 0;
  const selfSent = await a1.sendMessage(aliceName, 'note to self');
  const selfMsg = await waitFor(a2, 'message', (m) => m.text === 'note to self');
  assert.equal(selfMsg.self, true);
  await sleep(400);
  assert.equal(a2Syncs.length, 0, 'self-chat must not double-fan-out as sync');
  assert.equal(a2Msgs.length, 1, 'self-chat copy surfaces as a message, once');
  assert.equal(selfSent.cids.length, 2, 'self-chat fans out to both own devices as usual');

  a1.disconnect();
  a2.disconnect();
  bob.disconnect();
});
