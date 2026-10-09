// Friends: SDK surface + the E2EE system-message live sync. Server list is
// the source of truth; open devices get {"sys":"friend+/-"} envelopes from
// their own account (never the transcript — that filter is app-level).

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, randUser, waitFor, waitOpen } from './helpers.js';
import { MemoryStorage } from '../src/storage.js';

test('friends: add/list/remove via SDK; live sys message to a second device', async (t) => {
  const srv = await startServer();
  const alice = randUser('alice');
  const bobby = randUser('bobby');
  const dev1 = srv.client({ storage: new MemoryStorage() });
  const dev2 = srv.client({ storage: new MemoryStorage() });
  const bClient = srv.client({ storage: new MemoryStorage() });
  t.after(async () => {
    // close WS first: app.close() waits for connections (their suite pattern)
    for (const c of [dev1, dev2, bClient]) c.disconnect?.();
    await srv.deleteUser(alice);
    await srv.deleteUser(bobby);
    await srv.stop();
  });

  // Bobby exists (friend targets must be real accounts).
  await bClient.register(bobby);

  // Alice with two devices.
  await dev1.register(alice);
  const { code } = await dev2.beginPairing(alice);
  await dev1.pendingPairing(code);
  await dev1.approvePairing(code);
  await dev2.completePairing({ pollIntervalMs: 100 });

  await dev1.connect(); await waitOpen(dev1);
  await dev2.connect(); await waitOpen(dev2);

  // dev2 sees the live system message for dev1's add — now CARRYING the
  // server-stamped identity key, so mirrors converge bound+trusted
  const sysSeen = waitFor(dev2, 'message', (m) => m.peer === dev2.username
    && typeof m.text === 'string' && m.text.startsWith('{"sys":"friend'), 8000);

  const entries = await dev1.addFriend(bobby);
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.u, bobby.toLowerCase());
  assert.equal(entry.trusted, true, 'server-bound identity => trusted');
  assert.ok(typeof entry.p === 'string' && entry.p.length > 20, 'binding is the identity key');

  const sys = await sysSeen;
  const payload = JSON.parse(sys.text);
  assert.equal(payload.sys, 'friend+');
  assert.equal(payload.ul, bobby.toLowerCase());
  assert.equal(payload.p, entry.p, 'sys message carries the same bound key');

  // A brand-new client (proxy for a freshly paired device): server list.
  const dev3 = srv.client({ storage: dev1.storage });
  await dev3.login();
  const list3 = await dev3.listFriends();
  assert.equal(list3.length, 1);
  assert.equal(list3[0].u, bobby.toLowerCase());
  assert.equal(list3[0].trusted, true);

  // Remove: sys friend- + empty list.
  const sysGone = waitFor(dev2, 'message', (m) => m.text?.startsWith('{"sys":"friend-'), 8000);
  assert.deepEqual(await dev1.removeFriend(bobby), []);
  assert.equal(JSON.parse((await sysGone).text).ul, bobby.toLowerCase());
});

test('friends: re-registered username drops trust (changed flag)', async (t) => {
  const srv = await startServer();
  const alice = randUser('alice');
  const bobby = randUser('bobby');
  const dev1 = srv.client({ storage: new MemoryStorage() });
  const bClient = srv.client({ storage: new MemoryStorage() });
  t.after(async () => {
    for (const c of [dev1, bClient]) c.disconnect?.();
    await srv.deleteUser(alice);
    await srv.deleteUser(bobby);
    await srv.stop();
  });

  await dev1.register(alice);
  await bClient.register(bobby);
  await dev1.connect(); await waitOpen(dev1);

  const bound = await dev1.addFriend(bobby);
  assert.equal(bound[0].trusted, true);

  // hard-delete bobby (helper wipes users+messages) then re-register with
  // a NEW identity: the binding must flip to changed/untrusted
  await srv.deleteUser(bobby);
  const bobby2 = srv.client({ storage: new MemoryStorage() });
  t.after(() => bobby2.disconnect?.());
  await bobby2.register(bobby);

  const after = await dev1.listFriends();
  assert.equal(after.length, 1, 'entry not silently dropped — flagged');
  assert.equal(after[0].trusted, false);
  assert.equal(after[0].changed, true);
  bClient.disconnect?.();
  await srv.deleteUser(bobby);
});

test('friends: addFriend to unknown user rejects; self rejects', async (t) => {
  const srv = await startServer();
  const alice = randUser('alice');
  const dev = srv.client({ storage: new MemoryStorage() });
  t.after(async () => {
    dev.disconnect?.();
    await srv.deleteUser(alice);
    await srv.stop();
  });

  await dev.register(alice);
  await dev.connect(); await waitOpen(dev);

  await assert.rejects(() => dev.addFriend('nosuchuser'), /unknown_account|No such user/);
  await assert.rejects(() => dev.addFriend(alice), /self_friend|yourself/);
});

