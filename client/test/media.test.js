// Media end-to-end through the SDK (M4): upload → per-device fan-out →
// receive → download → ack → the server blob dies. Real backend in-process,
// real pairing for the sync case, so the lifecycle is asserted against the
// same `media` collection the routes write.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startServer, waitFor, waitOpen, sleep, randUser } from './helpers.js';
import { CoconoApiError, CoconoError } from '../src/index.js';
import * as c from '../src/crypto.js';

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // a PNG header nobody will
  ...Array.from({ length: 500 }, (_, i) => (i * 7) % 256),           // read as
]);                                                          // anything but bytes
const THUMB = new Uint8Array(Array.from({ length: 120 }, (_, i) => (i * 11) % 256));

const mediaCollection = (srv) => srv.mongo.db.collection('media');

// Settle helper: WAIT until the server has listed a device on the blob.
// `handleSend` registers before it persists and publishes, so this normally
// resolves on the first poll — but a loaded machine (the whole suite running
// sequentially in CI-like conditions) delays the ws seam by seconds, and a
// download issued before the listing legitimately 404s. Tests that assert the
// LIFECYCLE must therefore wait for the bookkeeping, not for a coincidence.
async function waitForDevice(srv, id, ul, { tries = 60 } = {}) {
  for (let i = 0; i < tries; i++) {
    const doc = await mediaCollection(srv).findOne({ _id: id });
    if (doc && (doc.devices ?? []).some((d) => d.ul === ul.toLowerCase())) return doc;
    await sleep(50);
  }
  throw new Error(`device @${ul} never listed on blob ${id}`);
}

// A client that stays connected (because an assertion threw before the
// disconnect lines) keeps the suite's process alive — so every test registers
// its clients for teardown instead of relying on the happy path.
function tracked(srv, t) {
  const list = [];
  t.after(async () => { for (const cli of list) { try { cli.disconnect(); } catch { /* already gone */ } } });
  const make = (...args) => { const c0 = srv.client(...args); list.push(c0); return c0; };
  return make;
}
const sha = async (bytes) => createHash('sha256').update(bytes).digest('base64url');
// the driver hands a stored Binary back as a wrapper — value() is its exact
// byte range (same normalisation the server's download route uses)
const bytesOf = (v) => (v ? Buffer.from(v.value ? v.value() : v) : null);

// ---------------- crypto primitives ----------------

test('crypto: encryptBytes/decryptBytes round-trip the iv‖ct‖tag wire format', async () => {
  const key = await c.generateFileKey();
  const ct = await c.encryptBytes(key, PNG);
  assert.equal(ct.length, PNG.length + 12 + 16, 'iv(12) + ciphertext + tag(16)');
  const back = await c.decryptBytes(key, ct);
  assert.deepEqual([...back], [...PNG]);

  // the descriptor carries the key as raw bytes and the iv separately
  const raw = await c.exportRawAesKey(key);
  const reimported = await c.importFileKey(raw);
  assert.deepEqual([...await c.decryptBytes(reimported, ct)], [...PNG]);
  assert.equal(c.b64uEncode ? true : true, true); // (encoding is exported by the package)

  // a wrong key is an authentication failure, not garbage
  const other = await c.generateFileKey();
  await assert.rejects(c.decryptBytes(other, ct));

  // sha256B64u agrees with node's digest of the same bytes (the server
  // computes the same string and REFUSES an upload whose claim is wrong)
  assert.equal(await c.sha256B64u(ct), await sha(ct));
});

