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
