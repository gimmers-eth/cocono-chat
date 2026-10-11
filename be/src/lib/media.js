import { createDecipheriv } from 'node:crypto';
import { b64uDecode } from './b64u.js';

// Media blob lifecycle (milestone 4) — THE single place that decides who may
// hold a blob and when it dies.
//
// What the server stores about a photo/video/file is CIPHERTEXT only: the
// per-file AES-GCM key travels inside each recipient's E2EE envelope, so the
// bytes here are unreadable by design (and readable for moderation ONLY
// because a reporter hands their own client's key to the server — see
// routes/app-routes/reports.js). Because the server cannot see content, its
// abuse surface is SIZE, and size is bounded three ways in the same breath
// as the upload route: per-blob caps, a per-account quota, and retention
// sweeps (un-acked blobs + never-sent orphan uploads).
//
// Doc shape (collection `media`):
//   {
//     _id: '<blob id>',
//     owner: { ul, fd },          uploading device (the sender)
//     kind: 'image'|'video'|'file',
//     ctSize, thumbCtSize,        byte lengths of the stored ciphertexts
//     sha256,                     digest of the ciphertext (VERIFIED on
//                                 upload — a stored digest never lies)
//     blob, thumb,                Binary: iv(12) ‖ ct ‖ tag(16)
//     devices: [{ul, dv}],        authorised recipients (handleSend adds)
//     pending: [{ul, dv}],        authorised devices that have NOT acked yet
//     reported: false,            pinned by a report — never swept (§7)
//     ts: Date                    upload time (retention sorts on this)
//   }
//
// The deletion rule (req 8): a blob dies when `pending` is empty and it is
// not `reported`. `pending` counts EVERY device that received an envelope
// referencing the blob — peer devices, own-other-device SYNC copies and
// self-chat copies all land there, so "downloaded (or declined) on all
// devices" means exactly what it says.

export const MEDIA_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;
export const MEDIA_KINDS = ['image', 'video', 'file'];

const devKey = (ul, dv) => ({ ul, dv });
const sameDev = (a, b) => a?.ul === b?.ul && a?.dv === b?.dv;

/** Delete a blob doc AND its stored bytes (inline fields or GridFS chunks). */
export async function deleteBlob({ media, store }, doc) {
  if (!doc?._id) return;
  if (store) await store.removeParts(doc).catch(() => {});
  await media.deleteOne({ _id: doc._id });
}

/** Structural gate for the plaintext attachment descriptor in `m.att`. */
export function attProblem(att, config) {
  if (att === undefined) return null; // optional field
  if (typeof att !== 'object' || att === null || Array.isArray(att)) return 'invalid_envelope';
  const { id, kind, size } = att;
  if (typeof id !== 'string' || !MEDIA_ID_RE.test(id)) return 'invalid_envelope';
  if (!MEDIA_KINDS.includes(kind)) return 'invalid_envelope';
  if (!Number.isInteger(size) || size < 1 || size > config.mediaMaxBytes) return 'invalid_envelope';
  return null;
}

/**
 * Register a recipient device on a blob (handleSend fan-out). Idempotent
 * under cid retries and multi-copy fan-out: `$addToSet` on a subobject can
 * never duplicate {ul,dv}.
 */
export async function registerDevice(media, { id, ul, dv }) {
  const dev = devKey(ul, dv);
  await media.updateOne(
    { _id: id },
    { $addToSet: { devices: dev, pending: dev } },
  );
}

/**
 * One device says "I am done with this blob" (downloaded OR declined — req 6
 * makes declining a legitimate end state). Removes the caller from `pending`
 * and deletes the blob when nothing is owed any more.
 *
 * @returns {{ok: boolean, deleted: boolean}|{error: string}}
 *   `no_such_device` — the caller is not an authorised recipient of this blob
 *   (authorisation is exactly (ul,dv) ∈ devices: never username-only, so a
 *   second device must have received its own envelope copy to count).
 */
/**
 * `deps` is `{ media, store }`: the collection, and (optionally) the byte
 * store. A doc that dies must take its GridFS chunks with it — an acknowledged
 * 100 MB video whose document is gone but whose chunks remain is worse than no
 * deletion at all, because nothing will ever look for them again.
 */
export async function ackDevice(deps, { id, ul, dv }) {
  const { media, store } = deps ?? {};
  const doc = await media.findOne({ _id: id }, { projection: { devices: 1, pending: 1, reported: 1 } });
  if (!doc) return { ok: true, deleted: true }; // already swept: the ack is satisfied
  if (!(doc.devices ?? []).some((d) => sameDev(d, { ul, dv }))) return { error: 'no_such_device' };
  if (!(doc.pending ?? []).some((d) => sameDev(d, { ul, dv }))) {
    return { ok: true, deleted: doc.pending?.length === 0 && doc.reported !== true };
  }
  await media.updateOne({ _id: id }, { $pull: { pending: devKey(ul, dv) } });
  const after = await media.findOne({ _id: id }, { projection: { pending: 1, reported: 1, blob: 1, thumb: 1 } });
  if (after && (after.pending ?? []).length === 0 && after.reported !== true) {
    await deleteBlob({ media, store }, after);
    return { ok: true, deleted: true };
  }
  return { ok: true, deleted: false };
}

