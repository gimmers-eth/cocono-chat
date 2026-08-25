import { rateLimit } from '../../lib/rateLimit.js';
import { isValidUsername } from '../../lib/username.js';
import { fail, limited, requireAuth } from '../shared.js';

// GET /api/users/:username/keys — authenticated lookup of a user's device key
// material (Ed25519 verification key + X25519 agreement key), so clients can
// derive pairwise conversation keys and verify signed envelopes. Public keys
// are public by design; device ids are disclosed alongside (needed to address
// per-device E2EE ciphertexts).
export default async function userKeysRoutes(app, { users, redis, config }) {
  app.get('/api/users/:username/keys', async (request, reply) => {
    const denied = requireAuth(request, reply);
    if (denied) return denied;

    const rl = await rateLimit(redis, `rl:userkeys:${request.ip}`, config.userKeysIpLimit, config.userKeysIpWindowSec);
    if (!rl.ok) return limited(reply, rl);

    const username = request.params.username;
    if (!isValidUsername(username)) {
      return fail(reply, 'invalid_username', 'Malformed username', 400);
    }

    const user = await users.findOne({ ul: username.toLowerCase() });
    if (!user) return fail(reply, 'unknown_account', 'No such user', 404);

    return {
      u: user.u,
      devices: user.devices.map((dev) => ({ d: dev.id, p: dev.pub, x: dev.x ?? null })),
    };
  });
}
