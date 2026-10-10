import { fail, requireAuth, limited } from '../shared.js';
import { rateLimit } from '../../lib/rateLimit.js';
import { USERNAME_RE } from '../../lib/username.js';
import { effectiveLimit } from '../../lib/limits.js';
import { applyBlock } from '../../lib/blockAccount.js';
import { createNotifier } from '../../lib/notify.js';
import { MEDIA_ID_RE, MEDIA_KINDS, asBytes, decryptWithKey } from '../../lib/media.js';
import { b64uDecode } from '../../lib/b64u.js';

// ---- REPORTING ---------------------------------------------------------
// POST /api/me/report — the chat menu's "Report user". A user flags
// toxic/illegal activity in a conversation and hands the server the
// PLAINTEXT of that chat (the transcript is E2EE, so the server holds
// nothing readable unless the reporter shares it themselves — which is
// exactly what the client warns about before sending).
// Data model (collection 'reports', kept until an admin deletes them —
// unlike diagnostics these are moderation records and get NO TTL):
//   { ts, ip, ua, account, peer, reason, description, blocked, messages }
// A report can OPTIONALLY block the reported peer in the same atomic act
// (client checkbox, default ON); the block uses the shared sever-both-ways
// implementation, so a reported-and-blocked peer loses messaging, re-add
// and delivery exactly like a plain block.
// Abuse of the feature itself is capped by per-IP + per-account limiters
// (report / reportacct in the limits catalog).

const REASON_IDS = ['scamming', 'harassment', 'graphic', 'other'];
// the block reason enum (friends.js) the picked report reason maps to
const BLOCK_REASON_FOR = { scamming: 'scam', harassment: 'nospeak', graphic: 'nospeak', other: 'nospeak' };
const MAX_DESCRIPTION_LEN = 2_000;
const MAX_MESSAGES = 500;
const MAX_MESSAGE_LEN = 8 * 1024;

// REPORT MEDIA (plan §7 / req 9). The server holds media as CIPHERTEXT and has
// no key — the key lives in each recipient's encrypted envelope. Reporting is
// the act that hands it over: the reporter's client already decrypted the
// conversation, so it can also supply the file keys of the attachments in it.
// With a key, the server decrypts the blob IT STILL HOLDS and stores the
// plaintext on the moderation record (kept until an admin deletes it); a blob
// already swept is recovered from the reporter's own copy (`data`), and one
// whose key does not open anything is stored as `undecryptable` — never a
// reason to fail the whole report.
//
// Caps: three items, 30 MB of plaintext in total (the budget an admin can be
// asked to look at for one report). Authorisation is the sharp edge: a key is
// only USEFUL for a blob the caller is listed on, and we enforce exactly that —
// the reporter must be the uploader or an account with a device in the blob's
// `devices` list. Without it this route would be a decryption oracle for
// anyone who guessed a blob id (and a channel for planted evidence).
//
// THE PLAINTEXT DOES NOT LIVE ON THE REPORT DOC. Mongo's document limit is
// 16 MB and three 10 MB attachments blow straight through it, so each
// decrypted item is its own `report_media` doc (≤ one attachment each, always
// under the cap) with the metadata mirrored on the report for the list view.
// Deleting a report deletes its media (admin-routes/reports.js).
const MAX_MEDIA_ITEMS = 3;
const MAX_MEDIA_TOTAL_BYTES = 30 * 1024 * 1024;
// env-overridable so a test (and a future ops decision) can shrink the shelf
// without editing code — the route reads it per request
const reportMediaBudget = (config) => Number(config.reportMediaMaxBytes) > 0
  ? Number(config.reportMediaMaxBytes) : MAX_MEDIA_TOTAL_BYTES;
const MAX_NAME_LEN = 160;

