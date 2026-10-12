// The local store's contracts that are not media: what a deliberate delete
// leaves behind, and how that interacts with the server-side replay.
//
// Why this file exists: "I cleared the chat and a refresh brought it all back" is
// invisible to any test that only looks at the store. The clear WORKS — the rows
// are gone. What undoes it is chat.js's recovery path: an empty transcript looks
// exactly like a browser that evicted IndexedDB, so the app asks the server to
// replay the copies it still retains. The two readings of "empty" want opposite
// things, and only a marker left by the deliberate act can tell them apart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installIdbShim } from './idbshim.js';
import { installDomShim } from './domshim.js';

const shim = installIdbShim();
installDomShim();
const store = await import('../app/js/store.js');

/** The exact gate chat.js uses on socket open. */
const wouldResync = async () => (await store.allMessages()).length === 0 && !store.transcriptClearedAt();

test('store: a deliberate clear is remembered, so the replay cannot undo it', async () => {
  shim.reset();
  store.setScope('alice');
  await store.saveMessage({ id: 'in:1', peer: 'bobby', dir: 'in', text: 'hi', ts: 1 });
  assert.equal(store.transcriptClearedAt(), 0, 'nothing was cleared on purpose yet');
  assert.equal(await wouldResync(), false, 'a non-empty transcript never asks for a replay');

  const n = await store.clearMessages('bobby');
  assert.equal(n, 1, 'the clear really deleted the row');
  assert.equal((await store.allMessages()).length, 0);
  assert.ok(store.transcriptClearedAt() > 0, 'and the device remembers it was ON PURPOSE');
  assert.equal(await wouldResync(), false,
    'so the recovery replay — which would hand back exactly what was just deleted — is not requested');

  // A message arriving afterwards ends the embargo. This is the part that keeps
  // the recovery path alive: clear today, receive mail tomorrow, lose the browser
  // store next week and tomorrow's mail must still come back.
  await store.saveMessage({ id: 'in:2', peer: 'bobby', dir: 'in', text: 'new', ts: 2 });
  assert.equal(store.transcriptClearedAt(), 0, 'the marker dies with the first new message');
  assert.equal(await wouldResync(), false);

  await store.clearAllMessages();
  assert.equal((await store.allMessages()).length, 0);
  assert.ok(store.transcriptClearedAt() > 0, 'clear-ALL marks too');
  assert.equal(await wouldResync(), false);
});

test('store: clearing ONE conversation does not cost the others their recovery', async () => {
  // its own account: localStorage outlives shim.reset(), so a marker written by
  // an earlier test would otherwise be this test's answer
  shim.reset();
  store.setScope('erin');
  await store.saveMessage({ id: 'in:1', peer: 'bobby', dir: 'in', text: 'hi', ts: 1 });
  await store.saveMessage({ id: 'in:2', peer: 'dora', dir: 'in', text: 'yo', ts: 2 });

  await store.clearMessages('bobby');
  assert.equal((await store.messagesWith('bobby')).length, 0, 'bobby is gone');
  assert.equal((await store.messagesWith('dora')).length, 1, 'dora is not');
  assert.equal(store.transcriptClearedAt(), 0,
    'and no marker: the transcript is not empty, so the recovery path was never ambiguous');

  // …so a later eviction still recovers. The scope has to actually CHANGE to drop
  // store.js's cached connection: an eviction takes the database, not the handle
  // this module is holding, and setScope() short-circuits when the name matches.
  shim.reset();
  store.setScope('nobody');
  store.setScope('erin');
  assert.equal((await store.allMessages()).length, 0, 'the database really is gone');
  assert.equal(await wouldResync(), true, 'dora’s mail is still recoverable');
});

test('store: an eviction with no clear behind it still asks for the replay', async () => {
  shim.reset();                                  // the browser took the database
  store.setScope('carol');
  assert.equal((await store.allMessages()).length, 0);
  assert.equal(store.transcriptClearedAt(), 0, 'nobody deleted anything on purpose');
  assert.equal(await wouldResync(), true,
    'this is the case the recovery path exists for — it must keep working');
});

test('store: the clear marker is per-account and dies with the account data', async () => {
  shim.reset();
  store.setScope('alice');
  await store.saveMessage({ id: 'in:1', peer: 'bobby', dir: 'in', text: 'hi', ts: 1 });
  await store.clearAllMessages();
  assert.ok(store.transcriptClearedAt() > 0);

  store.setScope('bobby');
  assert.equal(store.transcriptClearedAt(), 0,
    'another account on this browser must not inherit alice’s deliberate empty');

  store.setScope('alice');
  await store.deleteAccountData('alice');        // 'Forget this device'
  assert.equal(store.transcriptClearedAt(), 0,
    'and forgetting the device takes the marker with it — a re-pair starts clean');
});
