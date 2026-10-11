// The app's media PIPELINE, executed: store.js on a shimmed IndexedDB, the real
// crypto from the SDK, and a client stub that speaks the SDK's actual primitives
// (fetch bytes with an offset / verify+decrypt / ack). This is the code that
// decides what auto-downloads, what is acked, what survives an interrupted
// fetch and what ages out — all of it reachable without a browser, and none of
// it reachable by a stub that fakes the crypto away.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { installIdbShim } from './idbshim.js';
import * as c from '../src/crypto.js';
import { b64uEncode } from '../src/encoding.js';
import { startServer, waitFor, waitOpen, sleep, randUser } from './helpers.js';

const shim = installIdbShim();

// store.js reads the globals at import time — install the shim FIRST
const store = await import('../app/js/store.js');
const M = await import('../app/js/media.js');

const PAYLOAD = new Uint8Array(Array.from({ length: 600 }, (_, i) => (i * 13) % 251));
const USER = 'tester';
let seq = 0;

async function freshAccount() {
  shim.reset();
  store.setScope(`${USER}${++seq}`);
  return store;
}

/** Encrypt the way a sender does, and return the descriptor fields a row needs. */
async function makeCipher(payload = PAYLOAD) {
  const key = await c.generateFileKey();
  const keyB64u = await c.exportRawAesKey(key);
  const ct = await c.encryptBytes(key, payload);
  return {
    ct,
    media: {
      key: keyB64u,
      sha256: createHash('sha256').update(ct).digest('base64url'),
      iv: b64uEncode(ct.slice(0, 12)),
    },
  };
}

/**
 * A client speaking the SDK's media primitives. `failAfter` cuts the stream
 * after N bytes — that is what an interrupted 100 MB fetch looks like, and the
 * only way to prove the bytes already paid for are kept and re-used.
 */
function pipelineClient({ ct, media, chunks = 4, failAfter = null } = {}) {
  const calls = [];
  let delivered = 0;
  return {
    calls,
    get delivered() { return delivered; },
    async fetchMediaBytes(id, { start = 0, onChunk, onProgress } = {}) {
      calls.push({ what: 'download', id, start });
      const rest = ct.slice(start);
      const size = Math.max(1, Math.ceil(rest.length / chunks));
      let at = 0;
      while (at < rest.length) {
        if (failAfter !== null && delivered >= failAfter) {
          throw Object.assign(new Error('connection dropped'), { code: 'upload_failed' });
        }
        const part = rest.slice(at, at + size);
        at += part.length;
        delivered += part.length;
        onChunk?.(part, start + at, ct.length);
        // the real client reports progress too; a stub that skipped it let a
        // crash in that exact callback pass every test in the file
        if (typeof onProgress !== 'function') throw new TypeError('fetchMediaBytes must hand onProgress to the caller');
        onProgress?.(start + at, ct.length);
      }
      return rest;
    },
    async decryptMediaBytes(bytes, m) {
      calls.push({ what: 'verify' });
      // the same digest check the SDK performs: a resume that stitched the
      // wrong offset together fails HERE, before anything is acked
      const got = createHash('sha256').update(bytes).digest('base64url');
      if (m?.sha256 && got !== m.sha256) {
        throw Object.assign(new Error('digest mismatch'), { code: 'media_tampered' });
      }
      const plain = await c.decryptBytes(await c.importFileKey(m.key), bytes);
      return new Blob([plain], { type: m.mime || 'application/octet-stream' });
    },
    async downloadThumb() { calls.push({ what: 'thumb' }); return new Blob(['poster']); },
    async ackMedia(id, downloaded) { calls.push({ what: 'ack', id, downloaded }); return { ok: true, deleted: downloaded }; },
  };
}

