import { fail, requireAuth, limited } from '../shared.js';
import { rateLimit } from '../../lib/rateLimit.js';
import { USERNAME_RE } from '../../lib/username.js';

// Friends: a per-account, ONE-WAY trust list ("I trust this user"). Server
// storage is the source of truth so new/offline devices can fetch the whole
// list (GET /api/me/friends); live devices get E2EE system messages broadcast
// by the acting device itself (client SDK addFriend/removeFriend) — we
// deliberately do NOT relay account-wide events server-side, the push model
// (blind 'msg' push + queue peek) already covers wake-up.
//
// The list is independent of messages on purpose: clearing a chat deletes
// transcripts, never friendships.
export default async function friendsRoutes(app, { users, redis, config }) {
  const key = (request) => `rl:friends:${request.ip}`;

  async function guard(request, reply, limit) {
    const denied = requireAuth(request, reply);
    if (denied) return denied;
    const rl = await rateLimit(redis, key(request), limit, config.friendsIpWindowSec);
    return rl.ok ? null : limited(reply, rl);
  }

  function targetOf(request) {
    const ul = String(request.params.ul ?? '').toLowerCase();
    return USERNAME_RE.test(ul) ? ul : null;
  }

  app.get('/api/me/friends', async (request, reply) => {
    const denied = await guard(request, reply, config.friendsIpLimit);
    if (denied) return denied;
    const user = await users.findOne({ ul: request.auth.sub }, { projection: { friends: 1 } });
    return { friends: user?.friends ?? [] };
  });

  app.put('/api/me/friends/:ul', async (request, reply) => {
    const denied = await guard(request, reply, config.friendsChangeIpLimit);
    if (denied) return denied;
    const ul = request.auth.sub;
    const target = targetOf(request);
    if (!target) return fail(reply, 'bad_username', 'Invalid username', 400);
    if (target === ul) return fail(reply, 'self_friend', 'You cannot friend yourself', 400);
    const exists = await users.findOne({ ul: target }, { projection: { _id: 1 } });
    if (!exists) return fail(reply, 'unknown_account', 'No such user', 404);

    // Match while BELOW the cap ($size only fails when exactly max; missing
    // field matches too — first add creates the array). A non-match means
    // either 'already a friend' (no-op $addToSet) or 'at cap' — resolved
    // from the fresh document below, so both are correct without races.
    const res = await users.updateOne(
      { ul, friends: { $not: { $size: config.friendsMax } } },
      { $addToSet: { friends: target } },
    );
    if (!res.modifiedCount) {
      // Either already a friend (idempotent success) or at the cap — check.
      const user = await users.findOne({ ul }, { projection: { friends: 1 } });
      const friends = [...new Set(user?.friends ?? [])].sort();
      if (friends.includes(target)) return { friends };
      if (friends.length >= config.friendsMax) {
        return fail(reply, 'friends_full', `Friends list is full (max ${config.friendsMax})`, 409);
      }
      return fail(reply, 'internal', 'Unexpected friends state', 500);
    }
    const user = await users.findOne({ ul }, { projection: { friends: 1 } });
    return { friends: [...new Set(user?.friends ?? [])].sort() };
  });

  app.delete('/api/me/friends/:ul', async (request, reply) => {
    const denied = await guard(request, reply, config.friendsChangeIpLimit);
    if (denied) return denied;
    const target = targetOf(request);
    if (!target) return fail(reply, 'bad_username', 'Invalid username', 400);
    await users.updateOne({ ul: request.auth.sub }, { $pull: { friends: target } });
    const user = await users.findOne({ ul: request.auth.sub }, { projection: { friends: 1 } });
    return { friends: [...new Set(user?.friends ?? [])].sort() };
  });
}
