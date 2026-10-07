import { fail, requireAuth, limited } from '../shared.js';
import { rateLimit } from '../../lib/rateLimit.js';
import { b64uDecode } from '../../lib/b64u.js';

const ID_DOC_TYPES = new Set(['image/png', 'image/jpeg']);

// GET /api/me — who am I + identity-verification state. POST /api/me/verify-id
// — upload the ID-document photo the admin reviews (image only, size-capped,
// never readable by the app again once uploaded, deleted on admin demand).
export default async function meRoutes(app, { users, redis, config, idDocs }) {
  app.get('/api/me', async (request, reply) => {
    const denied = requireAuth(request, reply);
    if (denied) return denied;

    const user = await users.findOne({ ul: request.auth.sub });
    if (!user) return fail(reply, 'unknown_account', 'Account not found', 404);
    const idDoc = await idDocs.findOne({ ul: user.ul }, { projection: { contentType: 1, uploadedAt: 1, _id: 0 } });
    return {
      u: user.u,
      d: request.auth.d,
      createdAt: user.createdAt,
      verified: !!user.verified,
      idDoc,
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

    const { contentType, data } = request.body ?? {};
    if (!ID_DOC_TYPES.has(contentType)) {
      return fail(reply, 'bad_content_type', 'ID photo must be image/png or image/jpeg', 400);
    }
    const buf = typeof data === 'string' ? b64uDecode(data) : null;
    if (!buf || !buf.length) return fail(reply, 'bad_payload', 'data must be base64url bytes', 400);
    if (buf.length > config.idDocMaxBytes) {
      return fail(reply, 'too_large', `ID photo exceeds ${Math.floor(config.idDocMaxBytes / (1024 * 1024))} MB`, 413);
    }

    await idDocs.updateOne(
      { ul },
      { $set: { ul, contentType, data: buf, uploadedAt: new Date() } },
      { upsert: true },
    );
    return { uploaded: true, bytes: buf.length, contentType };
  });
}