/** An incoming media row for a real ciphertext, in the shape the wire gives. */
function rowFor({ id = 'blob-1', peer = 'bobby', dir = 'in', kind = 'image', name = 'a.jpg', mime = 'image/jpeg' }, cipher) {
  return M.mediaRow({
    key: id, peer, dir, kind,
    media: { id, kind, name, mime, size: PAYLOAD.length, thumbIv: 'dGh1', ...cipher.media },
    msgId: `${dir === 'in' ? 'in' : 'out'}:${id}`, ts: Date.now(),
  });
}

const notFound = () => Object.assign(new Error('No such attachment'), { code: 'unknown_media', status: 404 });

// ---------------- arrival policy ----------------

test('pipeline: an incoming IMAGE auto-downloads, is verified, then acks', async () => {
  await freshAccount();
  const cipher = await makeCipher();
  const row = rowFor({}, cipher);
  await store.saveMedia(row);
  const cli = pipelineClient(cipher);
  const res = await M.applyArrivalPolicy(cli, row);

  assert.equal(res.state, 'stored');
  const after = await store.getMedia('blob-1');
  assert.deepEqual(new Uint8Array(await after.data.arrayBuffer()), PAYLOAD, 'the decrypted bytes are on the device');
  assert.ok(after.thumb, 'and so is the poster the bubble paints');
  assert.equal(after.state, 'stored');
  assert.ok(after.storedAt > 0, 'the record knows when the bytes landed');
  assert.equal(after.blurred, null, 'no override: the sender-verified flag decides at render');
  // fetch → verify → ack, in that order: an unverified download must never
  // settle the lifecycle (req 8)
  assert.deepEqual(cli.calls.map((x) => x.what), ['download', 'verify', 'thumb', 'ack']);
  assert.equal(cli.calls.at(-1).downloaded, true);
});

test('pipeline: a BIG video pulls its poster only and never acks', async () => {
  await freshAccount();
  const cipher = await makeCipher();
  // size is what the policy reads, so the claim is what decides: over the
  // courtesy threshold nothing is fetched without asking (see the small-video
  // test below for the other half)
  const row = { ...rowFor({ kind: 'video', name: 'clip.mp4', mime: 'video/mp4' }, cipher), size: M.VIDEO_AUTO_MAX_BYTES + 1 };
  await store.saveMedia(row);
  const cli = pipelineClient(cipher);
  const res = await M.applyArrivalPolicy(cli, row);

  assert.equal(res.state, 'pending', 'the payload still waits behind the button');
  assert.deepEqual(cli.calls.map((x) => x.what), ['thumb'], 'a poster fetch is not a download');
  assert.ok((await store.getMedia('blob-1')).thumb, 'the poster is what the bubble shows meanwhile');
});

test('pipeline: a poster-less video cannot delete itself — req 8 is sacred', async () => {
  await freshAccount();
  const cipher = await makeCipher();
  // the sender's browser could not capture a frame: the descriptor says so
  const noPoster = { ...rowFor({ kind: 'video', name: 'clip.mp4', mime: 'video/mp4' }, cipher), thumbIv: null, size: M.VIDEO_AUTO_MAX_BYTES + 1 };
  await store.saveMedia(noPoster);
  const cli = pipelineClient(cipher);
  const res = await M.applyArrivalPolicy(cli, noPoster);
  assert.deepEqual(cli.calls, [], 'not even a request when there is nothing to preview');
  assert.equal(res.state, 'pending');

  // and a poster fetch that 404s must not be read as "the blob is gone"
  const withPoster = { ...noPoster, thumbIv: 'dGh1' };
  await store.saveMedia(withPoster);
  const cli2 = pipelineClient(cipher);
  cli2.downloadThumb = async () => { throw Object.assign(new Error('no preview'), { code: 'no_thumb', status: 404 }); };
  const res2 = await M.applyArrivalPolicy(cli2, withPoster);
  assert.equal(res2.state, 'pending', 'a missing PREVIEW says nothing about the payload');
  assert.ok(!cli2.calls.some((x) => x.what === 'ack'), 'and it never, ever acks');
});

