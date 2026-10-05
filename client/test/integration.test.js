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
  assert.equal(devices[0].main, true);
  assert.equal(devices[0].current, true);
  assert.equal(maxDevices, 3);

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