test('friends: verify + trust stages propagate to every device (sys + list)', async (t) => {
  const srv = await startServer();
  const alice = randUser('alice');
  const bobby = randUser('bobby');
  const dev1 = srv.client({ storage: new MemoryStorage() });
  const dev2 = srv.client({ storage: new MemoryStorage() });
  const bClient = srv.client({ storage: new MemoryStorage() });
  t.after(async () => {
    for (const c of [dev1, dev2, bClient]) c.disconnect?.();
    await srv.deleteUser(alice);
    await srv.deleteUser(bobby);
    await srv.stop();
  });

  await bClient.register(bobby);
  await dev1.register(alice);
  const { code } = await dev2.beginPairing(alice);
  await dev1.approvePairing(code);
  await dev2.completePairing({ pollIntervalMs: 100 });
  await dev1.connect(); await waitOpen(dev1);
  await dev2.connect(); await waitOpen(dev2);

  await dev1.addFriend(bobby);
  // verification is MUTUAL-only now: bobby adds alice back so the stages can
  // actually be set (see the 'requires the MUTUAL add' test for the gate)
  await bClient.addFriend(alice);

  const vSys = waitFor(dev2, 'message', (m) => m.text?.startsWith('{"sys":"friend-v'), 8000);
  const entries = await dev1.setFriendVerified(bobby, true);
  assert.equal(entries[0].verified, true);
  assert.equal(JSON.parse((await vSys).text).v, true);

  const tSys = waitFor(dev2, 'message', (m) => m.text?.startsWith('{"sys":"friend-t'), 8000);
  const trusted = await dev1.setFriendTrusted(bobby, true);
  assert.equal(trusted[0].trust, true);
  assert.equal(JSON.parse((await tSys).text).t, true);

  // a third client (fresh reconcile) sees both stages from the server
  const dev3 = srv.client({ storage: dev1.storage });
  await dev3.login();
  const list = await dev3.listFriends();
  assert.equal(list[0].verified, true);
  assert.equal(list[0].trust, true);
});

test('friends: verification requires the MUTUAL add', async (t) => {
  const srv = await startServer();
  const alice = randUser('alice');
  const bobby = randUser('bobby');
  const dev = srv.client({ storage: new MemoryStorage() });
  const bClient = srv.client({ storage: new MemoryStorage() });
  t.after(async () => {
    for (const c of [dev, bClient]) c.disconnect?.();
    await srv.deleteUser(alice);
    await srv.deleteUser(bobby);
    await srv.stop();
  });

  await dev.register(alice);
  await bClient.register(bobby);
  await dev.connect(); await waitOpen(dev);
  await bClient.connect(); await waitOpen(bClient);

  // REAL-TIME: alice's add nudges BOBBY's open connection (content-free
  // 'notice' frame what='request' (a brand-new add got its own nudge kind
  // so the app can OS-notify "someone added you"; re-binds stay 'friends')
  // -> app re-pulls its own list).
  const addNudge = waitFor(bClient, 'notice', (p) => p.what === 'request', 8000);
  const entries = await dev.addFriend(bobby);
  await addNudge;
  assert.equal(entries[0].addedBack, false, 'one-sided add: they have not added us');

  // SETTING verification on a one-sided add is rejected…
  await assert.rejects(() => dev.setFriendVerified(bobby, true), /not_mutual|added you back/);
  // …undo stays possible regardless…
  const off = await dev.setFriendVerified(bobby, false);
  assert.equal(off[0].verified, false);
  // …and so does removing the (one-sided) add itself.

  // mutual now — verification unlocks
  await bClient.addFriend(alice);
  const mut = await dev.listFriends();
  assert.equal(mut[0].addedBack, true);
  const on = await dev.setFriendVerified(bobby, true);
  assert.equal(on[0].verified, true, 'verify works once both sides added each other');
});

