// BLOCK over the real wire: the server gates sit in the ws send path (before
// storage — so live delivery, store-and-forward and push ALL inherit them)
// and in the friends-add seam. This drives the actual SDK sockets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, waitOpen, waitFor, randUser } from './helpers.js';
import { MemoryStorage } from '../src/storage.js';

const codeOf = (e) => e?.code ?? e?.message ?? String(e);

test('block: live gates on inbound send, self-send and add; unblock lifts them', async (t) => {
  const srv = await startServer();
  const alice = randUser('alice');
  const bobby = randUser('bobby');
  const a = srv.client({ storage: new MemoryStorage() });
  const b = srv.client({ storage: new MemoryStorage() });
  t.after(async () => {
    for (const c of [a, b]) c.disconnect?.();
    await srv.deleteUser(alice);
    await srv.deleteUser(bobby);
    await srv.stop();
  });

  await a.register(alice);
  await b.register(bobby);
  await a.connect(); await waitOpen(a);
  await b.connect(); await waitOpen(b);

  await a.blockUser(bobby, 'nospeak');

  // their add attempt never lands (403 blocked at the seam)
  await assert.rejects(() => b.addFriend(alice), (e) => codeOf(e) === 'blocked', 'add gated');

  // their message is refused BEFORE storage: nothing queues, nothing pushes.
  // The SDK reports ws-level verdicts as 'ack' EVENTS (sendMessage itself only
  // resolves once the frame is written), so the assertion lives on the ack.
  {
    const ack = waitFor(b, 'ack', (p) => p.ok === false && p.error === 'blocked', 8000);
    await b.sendMessage(alice, 'hey');
    await ack;
  }

  // and I cannot use my own block as an inbox: sending TO a blocked peer fails
  {
    const ack = waitFor(a, 'ack', (p) => p.ok === false && p.error === 'self_blocked', 8000);
    await a.sendMessage(bobby, 'oops');
    await ack;
  }

  // my relationships view carries the block + my stated reason
  const rel = await a.relationships();
  assert.deepEqual(rel.blocked.map((x) => x.peer), [String(bobby).toLowerCase()]);
  assert.equal(rel.blocked[0].reason, 'nospeak');

  // unblock lifts the wall; the relation rebuilds deliberately (fresh entry,
  // no resurrected stages — the server test covers the flags)
  await a.unblockUser(bobby);
  const added = await b.addFriend(alice);
  assert.ok(added.some((f) => f.u === String(alice).toLowerCase()), 're-add lands after unblock');
});
