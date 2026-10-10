import { fail, requireAuth, limited } from '../shared.js';
import { rateLimit } from '../../lib/rateLimit.js';
import { USERNAME_RE } from '../../lib/username.js';
import { effectiveLimit } from '../../lib/limits.js';
import { applyBlock } from '../../lib/blockAccount.js';
import { createNotifier } from '../../lib/notify.js';

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

export default async function reportRoutes(app, { users, redis, config, settings, reports }) {
  const { notify: notifyAccount } = createNotifier({ redis, users });

  app.post('/api/me/report', {
    // transcripts can outgrow Fastify's 1 MB default body cap — the real
    // gate is MAX_MESSAGES x MAX_MESSAGE_LEN, allow headroom for it
    bodyLimit: 8 * 1024 * 1024,
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

    await reports.insertOne({
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
    });
    request.log.info(`[reports] report against @${peer} from @${ul}${blocked ? ' (+block)' : ''}`);
    return reply.code(202).send({ reported: true, blocked });
  });
}