test('pipeline: a FILE waits for the user entirely', async () => {
  await freshAccount();
  const cipher = await makeCipher();
  const row = rowFor({ kind: 'file', name: 'x.pdf', mime: 'application/pdf' }, cipher);
  await store.saveMedia(row);
  const cli = pipelineClient(cipher);
  await M.applyArrivalPolicy(cli, row);
  assert.deepEqual(cli.calls, [], 'req 6: nothing leaves the device until asked');
  assert.equal((await store.getMedia('blob-1')).state, 'pending');
});

// ---------------- interruption, resume, integrity ----------------

test('pipeline: an interrupted fetch keeps its bytes and RESUMES from the offset', async () => {
  await freshAccount();
  const cipher = await makeCipher();
  const row = rowFor({ kind: 'file', name: 'big.bin', mime: 'application/octet-stream' }, cipher);
  await store.saveMedia(row);

  // attempt 1: dies after 200 of 600 bytes
  const first = pipelineClient({ ...cipher, failAfter: 200 });
  const r1 = await M.downloadMedia(first, await store.getMedia('blob-1'));
  assert.equal(r1.state, 'failed');
  const stopped = await store.getMedia('blob-1');
  // the stub reports exactly how much it got through before dropping, so the
  // assertion follows the stream instead of a magic number
  assert.equal(stopped.partialBytes, first.delivered, 'the bytes already paid for are kept');
  assert.ok(first.delivered > 0 && first.delivered < cipher.ct.length, 'and it is genuinely a partial fetch');
  assert.ok(stopped.partial instanceof Blob, 'as a Blob, so it survives a reload');
  assert.ok(!first.calls.some((x) => x.what === 'ack'), 'a failed fetch never acks');

  // attempt 2: continues from 200 — no second download of the first third
  const second = pipelineClient(cipher);
  const r2 = await M.downloadMedia(second, stopped);
  assert.equal(r2.state, 'stored');
  assert.equal(second.calls[0].start, stopped.partialBytes, 'the retry asks for the remainder only');
  const done = await store.getMedia('blob-1');
  assert.deepEqual(new Uint8Array(await done.data.arrayBuffer()), PAYLOAD, 'stitched back together, correctly');
  assert.equal(done.partial, null, 'the scrap is gone once the real copy exists');
  assert.equal(done.partialBytes, 0);
});

test('pipeline: bytes that do not match the digest are never stored or acked', async () => {
  await freshAccount();
  const cipher = await makeCipher();
  const row = rowFor({}, cipher);
  await store.saveMedia(row);
  const cli = pipelineClient({ ...cipher, ct: new Uint8Array(cipher.ct.length).fill(9) });  // lying server
  const res = await M.downloadMedia(cli, row);
  assert.equal(res.state, 'failed', 'a tampered download is a retry, not a loss');
  assert.equal((await store.getMedia('blob-1')).data, null, 'nothing readable is stored');
  assert.ok(!cli.calls.some((x) => x.what === 'ack'),
    'and nothing is acked — the server keeps the real bytes for the next try');
});

test('pipeline: a 404 is final, and is still settled (an un-acked blob pins req 8)', async () => {
  await freshAccount();
  const cipher = await makeCipher();
  const row = rowFor({}, cipher);
  await store.saveMedia(row);
  const cli = pipelineClient(cipher);
  cli.fetchMediaBytes = async () => { cli.calls.push({ what: 'download' }); throw notFound(); };
  const res = await M.downloadMedia(cli, row);
  assert.equal(res.state, 'expired');
  assert.deepEqual(cli.calls.map((x) => x.what), ['download', 'ack'], 'the pending entry is cleared');
  assert.equal((await store.getMedia('blob-1')).partial, null, 'no partial kept for a blob that is gone');
});