export default async function reportRoutes(app, { users, redis, config, settings, reports, media, reportMedia }) {
  const { notify: notifyAccount } = createNotifier({ redis, users });

  app.post('/api/me/report', {
    // transcripts can outgrow Fastify's 1 MB default body cap, and a report
    // may carry up to MAX_MEDIA_TOTAL_BYTES of base64 plaintext attachments
    // (1.4× for the encoding). The REAL gate is the per-item/total accounting
    // below — this is only the room to deliver it.
    bodyLimit: 8 * 1024 * 1024 + Math.ceil(MAX_MEDIA_TOTAL_BYTES * 1.4) + 64 * 1024,
  }, async (request, reply) => {
    const denied = requireAuth(request, reply);
    if (denied) return denied;
    const ul = String(request.auth.sub ?? '').toLowerCase();
    const limIp = await effectiveLimit(settings, config, 'report');
    const rlIp = await rateLimit(redis, `rl:report:${request.ip}`, limIp.limit, limIp.windowSec);
    if (!rlIp.ok) return limited(reply, rlIp);
    const limAcct = await effectiveLimit(settings, config, 'reportacct', ul);
    const rlAcct = await rateLimit(redis, `rl:reportacct:${ul}`, limAcct.limit, limAcct.windowSec);
    if (!rlAcct.ok) return limited(reply, rlAcct);

    const body = request.body ?? {};
    const peer = String(body.peer ?? '').toLowerCase();
    if (!USERNAME_RE.test(peer)) return fail(reply, 'bad_username', 'Invalid username', 400);
    if (peer === ul) return fail(reply, 'self_report', 'You cannot report yourself', 400);

    const reason = String(body.r ?? '');
    if (!REASON_IDS.includes(reason)) return fail(reply, 'invalid_request', 'Pick a report reason', 400);

    const description = String(body.description ?? '').trim();
    if (!description) return fail(reply, 'invalid_request', 'A description is required', 400);
    if (description.length > MAX_DESCRIPTION_LEN) {
      return fail(reply, 'invalid_request', `Description too long (max ${MAX_DESCRIPTION_LEN})`, 400);
    }

    // transcript shared by the reporter (unencrypted on purpose — the client
    // warns before sending). Only accept lines that could actually come from
    // this conversation: reporter or reported, plaintext, sane sizes.
    const rawMsgs = Array.isArray(body.messages) ? body.messages : [];
    const messages = [];
    for (const m of rawMsgs.slice(0, MAX_MESSAGES)) {
      const from = String(m?.from ?? '').toLowerCase();
      const text = typeof m?.text === 'string' ? m.text.slice(0, MAX_MESSAGE_LEN) : null;
      if (from !== ul && from !== peer) continue; // foreign senders: drop
      if (!text) continue;
      const ts = Number(m?.ts);
      messages.push({ from, text, ts: Number.isFinite(ts) ? ts : null });
    }

    const tDoc = await users.findOne({ ul: peer }, { projection: { _id: 1 } });
    if (!tDoc) return fail(reply, 'unknown_account', 'No such user', 404);

    // optional auto-block (client checkbox, default on). The target exists
    // (checked above), so applyBlock cannot fail here — but read the verdict
    // rather than assume it.
    const wantBlock = body.block === true;
    let blocked = false;
    if (wantBlock) {
      blocked = await applyBlock({ users, notifyAccount }, ul, peer, BLOCK_REASON_FOR[reason]);
    }

    // ---- attachments in the reported conversation (req 9) ----
    const rawMedia = Array.isArray(body.media) ? body.media.slice(0, MAX_MEDIA_ITEMS) : [];
    const mediaItems = [];
    const pendingWrites = [];
    let mediaBytes = 0;
    const mediaBudget = reportMediaBudget(config);
    for (const item of rawMedia) {
      const blobId = String(item?.blobId ?? '');
      if (!MEDIA_ID_RE.test(blobId)) continue;                       // junk: drop
      const kind = MEDIA_KINDS.includes(item?.kind) ? item.kind : 'file';
      const name = String(item?.name ?? '').slice(0, MAX_NAME_LEN);
      const mime = String(item?.mime ?? '').slice(0, 120);
      const entry = { blobId, kind, name, mime };
      let plainBuf = null;
      const supplied = item.data ? b64uDecode(String(item.data)) : null;
      const doc = media ? await media.findOne({ _id: blobId }) : null;
      if (doc) {
        // AUTHORISATION, and it is not a formality: the caller may only hand
        // us a key for a blob they were actually given (uploader, or an
        // account with a device in `devices`). Without this check the route
        // would be a decryption oracle for any guessed blob id — and a
        // planted-evidence channel, since we would also accept `data` from a
        // stranger claiming it came from that conversation.
        const mine = doc.owner.ul === ul || (doc.devices ?? []).some((d) => d.ul === ul);
        if (!mine) continue;
        entry.size = doc.ctSize;
        // PIN it whatever the outcome: a reported blob outlives every sweep
        // until the admin deletes the report (nothing may destroy evidence
        // while it is under review — req 9's whole point)
        if (media) await media.updateOne({ _id: blobId }, { $set: { reported: true } });
        const plain = decryptWithKey(doc.blob, item.key, item.iv);
        // server-decrypted bytes are the primary evidence; a reporter's own
        // copy is the fallback when the key does not open anything (a stale
        // record on the reporter's device) — never a failure of the report
        const from = plain ? plain : supplied;
        entry.source = plain ? 'server' : (supplied ? 'reporter' : null);
        if (!from) {
          entry.undecryptable = true;
          entry.reason = 'undecryptable';
        } else if (mediaBytes + from.length > mediaBudget) {
          entry.undecryptable = true;
          entry.reason = 'over_report_media_cap';
        } else {
          entry.bytes = from.length;
          plainBuf = from;                     // READABLE evidence, stored aside
          mediaBytes += from.length;
        }
        mediaItems.push(entry);
        pendingWrites.push({ plain: plainBuf, entry });
        continue;
      }
      // the blob is gone (swept, or acked-and-deleted before the report came
      // in): the reporter's own copy is the only remaining source
      if (supplied && mediaBytes + supplied.length <= mediaBudget) {
        entry.bytes = supplied.length;
        plainBuf = supplied;
        entry.source = 'reporter';               // handed over by the reporting client
        mediaBytes += supplied.length;
      } else if (supplied) {
        entry.undecryptable = true;
        entry.reason = 'over_report_media_cap';
      } else {
        entry.reason = 'no_copy';
        entry.undecryptable = true;
      }
      mediaItems.push(entry);
      pendingWrites.push({ plain: plainBuf, entry });
    }

    const inserted = await reports.insertOne({
      ts: new Date(),
      ip: request.ip,
      ua: String(request.headers['user-agent'] ?? '').slice(0, 256),
      account: ul,
      peer,
      reason,
      description,
      blocked,
      messageCount: messages.length,
      messages,
      // moderation payload: METADATA about the reported attachments (the
      // plaintext bytes are megabytes and live one doc each in report_media)
      mediaCount: mediaItems.length,
      mediaBytes,
      media: mediaItems.map(({ plain, ...meta }) => meta),
    });
    // one doc per decrypted attachment, tied to the report that justified it
    if (reportMedia && pendingWrites.length) {
      const rid = inserted.insertedId;
      for (const [i, item] of pendingWrites.entries()) {
        if (!item.plain) continue;
        await reportMedia.insertOne({
          report: rid, index: i, blobId: item.entry.blobId, kind: item.entry.kind,
          name: item.entry.name, mime: item.entry.mime, bytes: item.entry.bytes,
          source: item.entry.source ?? null, plain: item.plain, ts: new Date(),
        });
      }
    }
    request.log.info(`[reports] report against @${peer} from @${ul}${blocked ? ' (+block)' : ''} media=${mediaItems.length}/${mediaBytes}B`);
    return reply.code(202).send({ reported: true, blocked });
  });
}
