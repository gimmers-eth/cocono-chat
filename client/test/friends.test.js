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

  // dev2 sees the live system message for dev1's add.
  const sysSeen = waitFor(dev2, 'message', (m) => m.peer === dev2.username
    && typeof m.text === 'string' && m.text.startsWith('{"sys":"friend'), 8000);

  const list = await dev1.addFriend(bobby);
  assert.deepEqual(list, [bobby.toLowerCase()]);

  const sys = await sysSeen;
  const payload = JSON.parse(sys.text);
  assert.equal(payload.sys, 'friend+');
  assert.equal(payload.ul, bobby.toLowerCase());

  // A brand-new client (proxy for a freshly paired device): server list.
  const dev3 = srv.client({ storage: dev1.storage });
  await dev3.login();
  assert.deepEqual(await dev3.listFriends(), [bobby.toLowerCase()]);

  // Remove: sys friend- + empty list.
  const sysGone = waitFor(dev2, 'message', (m) => m.text?.startsWith('{"sys":"friend-'), 8000);
  assert.deepEqual(await dev1.removeFriend(bobby), []);
  assert.equal(JSON.parse((await sysGone).text).ul, bobby.toLowerCase());
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