test('pipeline: the retry queue picks up failed fetches on the next open, not expired ones', async () => {
  await freshAccount();
  const cipher = await makeCipher();
  await store.saveMedia(rowFor({ id: 'b-1' }, cipher));
  // the persisted scrap must be the real first bytes — a resume that stitched
  // together the WRONG bytes must (and does) fail the digest below
  await store.updateMedia('b-1', { state: 'failed', partialBytes: 100, partial: new Blob([cipher.ct.slice(0, 100)]) });
  await store.saveMedia(rowFor({ id: 'b-2' }, cipher));
  await store.updateMedia('b-2', { state: 'expired' });

  const cli = pipelineClient(cipher);
  assert.equal(await M.retryFailedDownloads(cli), 1, 'only the failed record is retried');
  assert.equal(cli.calls[0].start, 100, 'and it continues where that record stopped');
  assert.equal((await store.getMedia('b-1')).state, 'stored');
  assert.equal((await store.getMedia('b-2')).state, 'expired', 'expired is never re-hammered');
});

test('pipeline: an outgoing row with no blob id yet never touches the wire', async () => {
  await freshAccount();
  const cli = pipelineClient(await makeCipher());
  const row = M.mediaRow({ key: 'out:abc', blobId: null, peer: 'bobby', dir: 'out', kind: 'image', media: { name: 'x' }, msgId: 'out:abc', ts: 1 });
  await store.saveMedia(row);
  assert.equal((await M.downloadMedia(cli, row)).ok, false);
  assert.deepEqual(cli.calls, [], 'the local key is not a server address (blobOf guards it)');
});

// ---------------- decline + retention ----------------

test('pipeline: decline stores nothing, acks false, and keeps the row honest', async () => {
  await freshAccount();
  const cipher = await makeCipher();
  const row = rowFor({ kind: 'file', name: 'big.zip' }, cipher);
  await store.saveMedia(row);
  const cli = pipelineClient(cipher);
  assert.equal((await M.declineMedia(cli, row)).ok, true);
  assert.deepEqual(cli.calls, [{ what: 'ack', id: 'blob-1', downloaded: false }]);
  const after = await store.getMedia('blob-1');
  assert.equal(after.state, 'declined');
  assert.equal(after.data, null, 'req 6: delete-before-download leaves no bytes behind');
});

test('pipeline: retention drops bytes on AGE or on SAVING, and keeps the record', async () => {
  await freshAccount();
  const day = 86_400_000;
  M.setLocalRetentionDays(7);
  const old = Date.now() - 40 * day;
  const mk = (id, kind, over) => store.saveMedia({
    id, kind, peer: 'bobby', dir: 'in', name: 'a.jpg', mime: 'image/jpeg', size: 9,
    ts: old, storedAt: old, state: 'stored', data: new Blob(['bytes']), thumb: new Blob(['t']),
    blobId: id, key: 'k', sha256: 's', keep: false, blurred: null, ...over,
  });
  await mk('img-old', 'image');
  await mk('img-stalepin', 'image', { keep: true });      // retired pin: still due
  await mk('file-old', 'file');
  await mk('img-saved', 'image', { ts: Date.now() - day, storedAt: Date.now() - day, savedAt: Date.now() - 60_000 });
  await mk('img-new', 'image', { ts: Date.now(), storedAt: Date.now() });

  assert.equal(await M.pruneLocalMedia(), 4, 'out of window (pin or no pin) or already handed to the phone');
  const img = await store.getMedia('img-old');
  assert.equal(img.state, 'pruned');
  assert.equal(img.data, null, 'the payload goes');
  assert.ok(img.thumb, 'the thumbnail stays: the wall keeps a picture');
  assert.equal(img.name, 'a.jpg', 'and the record is not destroyed');
  assert.equal(img.prunedWhy, 'age');
  assert.equal((await store.getMedia('file-old')).thumb, null, 'a file has no preview worth keeping');
  assert.equal((await store.getMedia('img-stalepin')).state, 'pruned', 'a stale keep:true cannot make a record immortal');
  const saved = await store.getMedia('img-saved');
  assert.equal(saved.prunedWhy, 'saved', 'and WHY is recorded, so the UI says the true thing');
  assert.ok(saved.savedAt > 0);
  assert.ok((await store.getMedia('img-new')).data, 'inside the window: untouched');
  assert.equal(M.localRetentionDays(), 7);
});

