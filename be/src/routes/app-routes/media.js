// Media blobs (milestone 4) — the BYTES half of "send images, videos & files".
//
// WHY REST AND NOT THE WEBSOCKET: WS frames are capped at 64 KB
// (ws-routes/protocol.js MAX_FRAME_BYTES) and every message copy is small by
// design. Blob bytes therefore move over these endpoints, while the *message*
// that references a blob keeps riding the E2EE store-and-forward path — so
// delivery, ordering, idempotency, receipts and offline replay are unchanged.
//
// WHAT THE SERVER CAN SEE: nothing about the content. `blob`/`thumb` are
// AES-GCM ciphertexts whose key travels inside each recipient's encrypted
// envelope; a doc here stores only routing-shaped facts — kind (enum), byte
// lengths, the digest of the ciphertext, who owns it and who still owes an
// ack. Because content is unreadable, SIZE is the only abuse lever, and it is
// bounded in the same breath as the upload route itself: a per-blob cap, a
// per-account quota, retention/orphan sweeps, and — at 100 MB — streaming with
// the cap enforced DURING the request rather than after buffering it.
//
// WHERE THE BYTES GO: inline in the doc while they are small, GridFS above
// `MEDIA_INLINE_MAX_BYTES` (a Mongo document tops out at 16 MB). Callers never
// branch on it: lib/mediaStore.js reads and writes both, and 'fs:<id>' in the
// field means "not in the doc".

import { createHash, randomUUID } from 'node:crypto';
import { fail, requireAuth, limited } from '../shared.js';
import { rateLimit } from '../../lib/rateLimit.js';
import { effectiveLimit } from '../../lib/limits.js';
import { b64uDecode } from '../../lib/b64u.js';
import { MEDIA_ID_RE, MEDIA_KINDS, ackDevice, asBytes } from '../../lib/media.js';
import { isFileRef, readAll } from '../../lib/mediaStore.js';

// base64url with a hard ceiling on what we are willing to allocate for it —
// a hostile body must not make us buffer 130 MB of junk before we look at it.
// Returns a Buffer, null (malformed/empty) or 'too_large'.
const decodeCapped = (b64, maxBytes) => {
  if (typeof b64 !== 'string' || !b64.length) return null;
  if (Math.ceil((b64.length * 3) / 4) > maxBytes) return 'too_large';
  const buf = b64uDecode(b64);
  if (!buf || !buf.length) return null;
  if (buf.length > maxBytes) return 'too_large';
  return buf;
};

/** Delete a blob and its bytes wherever they live. */
async function dropBlob(ctx, id) {
  const doc = await ctx.media.findOne({ _id: id }, { projection: { blob: 1, thumb: 1 } });
  if (!doc) return false;
  await ctx.mediaStore?.removeParts(doc).catch(() => {});
  await ctx.media.deleteOne({ _id: id });
  return true;
}

/**
 * Is there an INLINE copy of these bytes on the doc? Mongo hands a stored
 * Buffer back as a Binary wrapper (lib/media.js's asBytes unwraps it), and a
 * 'fs:<id>' string is a GridFS reference with no bytes in the document at all
 * — reading that as an empty body is how a download silently returns nothing.
 */
const inlineBytes = (v) => (isFileRef(v) ? null : asBytes(v));

