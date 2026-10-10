// The app-side media PIPELINE, run for real: store.js on a shimmed
// IndexedDB, media.js's policy functions, and a stub client standing in for
// the SDK's three media calls. This is the part a browser-only manual smoke
// would otherwise cover — what auto-downloads, what gets acked, what a failed
// fetch becomes, what the retention sweep drops — against the same records the
// UI paints from.
//
// The SDK calls are stubbed (not the backend): the transport half is covered
// end-to-end in media.test.js against the real server. What is being tested
// here is the APP's decisions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installIdbShim } from './idbshim.js';
import { startServer, waitFor, waitOpen, randUser } from './helpers.js';

const shim = installIdbShim();

// store.js reads the globals at import time — install the shim FIRST
const store = await import('../app/js/store.js');
const M = await import('../app/js/media.js');

const USER = 'tester';
let seq = 0;

async function freshAccount() {
  shim.reset();
  store.setScope(`${USER}${++seq}`);
  return store;
}

function stubRow(over = {}) {
  return {
    id: 'blob-1', blobId: 'blob-1', peer: 'bobby', dir: 'in', kind: 'image',
    name: 'a.jpg', mime: 'image/jpeg', size: 10, key: 'key', iv: 'aXY=',
    thumbIv: 'dGh1', sha256: 'abc', state: 'pending', keep: false, blurred: null,
    data: null, thumb: null, msgId: 'in:m1', ts: Date.now(), ...over,
  };
}

/** A client whose three media calls do what the test says they do. */
function fakeClient({ fail = null, thumbFail = false } = {}) {
  const calls = [];
  return {
    calls,
    async downloadMedia(id) {
      calls.push({ what: 'download', id });
      if (fail) throw fail(typeof id === 'string' && id.startsWith('blob') ? new Error('x') : new Error('x'));
      return { data: new Blob([`plain bytes for ${id}`]), thumb: thumbFail ? null : new Blob([`thumb for ${id}`]) };
    },
    async downloadThumb(id) {
      calls.push({ what: 'thumb', id });
      if (fail) throw fail(new Error('gone'));
      return new Blob([`thumb for ${id}`]);
    },
    async ackMedia(id, downloaded) {
      calls.push({ what: 'ack', id, downloaded });
      return { ok: true, deleted: downloaded };
    },
  };
}

const notFound = () => Object.assign(new Error('No such attachment'), { code: 'unknown_media', status: 404 });
const offline = () => Object.assign(new Error('fetch failed'), { code: 'TypeError' });

test('pipeline: an incoming IMAGE auto-downloads, stores, then acks', async () => {
  await freshAccount();
  const cli = fakeClient();
  const row = M.mediaRow({
    key: 'blob-1', peer: 'bobby', dir: 'in', kind: 'image',
    media: { id: 'blob-1', kind: 'image', name: 'a.jpg', mime: 'image/jpeg', size: 10, key: 'k', iv: 'i', thumbIv: 't', sha256: 's' },
    msgId: 'in:m1', ts: Date.now(),
  });
  await store.saveMedia(row);
  const res = await M.applyArrivalPolicy(cli, row);

  assert.equal(res.state, 'stored');
  const after = await store.getMedia('blob-1');
  assert.ok(after.data instanceof Blob, 'the decrypted bytes are on the device');
  assert.ok(after.thumb instanceof Blob, 'and so is the thumbnail the bubble paints');
  assert.equal(after.state, 'stored');
  assert.equal(after.blurred, null, 'no override: the verified flag decides at render');
  // THE ORDER matters: ack only after the bytes landed (req 8)
  assert.deepEqual(cli.calls.map((c) => c.what), ['download', 'ack']);
  assert.equal(cli.calls[1].downloaded, true);
});

test('pipeline: a VIDEO pulls its poster only and never acks', async () => {
  await freshAccount();
  const cli = fakeClient();
  const row = M.mediaRow({
    key: 'v1', peer: 'bobby', dir: 'in', kind: 'video',
    media: { id: 'v1', kind: 'video', name: 'clip.mp4', mime: 'video/mp4', size: 9_000_000, key: 'k', iv: 'i', thumbIv: 't', sha256: 's' },
    msgId: 'in:m2', ts: Date.now(),
  });
  await store.saveMedia(row);
  const res = await M.applyArrivalPolicy(cli, row);

  assert.equal(res.state, 'pending', 'the full bytes still wait behind the button');
  assert.deepEqual(cli.calls.map((c) => c.what), ['thumb'], 'a poster fetch is not a download');
  const after = await store.getMedia('v1');
  assert.ok(after.thumb instanceof Blob, 'the poster is what the bubble and the wall show');
  assert.equal(after.data, null);
});

