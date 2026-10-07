import { rateLimit } from '../../lib/rateLimit.js';
import { isValidUsername } from '../../lib/username.js';
import { fail, limited, requireAuth } from '../shared.js';

// GET /api/users/:username/stats — COUNTS ONLY (never who), about a
// profile's reputation on the platform:
//   addedBy    how many accounts list this user as a friend
//   trustedBy  how many have taken it to the trust stage
//   verifiedBy how many TRUSTERS are themselves ID-verified — the vouching
//              weight: a profile trusted by verified people is stronger
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

    const [addedBy, trustedBy, verifiedBy] = await Promise.all([
      users.countDocuments({ 'friends.u': ul }),
      users.countDocuments({ friends: { $elemMatch: { u: ul, t: true } } }),
      users.countDocuments({ verified: true, friends: { $elemMatch: { u: ul, t: true } } }),
    ]);
    return { u: ul, addedBy, trustedBy, verifiedBy };
  });
}
