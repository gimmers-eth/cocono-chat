import { fail, requireAuth, limited } from '../shared.js';
import { rateLimit } from '../../lib/rateLimit.js';
import { b64uDecode } from '../../lib/b64u.js';

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
    verified: true,
    friends: { $elemMatch: { u: ul, t: true } },
  }, { projection: { _id: 1 } })
    .then((doc) => !!doc);
}

export default async function meRoutes(app, { users, redis, config, idDocs }) {
  app.get('/api/me', async (request, reply) => {
    const denied = requireAuth(request, reply);
    if (denied) return denied;

    const user = await users.findOne({ ul: request.auth.sub });
    if (!user) return fail(reply, 'unknown_account', 'Account not found', 404);
    const idDoc = await idDocs.findOne({ ul: user.ul }, { projection: { contentType: 1, uploadedAt: 1, _id: 0 } });
    const canUploadId = !config.idUploadRequiresTrustedVerifier || !!idDoc || user.verified === true
      || (await hasTrustedVerifier(users, user.ul));
    return {
      u: user.u,
      d: request.auth.d,
      createdAt: user.createdAt,
      verified: !!user.verified,
      idDoc,
      canUploadId,
    };
  });

  // base64 inflates ~4/3: cap the raw HTTP body above the decoded max
  app.post('/api/me/verify-id', {
    bodyLimit: Math.ceil(config.idDocMaxBytes * 1.4) + 8192,
  }, async (request, reply) => {
    const denied = requireAuth(request, reply);
    if (denied) return denied;
    const ul = request.auth.sub;

    const rlIp = await rateLimit(redis, `rl:iddocip:${request.ip}`, config.idDocIpLimit, config.idDocWindowSec);
    if (!rlIp.ok) return limited(reply, rlIp);
    const rlAcct = await rateLimit(redis, `rl:iddoc:${ul}`, config.idDocAccountLimit, config.idDocWindowSec);
    if (!rlAcct.ok) return limited(reply, rlAcct);

    const user = await users.findOne({ ul }, { projection: { verified: 1 } });
    if (!user) return fail(reply, 'unknown_account', 'Account not found', 404);
    if (user.verified) return fail(reply, 'already_verified', 'Account is already verified', 400);
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
