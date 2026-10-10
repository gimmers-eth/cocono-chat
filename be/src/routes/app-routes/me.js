import { fail, requireAuth, limited } from '../shared.js';
import { rateLimit } from '../../lib/rateLimit.js';
import { b64uDecode } from '../../lib/b64u.js';
import { effectiveLimit } from '../../lib/limits.js';
import { badgesFor, evaluateBadges } from '../../lib/badges.js';
import { effectiveVerified, verifiedVoucherFilter } from '../../lib/moderation.js';

const ID_DOC_TYPES = new Set(['image/png', 'image/jpeg']);
const ID_DOC_MIN_BYTES = 128; // reject trivially-empty "photos"

// Magic-byte sniffing: the contentType a client DECLARES is untrusted —
// validate the actual bytes and store what we detected.
//   PNG : 89 50 4E 47 0D 0A 1A 0A
//   JPEG: FF D8 … FF D9 (SOI + EOI markers)
function sniffImage(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'image/png';
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8
    && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9) return 'image/jpeg';
  return null;
}

// GET /api/me — who am I + identity-verification state. POST /api/me/verify-id
// — upload the ID-document photo the admin reviews (image only, size-capped,
// never readable by the app again once uploaded, deleted on admin demand).
// True when at least one VERIFIED user has TRUSTED this account (their
// friend entry carries t:true and their own account is verified). This is
// the ID-upload gate: vouching must come from someone checked first.
async function hasTrustedVerifier(users, ul) {
  return users.findOne({
    ul: { $ne: ul },
    // a TIMED-OUT 'verified' voucher stands behind nothing right now —
    // effectiveVerified as a query (lib/moderation.js)
    ...verifiedVoucherFilter(),
    friends: { $elemMatch: { u: ul, t: true } },
  }, { projection: { _id: 1 } })
    .then((doc) => !!doc);
}