export default async function mediaRoutes(app, { redis, config, settings, media, mediaStore }) {
  const ctx = { media, mediaStore };

  // Fastify has no parser for octet-stream bodies (415 by default), and a
  // 100 MB upload must NOT be parsed into memory anyway. This hands the raw
  // request stream to the route and buffers nothing: `putStream` then counts,
  // hashes and caps it while it flows to storage, which is the only place a
  // size limit means anything at this scale (Fastify's own bodyLimit is not
  // enforced for a parser that never consumes the payload — putStream's
  // maxBytes is the real gate, and it aborts mid-stream).
  app.addContentTypeParser('application/octet-stream', function (request, payload, done) {
    request.streamBody = payload;
    done();
  });

  // ---- POST /api/media ----
  // Two shapes, one endpoint:
  //   { kind, blob, sha256, thumb? }        base64 — small items, one request
  //   { kind, size, sha256, thumbSize? }    metadata only — the bytes then
  //                                         arrive as raw streams over PUT
  // The second exists because base64 of a 100 MB file is a 133 MB JSON body:
  // nobody should buffer that twice (or pay for it on a phone). Over
  // MEDIA_JSON_MAX_BYTES the JSON shape is refused with `use_stream_upload`,
  // which is the client's cue to switch paths — and the SDK does.
  app.post('/api/media', {
    bodyLimit: Math.ceil(config.mediaJsonMaxBytes * 1.4) + Math.ceil(config.mediaThumbMaxBytes * 1.4) + 64 * 1024,
  }, async (request, reply) => {
    const denied = requireAuth(request, reply);
    if (denied) return denied;
    const ul = request.auth.sub;
    const fd = request.auth.d;

    const limIp = await effectiveLimit(settings, config, 'mediaup');
    const rlIp = await rateLimit(redis, `rl:mediaup:${request.ip}`, limIp.limit, limIp.windowSec);
    if (!rlIp.ok) return limited(reply, rlIp);
    const limAcct = await effectiveLimit(settings, config, 'mediaupacct', ul);
    const rlAcct = await rateLimit(redis, `rl:mediaupacct:${ul}`, limAcct.limit, limAcct.windowSec);
    if (!rlAcct.ok) return limited(reply, rlAcct);

    const body = request.body ?? {};
    const kind = String(body.kind ?? '');
    if (!MEDIA_KINDS.includes(kind)) return fail(reply, 'invalid_request', 'Unknown media kind', 400);

    // the digest is of the CIPHERTEXT, and it is verified here: a stored digest
    // that lies would poison every recipient's own check (they verify the bytes
    // against the value inside the encrypted payload) and the ETag below
    const claimed = typeof body.sha256 === 'string' ? body.sha256 : null;
    if (!claimed || !/^[A-Za-z0-9_-]{43}$/.test(claimed)) {
      return fail(reply, 'invalid_request', 'sha256 (of the ciphertext) is required', 400);
    }

    let id = null;
    let doc;
    let blobBuf = null;
    let thumbBuf = null;

    if (typeof body.blob === 'string' && body.blob.length) {
      // ------- single-shot JSON upload (small items) -------
      if (Math.ceil((body.blob.length * 3) / 4) > config.mediaJsonMaxBytes) {
        // the cap that matters at 100 MB: tell the client to stream it rather
        // than truncating a request it will retry forever
        return fail(reply, 'use_stream_upload', 'Too large for a JSON upload — create the blob, then PUT the bytes', 413);
      }
      blobBuf = decodeCapped(body.blob, config.mediaMaxBytes);
      if (blobBuf === 'too_large') {
        return fail(reply, 'media_too_large', `Attachment exceeds ${Math.floor(config.mediaMaxBytes / (1024 * 1024))} MB`, 413);
      }
      if (!blobBuf) return fail(reply, 'invalid_request', 'blob must be base64url ciphertext', 400);
      if (body.thumb !== undefined && body.thumb !== null && body.thumb !== '') {
        thumbBuf = decodeCapped(body.thumb, config.mediaThumbMaxBytes);
        if (thumbBuf === 'too_large') return fail(reply, 'thumb_too_large', 'Thumbnail exceeds its cap', 413);
        if (!thumbBuf) return fail(reply, 'invalid_request', 'thumb must be base64url ciphertext', 400);
      }
      const digest = createHash('sha256').update(blobBuf).digest('base64url');
      if (digest !== claimed) return fail(reply, 'bad_sha256', 'sha256 does not match the uploaded bytes', 400);
    } else {
      // ------- deferred: metadata only, bytes arrive over PUT -------
      // The CLAIM is what the quota reserves, so an upload that ends up bigger
      // is caught at finalize (below) rather than being free storage.
      const size = Number(body.size);
      if (!Number.isInteger(size) || size < 1 || size > config.mediaMaxBytes) {
        return fail(reply, size > config.mediaMaxBytes ? 'media_too_large' : 'invalid_request',
          size > config.mediaMaxBytes ? `Attachment exceeds ${Math.floor(config.mediaMaxBytes / (1024 * 1024))} MB` : 'size (bytes of ciphertext) is required', 400);
      }
      doc = { deferred: true, size, thumbSize: Number(body.thumbSize) || 0 };
    }

    const quota = config.mediaQuotaMb * 1024 * 1024;
    const incoming = blobBuf?.length ?? doc?.size ?? 0;
    if (incoming > quota) return fail(reply, 'media_quota', 'Attachment larger than the whole account quota', 413);
    const [totals] = await media.aggregate([
      { $match: { 'owner.ul': ul } },
      { $group: { _id: null, bytes: { $sum: '$ctSize' } } },
    ]).toArray();
    if ((totals?.bytes ?? 0) + incoming > quota) {
      return fail(reply, 'media_quota', `Storage quota reached (${config.mediaQuotaMb} MB)`, 413);
    }

    id = randomUUID();
    const inserted = {
      _id: id,
      owner: { ul, fd },
      kind,
      ctSize: blobBuf?.length ?? doc.size,
      thumbCtSize: thumbBuf?.length ?? (doc?.thumbSize || null),
      sha256: claimed,
      blob: blobBuf ?? null,
      thumb: thumbBuf ?? null,
      // an upload the client has not finished (or has abandoned): nothing may
      // reference it until the bytes are complete — see handlers.js
      upload: blobBuf ? 'ready' : 'pending',
      devices: [],   // filled by handleSend as envelopes referencing it land
      pending: [],   // authorised devices that still owe a download/decline
      reported: false,
      ts: new Date(),
    };
    // big inline-overflow goes to GridFS the same way a streamed one does
    if (blobBuf && blobBuf.length > config.mediaInlineMaxBytes) {
      const stored = await mediaStore.putBuffer(id, 'blob', blobBuf);
      inserted.blob = stored.fileRef;
    }
    if (thumbBuf && thumbBuf.length > config.mediaInlineMaxBytes) {
      const stored = await mediaStore.putBuffer(id, 'thumb', thumbBuf);
      inserted.thumb = stored.fileRef;
    }
    await media.insertOne(inserted);
    request.log.info(`[media] create ${id} ${kind} ${inserted.ctSize}B by ${ul}/${fd.slice(0, 8)} upload=${inserted.upload}`);
    return reply.code(201).send(doc?.deferred ? { id, stream: true } : { id });
  });

  // ---- PUT /api/media/:id/blob and /thumb ----
  // Raw ciphertext body, streamed to storage, cap enforced mid-flight, digest
  // verified as it lands. Owner-only (the uploader), and idempotent: a retry
  // replaces the partial file rather than adding a second one, which is what
  // lets a client re-send after a dropped connection without paying twice.
  for (const [part, capKey] of [['blob', 'mediaMaxBytes'], ['thumb', 'mediaThumbMaxBytes']]) {
    app.put(`/api/media/:id/${part}`, async (request, reply) => {
      const denied = requireAuth(request, reply);
      if (denied) return denied;
      const id = request.params.id;
      if (!MEDIA_ID_RE.test(id)) return fail(reply, 'unknown_media', 'No such attachment', 404);
      const limAcct = await effectiveLimit(settings, config, 'mediaupacct', request.auth.sub);
      const rlAcct = await rateLimit(redis, `rl:mediaupacct:${request.auth.sub}`, limAcct.limit, limAcct.windowSec);
      if (!rlAcct.ok) return limited(reply, rlAcct);

      const doc = await media.findOne({ _id: id });
      // a stranger PUTting bytes at a guessed id gets the same answer as a
      // missing blob — no oracle for which ids exist
      if (!doc || doc.owner.ul !== request.auth.sub || doc.owner.fd !== request.auth.d) {
        return fail(reply, 'unknown_media', 'No such attachment', 404);
      }
      if (doc[part]) {
        return fail(reply, 'already_uploaded', `This blob already has its ${part}`, 409);
      }
      const maxBytes = config[capKey];
      // Only the PAYLOAD has a recorded digest to check against. The thumbnail
      // does not — its own digest is never claimed (recipients authenticate it
      // with the AES-GCM tag, like every other ciphertext) — so verifying the
      // thumb against the blob's sha256 would reject every valid poster.
      const expect = part === 'blob' ? doc.sha256 : null;
      const result = await mediaStore.putStream(id, part, request.streamBody ?? request.raw, { maxBytes, sha256: expect });
      if (result.overflow) {
        return fail(reply, 'media_too_large', `Attachment exceeds ${Math.floor(maxBytes / (1024 * 1024))} MB`, 413);
      }
      if (result.mismatch) {
        return fail(reply, 'bad_sha256', 'sha256 does not match the uploaded bytes', 400);
      }
      const patch = {
        [part]: result.fileRef ?? result.inline,
        [part === 'blob' ? 'ctSize' : 'thumbCtSize']: result.bytes,
      };
      if (part === 'blob') patch.upload = 'ready';
      await media.updateOne({ _id: id }, { $set: patch });

      // The quota is checked again against what ACTUALLY arrived: a client that
      // claimed 1 MB and streamed 90 MB must not have bought the difference
      const quota = config.mediaQuotaMb * 1024 * 1024;
      const [totals] = await media.aggregate([
        { $match: { 'owner.ul': request.auth.sub } },
        { $group: { _id: null, bytes: { $sum: '$ctSize' } } },
      ]).toArray();
      if ((totals?.bytes ?? 0) > quota) {
        await dropBlob(ctx, id);
        return fail(reply, 'media_quota', `Storage quota reached (${config.mediaQuotaMb} MB)`, 413);
      }
      request.log.info(`[media] ${part} ${id} ${result.bytes}B by ${request.auth.sub}`);
      return reply.code(200).send({ ok: true, bytes: result.bytes, [part === 'blob' ? 'upload' : 'thumb']: 'ready' });
    });
  }

  // GET /api/media/:id — the ciphertext. ?part=thumb asks for just the
  // encrypted poster, so video previews never pull the payload; that fetch
  // deliberately does NOT ack (only a full download or a decline settles the
  // lifecycle, lib/media.js), and a blob with no poster answers `no_thumb`
  // rather than the 'gone' code — misreading those two once deleted a video.
  //
  // RANGES: `Accept-Ranges: bytes` + `Range: bytes=a-b` → 206 + Content-Range.
  // This is what makes an interrupted 100 MB download RESUMABLE instead of
  // starting over on a phone that just lost a bar of signal.
  //
  // Bytes leave here as application/octet-stream and NEVER as a browser-
  // renderable mime from our origin (CSP + nosniff stay load-bearing).
  app.get('/api/media/:id', async (request, reply) => {
    const denied = requireAuth(request, reply);
    if (denied) return denied;
    const limIp = await effectiveLimit(settings, config, 'mediadl');
    const rlIp = await rateLimit(redis, `rl:mediadl:${request.ip}`, limIp.limit, limIp.windowSec);
    if (!rlIp.ok) return limited(reply, rlIp);
    const limAcct = await effectiveLimit(settings, config, 'mediadlacct', request.auth.sub);
    const rlAcct = await rateLimit(redis, `rl:mediadlacct:${request.auth.sub}`, limAcct.limit, limAcct.windowSec);
    if (!rlAcct.ok) return limited(reply, rlAcct);

    const id = request.params.id;
    if (!MEDIA_ID_RE.test(id)) return fail(reply, 'unknown_media', 'No such attachment', 404);
    const wantThumb = request.query?.part === 'thumb';
    const doc = await media.findOne({ _id: id });
    const mine = !!doc && (
      (doc.owner.ul === request.auth.sub && doc.owner.fd === request.auth.d)
      || (doc.devices ?? []).some((d) => d.ul === request.auth.sub && d.dv === request.auth.d)
    );
    if (!doc || !mine) return fail(reply, 'unknown_media', 'No such attachment', 404);
    const field = wantThumb ? doc.thumb : doc.blob;
    if (!field) {
      return fail(reply, wantThumb ? 'no_thumb' : 'unknown_media',
        wantThumb ? 'This attachment has no preview image' : 'No such attachment', 404);
    }
    if (doc.upload === 'pending' && !wantThumb && !doc.blob) {
      // the payload is not complete — saying 'unknown_media' here would be read
      // by a client as 'gone for good' and acked away
      return fail(reply, 'upload_incomplete', 'This attachment is still being uploaded', 409);
    }
    const total = wantThumb ? (doc.thumbCtSize ?? 0) : doc.ctSize;
    reply.header('x-cocono-kind', doc.kind);
    reply.header('etag', `"${doc.sha256}"`);
    reply.header('accept-ranges', 'bytes');
    reply.header('cache-control', 'no-store');

    const range = parseRange(request.headers.range, total);
    if (range === 'bad') {
      reply.header('content-range', `bytes */${total}`);
      return fail(reply, 'invalid_range', 'Unsatisfiable range', 416);
    }
    if (range) {
      const [start, end] = range;
      reply.code(206);
      reply.header('content-range', `bytes ${start}-${end}/${total}`);
      reply.header('content-length', String(end - start + 1));
      if (isFileRef(field)) {
        return reply.type('application/octet-stream').send(
          await mediaStore.read(field, { start, end, total }));
      }
      return reply.type('application/octet-stream').send(inlineBytes(field).subarray(start, end + 1));
    }
    reply.header('content-length', String(total));
    if (isFileRef(field)) return reply.type('application/octet-stream').send(await mediaStore.read(field));
    return reply.type('application/octet-stream').send(inlineBytes(field));
  });

  // POST /api/media/:id/ack — "I downloaded it" OR "I declined it" (req 6:
  // deleting a file before downloading marks it received). Idempotent; the
  // blob dies the moment the last pending device acks (req 8), and its bytes go
  // with it wherever they were stored.
  app.post('/api/media/:id/ack', async (request, reply) => {
    const denied = requireAuth(request, reply);
    if (denied) return denied;
    const id = request.params.id;
    if (!MEDIA_ID_RE.test(id)) return fail(reply, 'unknown_media', 'No such attachment', 404);
    const limIp = await effectiveLimit(settings, config, 'mediadl');
    const rlIp = await rateLimit(redis, `rl:mediadl:${request.ip}`, limIp.limit, limIp.windowSec);
    if (!rlIp.ok) return limited(reply, rlIp);
    const limAcct = await effectiveLimit(settings, config, 'mediadlacct', request.auth.sub);
    const rlAcct = await rateLimit(redis, `rl:mediadlacct:${request.auth.sub}`, limAcct.limit, limAcct.windowSec);
    if (!rlAcct.ok) return limited(reply, rlAcct);

    const downloaded = request.body?.downloaded;
    if (typeof downloaded !== 'boolean') return fail(reply, 'invalid_request', 'downloaded must be a boolean', 400);

    const res = await ackDevice({ media, store: mediaStore }, { id, ul: request.auth.sub, dv: request.auth.d });
    // an ack from a device that is not on `devices` gets the SAME answer as a
    // gone blob: no enumeration, and the intent (I am done) is satisfied
    if (res.error) return fail(reply, 'unknown_media', 'No such attachment', 404);
    request.log.info(`[media] ack ${id} by ${request.auth.sub}/${request.auth.d.slice(0, 8)} downloaded=${downloaded} deleted=${res.deleted}`);
    return { ok: true, deleted: res.deleted };
  });

  // exposed for the report route, which must be able to READ a reported blob
  // (req 9) whether it is inline or in GridFS
  app.readMediaBytes = (doc, part) => readAll(mediaStore, doc, part);
}

/**
 * `Range: bytes=a-b` (single range only — that is all a resuming client sends)
 * → [start, end] inclusive, or null for none, or 'bad' when unsatisfiable.
 */
export function parseRange(header, total) {
  if (typeof header !== 'string' || !header.trim()) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;                      // unknown shape: serve the whole file
  let start = m[1] === '' ? null : Number(m[1]);
  let end = m[2] === '' ? null : Number(m[2]);
  if (start === null && end === null) return null;
  if (start === null) start = Math.max(0, total - end);   // suffix range
  else if (end === null || end > total - 1) end = total - 1;
  if (!Number.isFinite(start) || start < 0 || start >= total || start > end) return 'bad';
  return [start, end];
}
