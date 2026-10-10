// TAGS over the real SDK: setPeerTags() writes the whole set to the server,
// relationships() mirrors it back to the tagger's devices, and the tagged
// account never sees it. Drives the actual SDK against a live server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, waitOpen, randUser } from './helpers.js';
import { MemoryStorage } from '../src/storage.js';

test('tags: SDK sets/mirrors tags; the tagged party never learns', async (t) => {
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

  // server normalises: dedup + lowercase + enum + sort
  const res = await a.setPeerTags(bobby, ['WORK', 'family', 'bogus']);
  assert.deepEqual(res.tags, ['family', 'work'], 'unknown id dropped, sorted');

  // the tagger's own reconcile view carries the peer → [ids] map
  const relA = await a.relationships();
  assert.deepEqual(relA.tags[String(bobby).toLowerCase()], ['family', 'work']);

  // the tagged account's view shows NOTHING about the tags
  const relB = await b.relationships();
  assert.equal(relB.tags[String(alice).toLowerCase()], undefined);
  assert.deepEqual(Object.keys(relB.tags), [], 'no tags visible to the tagged party');

  // empty set clears (mirror the key vanishes on re-pull)
  const cleared = await a.setPeerTags(bobby, []);
  assert.deepEqual(cleared.tags, []);
  const relA2 = await a.relationships();
  assert.equal(relA2.tags[String(bobby).toLowerCase()], undefined);
});