test('pipeline: a completed download is stamped, so the next sweep spares it', async () => {
  await freshAccount();
  M.setLocalRetentionDays(7);
  const day = 86_400_000;
  const cipher = await makeCipher();
  // a message from a month ago, downloaded today
  const row = { ...rowFor({ kind: 'file', name: 'late.bin' }, cipher), ts: Date.now() - 30 * day };
  await store.saveMedia(row);
  await M.downloadMedia(pipelineClient(cipher), row);

  const after = await store.getMedia(row.id);
  assert.equal(after.state, 'stored');
  assert.ok(after.storedAt >= Date.now() - 5000, 'clock starts at arrival, not at the message');
  assert.equal(await M.pruneLocalMedia(), 0,
    'a file the user just chose to download is not dropped minutes later');
  await store.updateMedia(row.id, { storedAt: Date.now() - 9 * day });
  assert.equal(await M.pruneLocalMedia(), 1, 'and it does go once it has genuinely been here a week');
});

// ---------------- against the real backend ----------------

test('pipeline against the real server: a poster-less video survives, then downloads', async (t) => {
  const srv = await startServer();
  const aliceName = randUser('alice');
  const bobName = randUser('bob');
  const cli = [];
  t.after(async () => {
    for (const c0 of cli) { try { c0.disconnect(); } catch { /* gone */ } }
    await srv.deleteUser(aliceName);
    await srv.deleteUser(bobName);
    await srv.stop();
  });
  shim.reset();
  store.setScope(`live${++seq}`);

  const alice = srv.client(); cli.push(alice);
  const bob = srv.client(); cli.push(bob);
  await alice.register(aliceName);
  await bob.register(bobName);
  alice.connect(); bob.connect();
  await Promise.all([waitOpen(alice), waitOpen(bob)]);

  // NO thumb passed: the iPhone case where the sender cannot make a poster
  const sent = await alice.sendMedia(bobName, {
    kind: 'video', bytes: PAYLOAD, name: 'clip.mp4', mime: 'video/mp4', dur: 3.5,
  });
  assert.equal(sent.media.thumbIv, undefined, 'the descriptor honestly says there is no poster');
  const msg = await waitFor(bob, 'message', (m) => m.text.startsWith('{"media":'), 20000);
  const media = JSON.parse(msg.text).media;

  const row = { ...M.mediaRow({ key: media.id, peer: bobName, dir: 'in', kind: 'video', media, msgId: 'in:1', ts: msg.ts }), size: M.VIDEO_AUTO_MAX_BYTES + 1 };
  await store.saveMedia(row);
  const res = await M.applyArrivalPolicy(bob, row);
  assert.equal(res.state, 'pending', 'the poster half did nothing');
  assert.ok(await srv.mongo.db.collection('media').findOne({ _id: media.id }),
    'THE VIDEO IS STILL ON THE SERVER — a preview failure must not delete payload');

  // the user taps Download: progress arrives, the payload lands, then it acks
  const seen = [];
  const full = await M.downloadMedia(bob, { ...row, state: 'pending' }, { onProgress: (g, total) => seen.push([g, total]) });
  assert.equal(full.state, 'stored');
  const stored = await store.getMedia(media.id);
  assert.deepEqual(new Uint8Array(await stored.data.arrayBuffer()), PAYLOAD);
  assert.equal(stored.state, 'stored');
  assert.ok(stored.storedAt > 0);

  // and a real browser-side poster can be cut from these bytes (no <img>, no
  // <video> over a JPEG — the display bugs this feature shipped with)
  assert.equal(await M.buildPoster(stored), null, 'no video decoder in Node: the row is left exactly as it was');
  assert.equal((await store.getMedia(media.id)).data.size, PAYLOAD.length);

  assert.equal(await srv.mongo.db.collection('media').findOne({ _id: media.id }), null,
    'the last device to ack released it (req 8)');
});

