// REPORT over the real wire: the SDK's reportUser() reaches the new
// /api/me/report route, the transcript rides along, and the optional
// auto-block lands with the report — after which the reported peer's
// sends are gated exactly like a plain block (ack 'blocked').
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, waitOpen, waitFor, randUser } from './helpers.js';
import { MemoryStorage } from '../src/storage.js';

const codeOf = (e) => e?.code ?? e?.message ?? String(e);

test('report: SDK files a report with transcript; block=true walls the peer off', async (t) => {
  const srv = await startServer();
  const alice = randUser('alice');
  const bobby = randUser('bobby');
  const a = srv.client({ storage: new MemoryStorage() });
  const b = srv.client({ storage: new MemoryStorage() });
  const carol = randUser('carol');
  const c = srv.client({ storage: new MemoryStorage() });
  t.after(async () => {
    for (const cl of [a, b, c]) cl.disconnect?.();
    await srv.deleteUser(alice);
    await srv.deleteUser(bobby);
    await srv.deleteUser(carol);
    await srv.stop();
  });

  await a.register(alice);
  await b.register(bobby);
  await a.connect(); await waitOpen(a);
  await b.connect(); await waitOpen(b);

  const res = await a.reportUser(bobby, {
    reason: 'scamming',
    description: 'sold me a fake badge then ghosted',
    messages: [
      { from: bobby, ts: Date.now() - 5000, text: 'buy my badge!' },
      { dir: 'out', ts: Date.now() - 4000, text: 'no way' },
    ],
    block: true,
  });
  assert.equal(res.reported, true);
  assert.equal(res.blocked, true, 'auto-block landed with the report');

  // the block half is a REAL block: my relationships carry it (with the
  // mapped block reason), and their next send is refused before storage
  const rel = await a.relationships();
  assert.deepEqual(rel.blocked.map((x) => x.peer), [String(bobby).toLowerCase()]);
  assert.equal(rel.blocked[0].reason, 'scam');
  {
    const ack = waitFor(b, 'ack', (p) => p.ok === false && p.error === 'blocked', 8000);
    await b.sendMessage(alice, 'you cannot block me');
    await ack;
  }

  // and their add attempt never lands
  await assert.rejects(() => b.addFriend(alice), (e) => codeOf(e) === 'blocked', 'add gated');

  // report WITHOUT the block checkbox: files, relation untouched
  await c.register(carol);
  await c.connect(); await waitOpen(c);
  const res2 = await a.reportUser(carol, {
    reason: 'other',
    description: 'weird links',
    messages: [{ from: carol, ts: Date.now(), text: 'free gold' }],
  });
  assert.deepEqual(res2, { reported: true, blocked: false });
  const rel2 = await a.relationships();
  assert.equal(rel2.blocked.some((x) => x.peer === String(carol).toLowerCase()), false, 'no block without the checkbox');
});