test('pipeline: a FILE waits for the user entirely', async () => {
  await freshAccount();
  const cli = fakeClient();
  const row = M.mediaRow({
    key: 'f1', peer: 'bobby', dir: 'in', kind: 'file',
    media: { id: 'f1', kind: 'file', name: 'x.pdf', mime: 'application/pdf', size: 100, key: 'k', iv: 'i', sha256: 's' },
    msgId: 'in:m3', ts: Date.now(),
  });
  await store.saveMedia(row);
  await M.applyArrivalPolicy(cli, row);
  assert.deepEqual(cli.calls, [], 'req 6: nothing leaves the device until asked');
  assert.equal((await store.getMedia('f1')).state, 'pending');
});

test('pipeline: download failure is recoverable, a 404 is final — and both settle the ack', async () => {
  await freshAccount();
  // offline blip → 'failed' (the retry queue owns it), NO ack (the blob must
  // stay so the retry can succeed)
  const cli1 = fakeClient({ fail: offline });
  const row = M.mediaRow({ key: 'b-1', peer: 'bobby', dir: 'in', kind: 'image', media: { id: 'b-1', kind: 'image', key: 'k', iv: 'i', sha256: 's' }, msgId: 'in:1', ts: 1 });
  await store.saveMedia(row);
  const r1 = await M.downloadMedia(cli1, row);
  assert.equal(r1.state, 'failed');
  assert.deepEqual(cli1.calls.map((c) => c.what), ['download'], 'a failed fetch never acks');
  assert.equal((await store.getMedia('b-1')).state, 'failed');

  // retried on the next open
  const cli2 = fakeClient();
  const n = await M.retryFailedDownloads(cli2);
  assert.equal(n, 1, 'the retry queue picked it up');
  assert.equal((await store.getMedia('b-1')).state, 'stored');

  // a swept blob → 'expired', and it IS acked: holding it pending would pin a
  // reference to bytes that no longer exist (and block req 8 for everyone else)
  const cli3 = fakeClient({ fail: notFound });
  const row3 = M.mediaRow({ key: 'b-2', peer: 'bobby', dir: 'in', kind: 'image', media: { id: 'b-2', kind: 'image', key: 'k', iv: 'i', sha256: 's' }, msgId: 'in:2', ts: 1 });
  await store.saveMedia(row3);
  const r3 = await M.downloadMedia(cli3, row3);
  assert.equal(r3.state, 'expired');
  assert.deepEqual(cli3.calls.map((c) => c.what), ['download', 'ack']);
  assert.equal((await store.getMedia('b-2')).state, 'expired');

  // expired is FINAL: the retry queue must not hammer it every reconnect
  const cli4 = fakeClient();
  assert.equal(await M.retryFailedDownloads(cli4), 0);
});

test('pipeline: decline deletes nothing locally that the user still sees, and acks false', async () => {
  await freshAccount();
  const cli = fakeClient();
  const row = M.mediaRow({ key: 'f9', peer: 'bobby', dir: 'in', kind: 'file', media: { id: 'f9', kind: 'file', name: 'big.zip', key: 'k', iv: 'i', sha256: 's' }, msgId: 'in:9', ts: 1 });
  await store.saveMedia(row);
  const res = await M.declineMedia(cli, row);
  assert.equal(res.ok, true);
  assert.deepEqual(cli.calls, [{ what: 'ack', id: 'f9', downloaded: false }]);
  const after = await store.getMedia('f9');
  assert.equal(after.state, 'declined');
  assert.equal(after.data, null, 'req 6: delete-before-download leaves no bytes behind');
});

test('pipeline: a completed download is stamped, so the next sweep spares it', async () => {
  await freshAccount();
  M.setLocalRetentionDays(7);
  const day = 86_400_000;
  const oldTs = Date.now() - 30 * day;   // a message from a month ago
  const cli = fakeClient();
  const row = M.mediaRow({ key: 'late', peer: 'bobby', dir: 'in', kind: 'file',
    media: { id: 'late', kind: 'file', name: 'late.pdf', key: 'k', iv: 'i', sha256: 's' },
    msgId: 'in:late', ts: oldTs });
  await store.saveMedia(row);
  await M.downloadMedia(cli, row);

  const after = await store.getMedia('late');
  assert.equal(after.state, 'stored');
  assert.ok(after.storedAt >= oldTs, 'the record knows WHEN the bytes arrived');
  assert.equal(await M.pruneLocalMedia(), 0,
    'and a file the user just chose to download is not dropped minutes later');

  // pin it into the past and the very same record IS due
  await store.updateMedia('late', { storedAt: Date.now() - 9 * day });
  assert.equal(await M.pruneLocalMedia(), 1);
  assert.equal((await store.getMedia('late')).state, 'pruned');
});