test('pipeline against the real server: an IMAGE arrives, downloads, verifies and acks', async (t) => {
  // Why this test exists: the auto-download of an IMAGE is the one path that
  // runs WITHOUT a watching progress callback, and a `onProgress = noop`
  // default-parameter never fires for `null` — so every incoming image failed
  // with 'onProgress is not a function'. Only the real SDK, calling the real
  // contract, could show that. (The video case passed because the user taps it
  // and the tap passes a callback.)
  const srv = await startServer();
  const aliceName = randUser('alice');
  const bobName = randUser('bob');
  const cli = [];
  t.after(async () => {
    for (const c0 of cli) { try { c0.disconnect(); } catch { /* gone */ } }
    await srv.deleteUser(aliceName);
    await srv.deleteUser(bobName);
    await srv.stop();
  });
  shim.reset();
  store.setScope(`img${++seq}`);

  const alice = srv.client(); cli.push(alice);
  const bob = srv.client(); cli.push(bob);
  await alice.register(aliceName);
  await bob.register(bobName);
  alice.connect(); bob.connect();
  await Promise.all([waitOpen(alice), waitOpen(bob)]);

  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...randomBytes(40_000), 0xff, 0xd9]);
  const thumb = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...randomBytes(1200), 0xff, 0xd9]);
  await alice.sendMedia(bobName, { kind: 'image', bytes: jpg, thumb, name: 'photo.jpg', mime: 'image/jpeg', w: 900, h: 700 });
  const media = await waitFor(bob, 'message', (m) => m.text.startsWith('{"media":'), 20000).then((m) => JSON.parse(m.text).media);

  const row = M.mediaRow({ key: media.id, peer: bobName, dir: 'in', kind: 'image', media, msgId: 'in:img', ts: Date.now() });
  await store.saveMedia(row);
  const res = await M.applyArrivalPolicy(bob, row);        // NO onProgress: the arrival case
  assert.equal(res.state, 'stored', `${res.state}: ${res.error?.message ?? ''}`);

  const after = await store.getMedia(media.id);
  assert.equal(after.state, 'stored');
  assert.deepEqual(new Uint8Array(await after.data.arrayBuffer()), jpg, 'the photo arrived intact');
  assert.ok(after.thumb && after.thumb.size > 0, 'with its preview');
  assert.equal(after.data.type, 'image/jpeg', 'typed, so the bubble can paint it');
  assert.equal(await srv.mongo.db.collection('media').countDocuments({ _id: media.id }), 0,
    'and the ack released the server copy (req 8)');
});

test('pipeline: a SMALL video is fetched on arrival so a preview can exist', async () => {
  // the other half of the preview fix: a sender whose browser could not capture
  // a frame used to leave the recipient at a grey icon until they tapped
  // Download — on a phone clip of a few hundred KB. Under the threshold the
  // payload comes over, the poster is built from it, and it is THIS fetch that
  // acks (req 8 is still satisfied by a payload download, never a preview).
  await freshAccount();
  const cipher = await makeCipher();
  const row = { ...rowFor({ kind: 'video', name: 'clip.mp4', mime: 'video/mp4' }, cipher), thumbIv: null };
  await store.saveMedia(row);
  const cli = pipelineClient(cipher);
  const res = await M.applyArrivalPolicy(cli, row);
  assert.equal(res.state, 'stored');
  const after = await store.getMedia('blob-1');
  assert.deepEqual(new Uint8Array(await after.data.arrayBuffer()), PAYLOAD, 'the clip is on the device');
  assert.ok(cli.calls.some((x) => x.what === 'ack'), 'the payload fetch, and only it, settled the ack');
});
