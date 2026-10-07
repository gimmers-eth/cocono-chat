import { rateLimit } from '../../lib/rateLimit.js';
import { isValidUsername } from '../../lib/username.js';
import { fail, limited, requireAuth } from '../shared.js';

// GET /api/users/:username/stats — COUNTS ONLY (never who), about a
// profile's reputation. The three buckets are EXCLUSIVE stages of each
// vouch — every account that vouched for you lands in exactly one:
//   addedBy     added, but the safety number was never confirmed
//   verifiedBy  safety number verified, but not trusted yet
//   trustedBy   taken to the trust (vouch) stage
// Requires a JWT (same posture as the keys lookup) and is rate limited.
export default async function userStatsRoutes(app, { users, redis, config }) {
  app.get('/api/users/:username/stats', async (request, reply) => {
    const denied = requireAuth(request, reply);
    if (denied) return denied;
    const rl = await rateLimit(redis, `rl:ustats:${request.ip}`, config.userKeysIpLimit, config.userKeysIpWindowSec);
    if (!rl.ok) return limited(reply, rl);

    const username = request.params.username;
    if (!isValidUsername(username)) return fail(reply, 'invalid_username', 'Malformed username', 400);
    const ul = username.toLowerCase();
    const target = await users.findOne({ ul }, { projection: { _id: 1 } });
    if (!target) return fail(reply, 'unknown_account', 'No such user', 404);

    const [addedBy, verifiedBy, trustedBy] = await Promise.all([
      users.countDocuments({ friends: { $elemMatch: { u: ul, v: { $ne: true }, t: { $ne: true } } } }),
      users.countDocuments({ friends: { $elemMatch: { u: ul, v: true, t: { $ne: true } } } }),
      users.countDocuments({ friends: { $elemMatch: { u: ul, t: true } } }),
    ]);
    return { u: ul, addedBy, verifiedBy, trustedBy };
  });
}