test('friends: an un-add breaks the verification on BOTH sides', async (t) => {
  const srv = await startServer();
  const alice = randUser('alice');
  const bobby = randUser('bobby');
  const dev = srv.client({ storage: new MemoryStorage() });
  const bClient = srv.client({ storage: new MemoryStorage() });
  t.after(async () => {
    for (const c of [dev, bClient]) c.disconnect?.();
    await srv.deleteUser(alice);
    await srv.deleteUser(bobby);
    await srv.stop();
  });

  await dev.register(alice);
  await bClient.register(bobby);
  await dev.connect(); await waitOpen(dev);
  await bClient.connect(); await waitOpen(bClient);

  await dev.addFriend(bobby);
  await bClient.addFriend(alice);
  await dev.setFriendVerified(bobby, true);
  await dev.setFriendTrusted(bobby, true);
  await bClient.setFriendVerified(alice, true);
  await bClient.setFriendTrusted(alice, true);
  assert.equal((await bClient.listFriends())[0].verified, true);

  // Alice un-adds Bobby — and his live connection is nudged again.
  const dropNudge = waitFor(bClient, 'notice', (p) => p.what === 'friends', 8000);
  assert.deepEqual(await dev.removeFriend(bobby), []);
  await dropNudge;

  // Her side: the entry is gone entirely.
  assert.deepEqual(await dev.listFriends(), []);

  // HIS side: the add survives, but the confirmed state is DEAD — the server
  // revoked his stored v/t flags, and the read gate keeps them void while
  // the relation is one-sided. Re-verification needs both re-added.
  const bList = await bClient.listFriends();
  assert.equal(bList.length, 1);
  assert.equal(bList[0].u, alice.toLowerCase());
  assert.equal(bList[0].addedBack, false, 'alice un-added bobby');
  assert.equal(bList[0].verified, false, 'verification broken for the un-ADDED side too');
  assert.equal(bList[0].trust, false);
  await assert.rejects(() => bClient.setFriendVerified(alice, true), /not_mutual|added you back/);
});

test('notice: a profile edit nudges exactly the accounts that added you', async (t) => {
  const srv = await startServer();
  const alice = randUser('alice');
  const bobby = randUser('bobby');
  const carol = randUser('carol');
  const dev = srv.client({ storage: new MemoryStorage() });
  const bClient = srv.client({ storage: new MemoryStorage() });
  const cClient = srv.client({ storage: new MemoryStorage() });
  t.after(async () => {
    for (const c of [dev, bClient, cClient]) c.disconnect?.();
    await srv.deleteUser(alice);
    await srv.deleteUser(bobby);
    await srv.deleteUser(carol);
    await srv.stop();
  });

  await dev.register(alice);
  await bClient.register(bobby);
  await cClient.register(carol);
  await dev.connect(); await waitOpen(dev);
  await bClient.connect(); await waitOpen(bClient);
  await cClient.connect(); await waitOpen(cClient);

  // bobby follows alice; carol does not — only followers hear.
  await bClient.addFriend(alice);

  const follower = waitFor(bClient, 'notice', (p) => p.what === 'profile', 8000);
  const seenByCarol = [];
  const offCarol = cClient.on('notice', (p) => seenByCarol.push(p));
  await dev.setProfile({ bio: 'real-time refresh me' });
  await follower;
  await new Promise((r) => setTimeout(r, 500)); // grace: let a stray frame surface
  offCarol();
  assert.deepEqual(
    seenByCarol.filter((p) => p.what === 'profile'),
    [],
    'carol (does not follow alice) must NOT be nudged',
  );
});

test('notice: a deleted account nudges its followers with what="gone" (pillage-free)', async (t) => {
  const srv = await startServer();
  const alice = randUser('alice');
  const carol = randUser('carol');
  const dev = srv.client({ storage: new MemoryStorage() });
  const cClient = srv.client({ storage: new MemoryStorage() });
  t.after(async () => {
    for (const c of [dev, cClient]) c.disconnect?.();
    await srv.deleteUser(alice);
    await srv.deleteUser(carol);
    await srv.stop();
  });

  await dev.register(alice);
  await cClient.register(carol);
  await dev.connect(); await waitOpen(dev);
  await cClient.connect(); await waitOpen(cClient);

  // alice follows carol; carol sends one message so there is history.
  await dev.addFriend(carol);
  await dev.sendMessage(carol, 'see you in the sidebar');

  // carol detaches her LAST device => account deleted outright.
  const goneNudge = waitFor(dev, 'notice', (p) => p.what === 'gone', 8000);
  const identity = await cClient.storage.loadIdentity();
  await cClient.removeDevice(identity.deviceId);

  await goneNudge; // the purge tells followers BEFORE erasing the references
  const list = await dev.listFriends();
  assert.deepEqual(list, [], 'entry purged server-side (the app turns this into the deleted icon + pill)');

  // content-free: the nudge carries nothing but the 'gone' label — alice
  // learns only via her OWN authenticated read that her list emptied.
  const keys = await dev.peerKeys(carol, { refresh: true }).catch((err) => err);
  assert.ok(keys?.code === 'unknown_account' || keys?.status === 404, 'dead account resolves 404 (handleGonePeer verdict)');
});