export default async function meRoutes(app, { users, redis, config, idDocs, settings, counters }) {
  app.get('/api/me', async (request, reply) => {
    const denied = requireAuth(request, reply);
    if (denied) return denied;

    const user = await users.findOne({ ul: request.auth.sub });
    if (!user) return fail(reply, 'unknown_account', 'Account not found', 404);
    const idDoc = await idDocs.findOne({ ul: user.ul }, { projection: { contentType: 1, uploadedAt: 1, _id: 0 } });
    const canUploadId = !config.idUploadRequiresTrustedVerifier || !!idDoc || effectiveVerified(user)
      || (await hasTrustedVerifier(users, user.ul));
    return {
      u: user.u,
      d: request.auth.d,
      createdAt: user.createdAt,
      // while a staff TIMEOUT runs the account behaves UNVERIFIED
      verified: effectiveVerified(user),
      premium: !!user.premium,
      badges: badgesFor(user),
      displayBadge: user.displayBadge ?? null,
      idDoc,
      canUploadId,
    };
  });

  // GET /api/me/badges — the client poll (login + every 60s while signed in)
  // IS the dispatch channel: `new` carries badges the user has not seen in a
  // modal yet; the read ACKs them (badgesSeen), so a badge nags exactly once
  // across all their devices… a device that already showed it just sees [].
  // The poll also nudges re-evaluation (new badges shipped since last login);
  // the serial queue makes concurrent polls cheap no-ops.
  app.get('/api/me/badges', async (request, reply) => {
    const denied = requireAuth(request, reply);
    if (denied) return denied;
    const ul = request.auth.sub;
    let user = await users.findOne({ ul });
    if (!user) return fail(reply, 'unknown_account', 'No such user', 404);
    await evaluateBadges(users, config, ul, counters);
    user = await users.findOne({ ul }); // re-read: eval may have just awarded
    const held = badgesFor(user);
    const seen = new Set(user.badgesSeen ?? []);
    // unseen = its GRANT id not acked yet; a bare legacy id in seen (old
    // scheme acked by badge id) still suppresses one-time re-notification.
    // The GET does NOT ack anymore: acknowledgement is a separate call the
    // client makes AFTER it has shown the modal — a poll whose response
    // never rendered (tab died mid-login) must NOT silently consume the
    // dispatch. That was the premium-modal-vanishing bug.
    const fresh = held.filter((b) => !seen.has(b.gid) && !seen.has(b.id));
    return {
      badges: held,
      new: fresh,
      displayBadge: user.displayBadge ?? null,
    };
  });


  // POST /api/me/badges/ack { gids: [...] } — the client confirms it has
  // DISPATCHED these grants (modal queued). Only then do they stop being
  // 'new'. Unknown gids are ignored; acking is per-GRANT, so a re-award
  // (new gid) always dispatches again.
  app.post('/api/me/badges/ack', async (request, reply) => {
    const denied = requireAuth(request, reply);
    if (denied) return denied;
    const ul = request.auth.sub;
    const gids = Array.isArray(request.body?.gids)
      ? request.body.gids.filter((g) => typeof g === 'string' && g.length <= 128).slice(0, 64)
      : [];
    if (!gids.length) return { acked: 0 };
    await users.updateOne({ ul }, { $addToSet: { badgesSeen: { $each: gids } } });
    return { acked: gids.length };
  });

  // base64 inflates ~4/3: cap the raw HTTP body above the decoded max
  app.post('/api/me/verify-id', {
    bodyLimit: Math.ceil(config.idDocMaxBytes * 1.4) + 8192,
  }, async (request, reply) => {
    const denied = requireAuth(request, reply);
    if (denied) return denied;
    const ul = request.auth.sub;

    const limIp = await effectiveLimit(settings, config, 'iddocip');
    const rlIp = await rateLimit(redis, `rl:iddocip:${request.ip}`, limIp.limit, limIp.windowSec);
    if (!rlIp.ok) return limited(reply, rlIp);
    const limAcct = await effectiveLimit(settings, config, 'iddoc', ul);
    const rlAcct = await rateLimit(redis, `rl:iddoc:${ul}`, limAcct.limit, limAcct.windowSec);
    if (!rlAcct.ok) return limited(reply, rlAcct);

    const user = await users.findOne({ ul }, { projection: { verified: 1, timeoutUntil: 1 } });
    if (!user) return fail(reply, 'unknown_account', 'Account not found', 404);
    // a TIMED-OUT account is unverified to the world — it may re-upload
    if (effectiveVerified(user)) return fail(reply, 'already_verified', 'Account is already verified', 400);
    // Gate: ID upload unlocks only after a verified user has trusted us
    // (already-uploaded users may re-upload; the admin sees the pending doc)
    if (config.idUploadRequiresTrustedVerifier && !(await hasTrustedVerifier(users, ul))) {
      return fail(reply, 'needs_trusted_verifier',
        'ID upload unlocks once a verified user trusts you', 403);
    }

    const { contentType, data } = request.body ?? {};
    if (!ID_DOC_TYPES.has(contentType)) {
      return fail(reply, 'bad_content_type', 'ID photo must be image/png or image/jpeg', 400);
    }
    const buf = typeof data === 'string' ? b64uDecode(data) : null;
    if (!buf || !buf.length) return fail(reply, 'bad_payload', 'data must be base64url bytes', 400);
    if (buf.length < ID_DOC_MIN_BYTES) {
      return fail(reply, 'too_small', 'ID photo looks empty — use a proper camera photo', 400);
    }
    if (buf.length > config.idDocMaxBytes) {
      return fail(reply, 'too_large', `ID photo exceeds ${Math.floor(config.idDocMaxBytes / (1024 * 1024))} MB`, 413);
    }
    const sniffed = sniffImage(buf);
    if (!sniffed) return fail(reply, 'not_an_image', 'File is not a real PNG/JPEG image', 400);

    await idDocs.updateOne(
      { ul },
      // store the SNIFFED type, not the client's claim — the admin viewer
      // and the app's metadata can both trust it
      { $set: { ul, contentType: sniffed, data: buf, uploadedAt: new Date() } },
      { upsert: true },
    );
    return { uploaded: true, bytes: buf.length, contentType: sniffed };
  });
}