test('pipeline: an outgoing row with no blob id yet never calls the wire', async () => {
  await freshAccount();
  const cli = fakeClient();
  const row = M.mediaRow({ key: 'out:abc', blobId: null, peer: 'bobby', dir: 'out', kind: 'image', media: { name: 'x', key: 'k' }, msgId: 'out:abc', ts: 1 });
  await store.saveMedia(row);
  const res = await M.downloadMedia(cli, row);
  assert.equal(res.ok, false);
  assert.deepEqual(cli.calls, [], 'nothing to download from — the id is local');
});

test('pipeline: local retention drops bytes, keeps the record, honours Keep', async () => {
  await freshAccount();
  const day = 86_400_000;
  // the window is set THROUGH the app's own setter (localStorage-backed), so
  // this exercises the same path the settings drawer uses
  M.setLocalRetentionDays(7);
  const old = Date.now() - 40 * day;
  // storedAt is set with the bytes (the retention clock starts when they
  // LAND, not when the message was sent) — these rows are genuinely old copies
  const mk = (id, kind, over) => store.saveMedia(stubRow({ id, kind, ts: old, storedAt: old, state: 'stored', data: new Blob(['bytes']), thumb: new Blob(['t']), ...over }));
  await mk('img-old', 'image');
  await mk('img-pinned', 'image', { keep: true });
  await mk('file-old', 'file');
  await store.saveMedia(stubRow({ id: 'img-new', kind: 'image', ts: Date.now(), storedAt: Date.now(), state: 'stored', data: new Blob(['bytes']), thumb: new Blob(['t']) }));

  const dropped = await M.pruneLocalMedia();
  assert.equal(dropped, 2, 'the two unpinned out-of-window rows (not the pinned one, not the fresh one)');

  const img = await store.getMedia('img-old');
  assert.equal(img.state, 'pruned');
  assert.equal(img.data, null, 'the megabytes are gone');
  assert.ok(img.thumb, 'the thumbnail stays: the wall still has a picture');
  assert.equal(img.name, 'a.jpg', 'name/size/date survive — the record is not destroyed');

  const file = await store.getMedia('file-old');
  assert.equal(file.thumb, null, 'a file has no preview worth keeping');

  assert.ok((await store.getMedia('img-pinned')).data, 'Keep means Keep');
  assert.ok((await store.getMedia('img-new')).data, 'inside the window: untouched');
  assert.equal(M.localRetentionDays(), 7);
});

test('pipeline: a media message paints as media, and the tabs find it', async () => {
  await freshAccount();
  const media = { id: 'b7', kind: 'file', name: '../../secrets.pdf', mime: 'application/pdf', size: 1234, key: 'k', iv: 'i', sha256: 's' };
  await store.saveMessage({ id: 'in:b7', peer: 'bobby', dir: 'in', text: M.mediaLabel('file', 'secrets.pdf'), kind: 'file', mediaId: 'b7', ts: 5 });
  await store.saveMedia(M.mediaRow({ key: 'b7', peer: 'bobby', dir: 'in', kind: 'file', media, msgId: 'in:b7', ts: 5 }));

  const msgs = await store.messagesWith('bobby');
  const rows = await store.mediaWith('bobby');
  assert.equal(msgs[0].kind, 'file', 'the transcript row carries the kind (no join needed for the tabs)');
  assert.equal(rows[0].name, 'secrets.pdf', 'the path components are stripped at the door');
  const buckets = M.tabBuckets(msgs, rows);
  assert.deepEqual(buckets.files.map((r) => r.id), ['b7']);
  assert.deepEqual(buckets.images, []);
  // clearing the conversation takes the decrypted bytes with it (device-local,
  // same contract as the transcript)
  assert.equal(await store.clearMediaWith('bobby'), 1);
  assert.deepEqual(await store.mediaWith('bobby'), []);
  assert.equal((await store.messagesWith('bobby')).length, 1, 'messages clear separately');
});