/** Is this (account, device) allowed to READ this blob? Sender-owner yes
 *  (until the blob dies — retry flows), anyone else only via `devices`. */
export function mayAccess(doc, { ul, dv, ownerUl, ownerFd }) {
  if (!doc) return false;
  if (doc.owner?.ul === ownerUl && doc.owner?.fd === ownerFd) return true;
  return (doc.devices ?? []).some((d) => sameDev(d, { ul, dv }));
}

/**
 * Periodic safety net (the inline delete-on-last-ack is the fast path):
 *  * un-acked blobs older than MEDIA_RETENTION_DAYS,
 *  * orphan uploads (uploaded, never sent — a client that died mid-flow)
 *    after MEDIA_ORPHAN_MAX_SEC,
 * both excluding report-pinned docs. Returns counts (logged + asserted).
 */
export async function sweepMedia(deps, config, { now = Date.now() } = {}) {
  const { media, store } = deps ?? {};
  const stale = new Date(now - config.mediaRetentionDays * 24 * 3600 * 1000);
  const orphaned = new Date(now - config.mediaOrphanMaxSec * 1000);
  const gone = { $ne: true };
  const expiredDocs = await media.find(
    { ts: { $lte: stale }, reported: gone },
    { projection: { _id: 1, blob: 1, thumb: 1 } }).toArray();
  const orphanDocs = await media.find(
    // an upload the client never finished (or never sent a message for): the
    // doc holds a reservation and, at 100 MB, possibly real chunks
    { $or: [{ ts: { $lte: orphaned }, devices: { $size: 0 } }, { ts: { $lte: orphaned }, upload: 'pending' }] },
    { projection: { _id: 1, blob: 1, thumb: 1 } }).toArray();
  const ids = new Set(expiredDocs.map((d) => String(d._id)));
  for (const d of expiredDocs) await deleteBlob({ media, store }, d);
  const orphans = orphanDocs.filter((d) => !ids.has(String(d._id)));
  for (const d of orphans) await deleteBlob({ media, store }, d);
  // A stored file whose document is gone is invisible to every other path in
  // this module — nothing would ever look for it again, so the space is lost
  // permanently. Reclaim those too (an aborted PUT that wrote a file and then
  // failed before its doc update is enough to create one).
  let files = 0;
  if (store?.dropOrphanFiles) files = await store.dropOrphanFiles().catch(() => 0);
  return { expired: expiredDocs.length, orphans: orphans.length, files };
}

/** Boot the hourly sweeper (single-process assumption, like the message
 *  TTL's Mongo monitor). Returns a stop() for graceful shutdown. */
export function startMediaSweeper({ media, store, config, log, everyMs = 3600_000 }) {
  const run = async () => {
    try {
      const { expired, orphans } = await sweepMedia({ media, store }, config);
      if (expired || orphans) log?.info?.(`[media] swept ${expired} expired, ${orphans} orphan uploads`);
    } catch (err) {
      log?.warn?.(`[media] sweep failed: ${err?.message ?? err}`);
    }
  };
  const timer = setInterval(run, everyMs);
  timer.unref?.();
  run(); // a boot that sat idle past the retention window sweeps immediately
  return { stop: () => clearInterval(timer), run };
}


// ---- moderation decryption (req 9) ------------------------------------------
// The server holds ciphertext and CANNOT read it — until a REPORTER hands over
// the file key. That is the plan's answer to "media must be decryptable by the
// server when a user is reported": the escrow is not ours, it is every
// recipient's own copy, and reporting is the act that shares it. So this runs
// with a key the reporter supplied, and only ever on a blob that reporter was
// entitled to (authorisation lives in the report route, not here).
//
// Wire format matches the client exactly: iv(12) ‖ ciphertext ‖ tag(16).
// Returns the PLAINTEXT Buffer, or null when the key/iv/bytes do not add up —
// a report must never fail because one attachment was mis-recorded.
export function decryptWithKey(blobField, keyB64u, ivB64u = null) {
  try {
    const raw = asBytes(blobField);
    const key = b64uDecode(keyB64u);
    if (!raw || !key || key.length !== 32 || raw.length < 29) return null;
    // the IV is at the front of the blob; a supplied iv is only trusted when
    // it AGREES with it (a reporter's record and the bytes must tell the same
    // story — a mismatch is a broken client, not a licence to guess)
    const iv = raw.subarray(0, 12);
    if (ivB64u) {
      const claimed = b64uDecode(ivB64u);
      if (claimed && claimed.length === 12 && !claimed.equals(iv)) return null;
    }
    const tag = raw.subarray(raw.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]);
  } catch {
    return null;
  }
}

/** Mongo Binary (or Buffer) → Buffer of exactly the stored bytes. */
export function asBytes(v) {
  if (!v) return null;
  if (Buffer.isBuffer(v)) return v;
  if (typeof v?.value === 'function') return Buffer.from(v.value());
  if (v.buffer instanceof Uint8Array) return Buffer.from(v.buffer.subarray(0, v.position ?? v.buffer.length));
  return null;
}