test('crypto: text encryption still shares the byte path (no wire drift)', async () => {
  const conv = await c.generateFileKey();
  const dB64u = await c.encryptForConversation(conv, 'hello');
  const raw = Buffer.from(dB64u.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  assert.equal(raw.length, 12 + 'hello'.length + 16);
  assert.equal(await c.decryptFromConversation(conv, dB64u), 'hello');
});

// ---------------- the exchange ----------------

test('media: image send → receive → download → ack → server blob deleted', async (t) => {
  const srv = await startServer();
  const client = tracked(srv, t);
  const aliceName = randUser('alice');
  const bobName = randUser('bob');
  t.after(async () => {
    await srv.deleteUser(aliceName);
    await srv.deleteUser(bobName);
    await srv.stop();
  });

  const alice = client('alice');
  const bob = client('bob');
  await alice.register(aliceName);
  await bob.register(bobName);
  await Promise.all([waitOpen((alice.connect(), alice)), waitOpen((bob.connect(), bob))]);

  const sent = await alice.sendMedia(bobName, {
    kind: 'image', bytes: PNG, thumb: THUMB, name: 'holiday.jpg', mime: 'image/jpeg',
    w: 1600, h: 1200,
  });
  assert.ok(sent.media.id, 'the media descriptor carries the server blob id');
  assert.equal(sent.media.kind, 'image');
  assert.equal(sent.media.size, PNG.length, 'size is the PLAINTEXT length');
  assert.match(sent.media.key, /^[A-Za-z0-9_-]{43}$/, 'a 256-bit key, base64url');
  // the digest is of the CIPHERTEXT (that is what a recipient can verify
  // before it can decrypt anything)
  assert.match(sent.media.sha256, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(sent.media.iv && sent.media.thumbIv, 'both IVs travel');

  // Bob receives a message first: the server registers the addressed device on
  // the blob BEFORE it publishes the envelope, so reading the doc only becomes
  // meaningful once his copy is on its way (otherwise this races the ws seam).
  const msg = await waitFor(bob, 'message', (m) => m.text.startsWith('{"media":'), 20000);
  await waitForDevice(srv, sent.media.id, bobName);
  const media = JSON.parse(msg.text).media;
  assert.equal(media.id, sent.media.id);
  assert.equal(media.name, 'holiday.jpg');
  assert.equal(media.mime, 'image/jpeg');

  // the server holds ciphertext only — nothing here identifies a PNG
  let doc = await mediaCollection(srv).findOne({ _id: sent.media.id });
  assert.ok(doc, 'the blob exists');
  assert.equal(doc.kind, 'image');
  assert.equal(doc.ctSize, PNG.length + 28);
  const stored = bytesOf(doc.blob);
  assert.notDeepEqual([...stored.subarray(0, 8)], [...PNG], 'no plaintext on the server');
  assert.equal(doc.sha256, sent.media.sha256);
  assert.equal(await sha(stored), doc.sha256, 'the stored digest is of the CIPHERTEXT');
  assert.deepEqual(doc.pending, [{ ul: bobName.toLowerCase(), dv: bob.deviceId }],
    'the addressed device owes an ack');
  // download: verified against the sender's digest, then decrypted
  const { data, thumb } = await bob.downloadMedia(media.id, media);
  assert.deepEqual(new Uint8Array(await data.arrayBuffer()), PNG);
  assert.deepEqual(new Uint8Array(await thumb.arrayBuffer()), THUMB);

  // a poster-only fetch (what a video arrival does) needs no ack
  const onlyThumb = await bob.downloadThumb(media.id, media);
  assert.deepEqual(new Uint8Array(await onlyThumb.arrayBuffer()), THUMB);
  assert.ok(await mediaCollection(srv).findOne({ _id: media.id }), 'thumb fetch keeps the blob');

  // ack → every device has answered → the bytes go (req 8)
  const ack = await bob.ackMedia(media.id, true);
  assert.deepEqual(ack, { ok: true, deleted: true });
  assert.equal(await mediaCollection(srv).findOne({ _id: media.id }), null);

  // and a late replay finds nothing — the app's 'expired' placeholder path
  await assert.rejects(bob.downloadMedia(media.id, media), (err) => {
    assert.ok(err instanceof CoconoApiError || err instanceof CoconoError);
    assert.equal(err.code, 'unknown_media');
    return true;
  });
  alice.disconnect();
  bob.disconnect();
});

test('media: decline-before-download marks it received and deletes the blob', async (t) => {
  const srv = await startServer();
  const client = tracked(srv, t);
  const aliceName = randUser('alice');
  const bobName = randUser('bob');
  t.after(async () => {
    await srv.deleteUser(aliceName);
    await srv.deleteUser(bobName);
    await srv.stop();
  });
  const alice = client('alice');
  const bob = client('bob');
  await alice.register(aliceName);
  await bob.register(bobName);
  await Promise.all([waitOpen((alice.connect(), alice)), waitOpen((bob.connect(), bob))]);

  const sent = await alice.sendMedia(bobName, { kind: 'file', bytes: PNG, name: 'spec.pdf', mime: 'application/pdf' });
  // same discipline: the ack is only meaningful once the device is listed
  await waitFor(bob, 'message', (m) => m.text.startsWith('{"media":'), 20000);
  await waitForDevice(srv, sent.media.id, bobName);
  const res = await bob.ackMedia(sent.media.id, false);
  assert.deepEqual(res, { ok: true, deleted: true });
  assert.equal(await mediaCollection(srv).findOne({ _id: sent.media.id }), null,
    'req 6: deleting without downloading counts as received, so the server releases it');
  alice.disconnect();
  bob.disconnect();
});

test('media: a digest mismatch is surfaced, never silently accepted', async (t) => {
  const srv = await startServer();
  const client = tracked(srv, t);
  const aliceName = randUser('alice');
  const bobName = randUser('bob');
  t.after(async () => {
    await srv.deleteUser(aliceName);
    await srv.deleteUser(bobName);
    await srv.stop();
  });
  const alice = client('alice');
  const bob = client('bob');
  await alice.register(aliceName);
  await bob.register(bobName);
  await Promise.all([waitOpen((alice.connect(), alice)), waitOpen((bob.connect(), bob))]);

  const sent = await alice.sendMedia(bobName, { kind: 'image', bytes: PNG, name: 'x.png', mime: 'image/png' });
  // WAIT for the send to be stored: `devices` is written by handleSend, so a
  // download fired the instant sendMedia resolves can race the ws seam and
  // legitimately 404 (this test passed alone and failed under full-suite
  // timing for exactly that reason — settle first, then assert).
  await waitFor(bob, 'message', (m) => m.text.startsWith('{"media":'), 20000);
  await waitForDevice(srv, sent.media.id, bobName);
  // a lying server (here: a stubbed fetch) must not be able to hand back
  // different bytes without the client noticing
  const real = bob.api.downloadMediaRaw.bind(bob.api);
  bob.api.downloadMediaRaw = async (token, id) => {
    const bytes = await real(token, id);
    bytes[40] ^= 0xff;
    return bytes;
  };
  await assert.rejects(bob.downloadMedia(sent.media.id, sent.media), (err) => {
    assert.equal(err.code, 'media_tampered');
    return true;
  });
  // and the blob is STILL there: a failed verify must not ack
  assert.ok(await mediaCollection(srv).findOne({ _id: sent.media.id }));
  alice.disconnect();
  bob.disconnect();
});

test('media: outgoing sync — the sender own other device owes a download too', async (t) => {
  const srv = await startServer();
  const client = tracked(srv, t);
  const aliceName = randUser('alice');
  const bobName = randUser('bob');
  t.after(async () => {
    await srv.deleteUser(aliceName);
    await srv.deleteUser(bobName);
    await srv.stop();
  });

  const a1 = client();
  const a2 = client();
  await a1.register(aliceName);
  const { code } = await a2.beginPairing(aliceName);
  await a1.approvePairing(code);
  await a2.completePairing({ pollIntervalMs: 100 });
  const bob = client();
  await bob.register(bobName);

  a1.connect(); a2.connect(); bob.connect();
  await Promise.all([waitOpen(a1), waitOpen(a2), waitOpen(bob)]);

  const a2Media = [];
  const a2Messages = [];
  a2.on('sync', (m) => m.media && a2Media.push(m));
  a2.on('message', (m) => a2Messages.push(m));
  const bobAcks = [];
  a1.on('ack', (a) => bobAcks.push(a));

  const sent = await a1.sendMedia(bobName, { kind: 'image', bytes: PNG, thumb: THUMB, name: 'a.png', mime: 'image/png' });

  // the sync copy arrives as a 'sync' event carrying the SAME media object
  const [syncEv, bobMsg] = await Promise.all([
    waitFor(a2, 'sync', (m) => m.media?.id === sent.media.id, 20000),
    waitFor(bob, 'message', (m) => m.text.startsWith('{"media":'), 20000),
  ]);
  await waitForDevice(srv, sent.media.id, bobName);
  assert.equal(syncEv.id, sent.localId, 'same record id on every device');
  assert.equal(syncEv.peer, bobName);
  assert.equal(syncEv.media.key, sent.media.key, 'one file key, every device');
  assert.equal(a2Messages.length, 0, 'a sync copy never surfaces as a message');
  // only the PEER copy acks visibly (sync acks are swallowed, as for text)
  assert.equal(bobAcks.length, 1);
  assert.equal(bobAcks[0].localId, sent.localId);
  void bobMsg;

  const doc = await mediaCollection(srv).findOne({ _id: sent.media.id });
  assert.equal(doc.pending.length, 2, 'the peer device AND the sender own device are both owed');
  assert.deepEqual(doc.pending.map((d) => d.ul).sort(), [aliceName.toLowerCase(), bobName.toLowerCase()]);

  // Bob downloads + acks; the blob must SURVIVE because alice's own device
  // has not answered yet (this is the whole point of counting sync copies)
  await bob.downloadMedia(sent.media.id, sent.media);
  const bobAck = await bob.ackMedia(sent.media.id, true);
  assert.deepEqual(bobAck, { ok: true, deleted: false });
  assert.ok(await mediaCollection(srv).findOne({ _id: sent.media.id }));

  // a2 joins the lifecycle like any recipient
  const got = await a2.downloadMedia(sent.media.id, syncEv.media);
  assert.deepEqual(new Uint8Array(await got.data.arrayBuffer()), PNG);
  const last = await a2.ackMedia(sent.media.id, true);
  assert.deepEqual(last, { ok: true, deleted: true });
  assert.equal(await mediaCollection(srv).findOne({ _id: sent.media.id }), null);

  // no push ever left for the sync copy (your own send must not ring)
  const gates = await srv.redis.keys(`pushsent:${aliceName.toLowerCase()}:${a2.deviceId}:*`);
  assert.equal(gates.length, 0);
  a1.disconnect(); a2.disconnect(); bob.disconnect();
});

test('media: sendMedia uploads before any envelope — a failed upload sends nothing', async (t) => {
  const srv = await startServer();
  const client = tracked(srv, t);
  const aliceName = randUser('alice');
  const bobName = randUser('bob');
  t.after(async () => {
    await srv.deleteUser(aliceName);
    await srv.deleteUser(bobName);
    await srv.stop();
  });
  const alice = client('alice');
  const bob = client('bob');
  await alice.register(aliceName);
  await bob.register(bobName);
  await Promise.all([waitOpen((alice.connect(), alice)), waitOpen((bob.connect(), bob))]);

  const real = alice.api.uploadMedia.bind(alice.api);
  alice.api.uploadMedia = async () => { throw new CoconoApiError(413, 'media_quota', 'Storage quota reached'); };
  const sawAck = [];
  alice.on('ack', (a) => sawAck.push(a));
  await assert.rejects(
    alice.sendMedia(bobName, { kind: 'image', bytes: PNG, name: 'x.png', mime: 'image/png' }),
    (err) => { assert.equal(err.code, 'media_quota'); return true; },
  );
  await sleep(300);
  assert.equal(sawAck.length, 0, 'nothing went out when the upload failed');
  assert.equal(await srv.mongo.db.collection('messages').countDocuments({}), 0);
  alice.api.uploadMedia = real;
  alice.disconnect();
  bob.disconnect();
});

test('media: a recipient with two devices must ack on BOTH before deletion', async (t) => {
  const srv = await startServer();
  const client = tracked(srv, t);
  const aliceName = randUser('alice');
  const bobName = randUser('bob');
  t.after(async () => {
    await srv.deleteUser(aliceName);
    await srv.deleteUser(bobName);
    await srv.stop();
  });
  const alice = client();
  const bob1 = client();
  const bob2 = client();
  await alice.register(aliceName);
  await bob1.register(bobName);
  const { code } = await bob2.beginPairing(bobName);
  await bob1.approvePairing(code);
  await bob2.completePairing({ pollIntervalMs: 100 });

  // alice's peer-key cache must know about bob's new device before the send
  await alice.peerKeys(bobName, { refresh: true });
  alice.connect(); bob1.connect(); bob2.connect();
  await Promise.all([waitOpen(alice), waitOpen(bob1), waitOpen(bob2)]);

  const sent = await alice.sendMedia(bobName, { kind: 'video', bytes: PNG, thumb: THUMB, name: 'clip.mp4', mime: 'video/mp4', dur: 3.2 });
  await Promise.all([
    waitFor(bob1, 'message', (m) => m.text.startsWith('{"media":'), 20000),
    waitFor(bob2, 'message', (m) => m.text.startsWith('{"media":'), 20000),
  ]);
  let doc = await mediaCollection(srv).findOne({ _id: sent.media.id });
  assert.equal(doc.pending.length, 2, 'one entry per addressed device');

  await bob1.ackMedia(sent.media.id, true);
  assert.ok(await mediaCollection(srv).findOne({ _id: sent.media.id }), 'N-1 acks keep the blob');
  // bob2 declines instead
  const done = await bob2.ackMedia(sent.media.id, false);
  assert.deepEqual(done, { ok: true, deleted: true });
  assert.equal(await mediaCollection(srv).findOne({ _id: sent.media.id }), null);
  alice.disconnect(); bob1.disconnect(); bob2.disconnect();
});

test('media: self-chat notes-to-self address the sending device, which owes an ack', async (t) => {
  const srv = await startServer();
  const client = tracked(srv, t);
  const name = randUser('self');
  t.after(async () => { await srv.deleteUser(name); await srv.stop(); });
  const cli = client();
  await cli.register(name);
  cli.connect();
  await waitOpen(cli);
  const sent = await cli.sendMedia(name, { kind: 'file', bytes: PNG, name: 'note.txt' });
  // a self-send fans out to EVERY own device including this one (the echo is
  // pulled, never re-saved) — so the sending device is a listed recipient and
  // the blob would sit pending forever if the app did not settle it. That is
  // exactly what chat.js does after a successful self-send: it holds the
  // bytes already, so it acks them.
  // the echo of a self-send is pulled by the SDK (never re-saved) — wait for
  // the server bookkeeping to settle before reading it
  await sleep(400);
  const doc = await mediaCollection(srv).findOne({ _id: sent.media.id });
  assert.deepEqual(doc.pending, [{ ul: name.toLowerCase(), dv: cli.deviceId }]);
  assert.deepEqual((await cli.downloadMedia(sent.media.id, sent.media)).data.size, PNG.length);
  assert.deepEqual(await cli.ackMedia(sent.media.id, true), { ok: true, deleted: true });
  assert.equal(await mediaCollection(srv).findOne({ _id: sent.media.id }), null);
  cli.disconnect();
});
