import { ObjectId } from 'mongodb';
import { rateLimit } from '../../lib/rateLimit.js';
import { fail, limited } from '../shared.js';

const LIST_LIMIT = 50;
const MAX_TRANSCRIPT = 500; // matches the app route's cap (reports.js)
const MAX_MEDIA = 8;        // the app route caps a report at 3; headroom for legacy

// GET /api/admin/reports — abuse reports uploaded by the app's "Report user"
// action (chat menu), newest first. Each carries the reporter's reason +
// description and the transcript the reporter chose to share (plaintext — the
// client warns before sending). DELETE /:id closes a single report, DELETE /
// purges all. Same posture as diagnostics: the admin API is token-gated (or
// loopback); the limiter just keeps the 10 s polling panel from hammering Mongo.
//
// M4: a report can also carry ATTACHMENTS (req 9) — decrypted plaintext bytes,
// one `report_media` doc each (they are megabytes and a Mongo doc tops out at
// 16 MB, which three 10 MB attachments would blow through). The list carries
// their METADATA only; the bytes come from the per-item route below.
export default async function adminReportsRoutes(app, { redis, reports, reportMedia }) {
  const gate = async (request, reply, name, limit) => {
    const rl = await rateLimit(redis, `rl:adminreports:${name}:${request.ip}`, limit, 3600);
    return rl.ok ? null : limited(reply, rl);
  };

  app.get('/api/admin/reports', async (request, reply) => {
    const denied = await gate(request, reply, 'list', 600);
    if (denied) return denied;
    const docs = await reports
      .find({}, { projection: { _id: 1, ts: 1, ip: 1, ua: 1, account: 1, peer: 1, reason: 1, description: 1, blocked: 1, messages: 1, media: 1 } })
      .sort({ ts: -1 })
      .limit(LIST_LIMIT)
      .toArray();
    // which items actually have readable bytes: one query for the whole page
    const held = reportMedia
      ? new Set((await reportMedia
        .find({ report: { $in: docs.map((d) => d._id) } }, { projection: { report: 1, index: 1 } }).toArray())
        .map((m) => `${String(m.report)}:${m.index}`))
      : new Set();
    return docs.map((d) => ({
      id: String(d._id),
      ts: d.ts,
      ip: d.ip,
      ua: d.ua,
      account: d.account,
      peer: d.peer,
      reason: d.reason,
      description: d.description,
      blocked: d.blocked === true,
      messages: (d.messages ?? []).slice(0, MAX_TRANSCRIPT),
      media: (d.media ?? []).slice(0, MAX_MEDIA).map((mm, i) => ({
        index: i,
        kind: mm.kind ?? 'file',
        name: mm.name ?? '',
        mime: mm.mime ?? '',
        bytes: mm.bytes ?? null,
        blobId: mm.blobId ?? null,
        source: mm.source ?? null,
        undecryptable: mm.undecryptable === true,
        hasBytes: held.has(`${String(d._id)}:${i}`),
      })),
    }));
  });

  // GET /api/admin/reports/:id/media/:index — the PLAINTEXT bytes of one
  // reported attachment. Served from the ADMIN origin (loopback, token-gated),
  // never by pointing the panel at /api/media: that endpoint hands out
  // CIPHERTEXT to a user's own session and has no business in moderation.
  // The content type is SNIFFED from the bytes against a small allowlist —
  // a reported file that turns out to be HTML or SVG must not execute on this
  // origin just because its recorded mime said so.
  app.get('/api/admin/reports/:id/media/:index', async (request, reply) => {
    const denied = await gate(request, reply, 'media', 600);
    if (denied) return denied;
    if (!reportMedia) return fail(reply, 'unknown_media', 'No attachment store', 404);
    let oid;
    try {
      oid = new ObjectId(request.params.id);
    } catch {
      return fail(reply, 'invalid_id', 'Malformed report id', 400);
    }
    const index = Number(request.params.index);
    if (!Number.isInteger(index) || index < 0) return fail(reply, 'invalid_index', 'Malformed media index', 400);
    const item = await reportMedia.findOne({ report: oid, index });
    if (!item?.plain) return fail(reply, 'unknown_media', 'No such attachment in this report', 404);
    const buf = asBuffer(item.plain);
    if (!buf) return fail(reply, 'unknown_media', 'No such attachment in this report', 404);
    reply.header('x-content-type-options', 'nosniff');
    // inline for the formats a browser can only PREVIEW, download for the rest
    const type = sniffContentType(buf, item.mime);
    reply.header('content-disposition', `${type === 'application/octet-stream' ? 'attachment' : 'inline'}; filename="report-${index}"`);
    return reply.type(type).send(buf);
  });

  app.delete('/api/admin/reports/:id', async (request, reply) => {
    const denied = await gate(request, reply, 'del', 200);
    if (denied) return denied;
    let oid;
    try {
      oid = new ObjectId(request.params.id);
    } catch {
      return fail(reply, 'invalid_id', 'Malformed report id', 400);
    }
    const { deletedCount } = await reports.deleteOne({ _id: oid });
    if (!deletedCount) return fail(reply, 'unknown_report', 'No such report', 404);
    // the shared attachments die with the record that justified holding them
    if (reportMedia) await reportMedia.deleteMany({ report: oid });
    return { deleted: true };
  });

  app.delete('/api/admin/reports', async (request, reply) => {
    const denied = await gate(request, reply, 'purge', 20);
    if (denied) return denied;
    const { deletedCount } = await reports.deleteMany({});
    if (reportMedia) await reportMedia.deleteMany({});
    return { deleted: deletedCount };
  });
}

// Only formats a browser may RENDER from these bytes. Everything else is
// octet-stream + attachment (an attacker-authored file served as HTML or SVG
// would run on the admin origin).
const SNIFF = [
  ['image/png', (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50],
  ['image/jpeg', (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8],
  ['image/gif', (b) => b.length > 5 && b.subarray(0, 5).toString('latin1') === 'GIF89'],
  ['image/webp', (b) => b.length > 11 && b.subarray(0, 4).toString('latin1') === 'RIFF'
    && b.subarray(8, 12).toString('latin1') === 'WEBP'],
  ['video/mp4', (b) => b.length > 11 && b.subarray(4, 8).toString('latin1') === 'ftyp'],
  ['video/webm', (b) => b.length > 3 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf],
];
function sniffContentType(buf, claimedMime) {
  for (const [type, test] of SNIFF) if (test(buf)) return type;
  const claimed = String(claimedMime ?? '').toLowerCase();
  if (/^image\/(png|jpe?g|gif|webp)$/.test(claimed) || /^video\/(mp4|webm|quicktime)$/.test(claimed)) return claimed;
  return 'application/octet-stream';
}

function asBuffer(v) {
  if (!v) return null;
  if (Buffer.isBuffer(v)) return v;
  if (typeof v?.value === 'function') return Buffer.from(v.value());
  if (v.buffer instanceof Uint8Array) return Buffer.from(v.buffer.subarray(0, v.position ?? v.buffer.length));
  return null;
}
