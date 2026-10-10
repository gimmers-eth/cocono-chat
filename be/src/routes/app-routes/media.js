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
// bounded three ways in the same breath as the upload route itself: per-blob
// caps, a per-account quota, and retention/orphan sweeps (lib/media.js).
// 10 MB fits a Mongo doc with headroom; if the cap ever grows, move to GridFS
// BEHIND this module and leave the wire format alone.
//
// AUTHORISATION to download is exactly `(account, device) ∈ devices` — never
// username-only, so a recipient's second device must have received its own
// envelope copy to be entitled. The uploader may fetch its own blob until it
// dies (retry flows). Missing, swept and "exists but not yours" all answer
// the same 404 `unknown_media`: blob ids are never enumerable.

import { createHash, randomUUID } from 'node:crypto';
import { fail, requireAuth, limited } from '../shared.js';
import { rateLimit } from '../../lib/rateLimit.js';
import { effectiveLimit } from '../../lib/limits.js';
import { b64uDecode } from '../../lib/b64u.js';
import { MEDIA_ID_RE, MEDIA_KINDS, ackDevice, asBytes } from '../../lib/media.js';

// base64url of a blob, with the DECODED size capped before anything big is
// allocated — a hostile body must not make us buffer 100 MB of junk.
// Returns a Buffer, null (malformed/empty) or 'too_large'.
const decodeCapped = (b64, maxBytes) => {
  if (typeof b64 !== 'string' || !b64.length) return null;
  if (Math.ceil((b64.length * 3) / 4) > maxBytes) return 'too_large';
  const buf = b64uDecode(b64);
  if (!buf || !buf.length) return null;
  if (buf.length > maxBytes) return 'too_large';
  return buf;
};


export default async function mediaRoutes(app, { redis, config, settings, media }) {
  // POST /api/media — the sender uploads ciphertext (+ optional encrypted
  // thumbnail). Body: { kind, blob, thumb?, sha256 } (base64url).
  app.post('/api/media', {
    // the two caps, both base64-inflated, plus JSON envelope headroom
    bodyLimit: Math.ceil((config.mediaMaxBytes + config.mediaThumbMaxBytes) * 1.4) + 64 * 1024,
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

    const blob = decodeCapped(body.blob, config.mediaMaxBytes);
    if (blob === 'too_large') {
      return fail(reply, 'media_too_large', `Attachment exceeds ${Math.floor(config.mediaMaxBytes / (1024 * 1024))} MB`, 413);
    }
    if (!blob) return fail(reply, 'invalid_request', 'blob must be base64url ciphertext', 400);

    let thumb = null;
    if (body.thumb !== undefined && body.thumb !== null && body.thumb !== '') {
      thumb = decodeCapped(body.thumb, config.mediaThumbMaxBytes);
      if (thumb === 'too_large') return fail(reply, 'thumb_too_large', 'Thumbnail exceeds its cap', 413);
      if (!thumb) return fail(reply, 'invalid_request', 'thumb must be base64url ciphertext', 400);
    }

    // The uploader CLAIMS a digest of the ciphertext and every recipient
    // verifies its download against it (the claim travels inside the
    // encrypted payload). We verify it HERE too: a stored digest must never
    // lie, or the ETag becomes a way to poison every copy of this blob.
    const sha256 = createHash('sha256').update(blob).digest('base64url');
    if (typeof body.sha256 !== 'string' || body.sha256 !== sha256) {
      return fail(reply, 'bad_sha256', 'sha256 does not match the uploaded bytes', 400);
    }

    // QUOTA — the media half of the P0 'unbounded storage' concern: bytes
    // this account still holds server-side. Summed from the owned docs, so
    // it can never drift from what is really stored.
    const quota = config.mediaQuotaMb * 1024 * 1024;
    if (blob.length > quota) return fail(reply, 'media_quota', 'Attachment larger than the whole account quota', 413);
    const [totals] = await media.aggregate([
      { $match: { 'owner.ul': ul } },
      { $group: { _id: null, bytes: { $sum: '$ctSize' } } },
    ]).toArray();
    if ((totals?.bytes ?? 0) + blob.length > quota) {
      return fail(reply, 'media_quota', `Storage quota reached (${config.mediaQuotaMb} MB)`, 413);
    }

    const id = randomUUID();
    await media.insertOne({
      _id: id,
      owner: { ul, fd },
      kind,
      ctSize: blob.length,
      thumbCtSize: thumb ? thumb.length : null,
      sha256,
      blob,
      thumb,
      devices: [],   // filled by handleSend as envelopes referencing it land
      pending: [],   // authorised devices that still owe a download/decline
      reported: false,
      ts: new Date(),
    });
    request.log.info(`[media] upload ${id} ${kind} ${blob.length}B by ${ul}/${fd.slice(0, 8)}`);
    return reply.code(201).send({ id });
  });

  // GET /api/media/:id — download the CIPHERTEXT. ?part=thumb asks for just
  // the encrypted thumbnail, so video posters render without pulling 10 MB;
  // a thumb-only fetch deliberately does NOT ack (only a full download or a
  // decline settles the lifecycle, lib/media.js).
  //
  // Bytes leave here as application/octet-stream and NEVER as a browser-
  // renderable mime from our origin (CSP + nosniff stay load-bearing); the
  // client decrypts and hands itself a Blob URL.
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
      (doc.owner?.ul === request.auth.sub && doc.owner?.fd === request.auth.d)
      || (doc.devices ?? []).some((d) => d.ul === request.auth.sub && d.dv === request.auth.d)
    );
    if (!doc || !mine) return fail(reply, 'unknown_media', 'No such attachment', 404);
    const buf = asBytes(wantThumb ? doc.thumb : doc.blob);
    if (!buf) return fail(reply, 'unknown_media', 'No such attachment', 404);
    reply.header('x-cocono-kind', doc.kind);
    reply.header('etag', `"${doc.sha256}"`);
    return reply.type('application/octet-stream').send(buf);
  });

  // POST /api/media/:id/ack — "I downloaded it" OR "I declined it" (req 6:
  // deleting a file before downloading marks it received). Idempotent; the
  // blob dies the moment the last pending device acks (req 8).
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

    const res = await ackDevice(media, { id, ul: request.auth.sub, dv: request.auth.d });
    // an ack from a device that is not on `devices` gets the SAME answer as
    // a gone blob: no enumeration, and the intent (I am done) is satisfied
    if (res.error) return fail(reply, 'unknown_media', 'No such attachment', 404);
    request.log.info(`[media] ack ${id} by ${request.auth.sub}/${request.auth.d.slice(0, 8)} downloaded=${downloaded} deleted=${res.deleted}`);
    return { ok: true, deleted: res.deleted };
  });
}