test('pipeline: a video WITHOUT a poster cannot delete itself (req 8 is sacred)', async () => {
  await freshAccount();
  // the sender's browser could not capture a frame (normal on iOS): the
  // descriptor has no thumbIv, and the server answers a poster request with
  // 404 no_thumb. Both used to read as "the blob is gone" — and the ack that
  // follows an 'expired' record DELETES the video for every device.
  const noPoster = M.mediaRow({
    key: 'v0', peer: 'bobby', dir: 'in', kind: 'video',
    media: { id: 'v0', kind: 'video', name: 'clip.mp4', mime: 'video/mp4', size: 4_000_000, key: 'k', iv: 'i', sha256: 's' },
    msgId: 'in:v0', ts: 1,
  });
  await store.saveMedia(noPoster);
  const cli = fakeClient();
  const res = await M.applyArrivalPolicy(cli, noPoster);
  assert.deepEqual(cli.calls, [], 'not even a request: there is nothing to preview');
  assert.equal(res.state, 'pending');
  assert.equal((await store.getMedia('v0')).state, 'pending', 'the record waits for the user');

  // and a poster request that comes back 404 must not move the state either
  const withPoster = M.mediaRow({
    key: 'v1', peer: 'bobby', dir: 'in', kind: 'video',
    media: { id: 'v1', kind: 'video', name: 'clip.mp4', mime: 'video/mp4', size: 4_000_000, key: 'k', iv: 'i', thumbIv: 't', sha256: 's' },
    msgId: 'in:v1', ts: 1,
  });
  await store.saveMedia(withPoster);
  const cli2 = {
    calls: [],
    async downloadThumb() { this.calls.push('thumb'); throw Object.assign(new Error('no preview'), { code: 'no_thumb', status: 404 }); },
    async downloadMedia() { this.calls.push('download'); return { data: new Blob(['x']) }; },
    async ackMedia() { this.calls.push('ack'); },
  };
  const res2 = await M.applyArrivalPolicy(cli2, withPoster);
  assert.equal(res2.ok, false);
  assert.deepEqual(cli2.calls, ['thumb'], 'a failed DECORATION fetches nothing else');
  assert.equal((await store.getMedia('v1')).state, 'pending', 'still waiting for the Download button');

  // the same 404 on the FULL blob is genuinely 'gone' → settled with an ack
  const cli3 = {
    calls: [],
    async downloadMedia() { this.calls.push('download'); throw Object.assign(new Error('gone'), { code: 'unknown_media', status: 404 }); },
    async ackMedia(id, d) { this.calls.push(`ack:${d}`); },
  };
  const res3 = await M.downloadMedia(cli3, { id: 'v2', blobId: 'v2', key: 'k', kind: 'video', state: 'pending' });
  assert.equal(res3.state, 'expired');
  assert.deepEqual(cli3.calls, ['download', 'ack:true'], 'a payload that IS gone gets settled');
});

// The bug this guards: a VIDEO whose sender could not produce a poster (iOS
// canvas capture failing on a phone is normal) arrived, the recipient's app
// fetched ?part=thumb, got a 404, read it as "the payload is gone", marked the
// record expired and ACKED it — and that ack deleted the video for every
// device. So this runs the app's real policy against the real SDK and the real
// server: the poster half must be harmless, and only the full download may
// settle the lifecycle.
test('pipeline against the real server: a poster-less video survives, then downloads', async (t) => {
  const srv = await startServer();
  const aliceName = randUser('alice');
  const bobName = randUser('bob');
  const sendMedia = new Uint8Array(Array.from({ length: 4096 }, (_, i) => i % 251));
  t.after(async () => {
    await srv.deleteUser(aliceName);
    await srv.deleteUser(bobName);
    await srv.stop();
  });
  shim.reset();
  store.setScope(`live${++seq}`);

  const alice = srv.client();
  const bob = srv.client();
  await alice.register(aliceName);
  await bob.register(bobName);
  alice.connect(); bob.connect();
  await Promise.all([waitOpen(alice), waitOpen(bob)]);

  // NO thumb passed: this is the phone case
  const sent = await alice.sendMedia(bobName, {
    kind: 'video', bytes: sendMedia, name: 'clip.mp4', mime: 'video/mp4', dur: 3.5,
  });
  assert.equal(sent.media.thumbIv, undefined, 'the descriptor honestly says there is no poster');
  const msg = await waitFor(bob, 'message', (m) => m.text.startsWith('{"media":'), 20000);
  const media = JSON.parse(msg.text).media;

  const row = M.mediaRow({ key: media.id, peer: bobName, dir: 'in', kind: 'video', media, msgId: 'in:1', ts: msg.ts });
  await store.saveMedia(row);

  const res = await M.applyArrivalPolicy(bob, row);
  assert.equal(res.ok, false, 'the poster step reports it did nothing');
  assert.equal(res.state, 'pending', 'and the record still waits for the user');
  assert.ok(await srv.mongo.db.collection('media').findOne({ _id: media.id }),
    'THE VIDEO IS STILL ON THE SERVER — a preview failure must not delete payload');
  assert.equal((await store.getMedia(media.id)).state, 'pending');

  // the user's Download button then does the real thing, and THAT acks
  const full = await M.downloadMedia(bob, { ...row, state: 'pending' });
  assert.equal(full.state, 'stored');
  const stored = await store.getMedia(media.id);
  assert.deepEqual(new Uint8Array(await stored.data.arrayBuffer()), sendMedia);
  assert.equal(await srv.mongo.db.collection('media').findOne({ _id: media.id }), null,
    'the last device to ack released it (req 8)');
  alice.disconnect(); bob.disconnect();
});
