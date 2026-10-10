import { fail, limited, requireAuth } from '../shared.js';
import { rateLimit } from '../../lib/rateLimit.js';
import { effectiveLimit } from '../../lib/limits.js';
import { recordShareHit, shareableName } from '../../lib/shares.js';

// ---- SHARE-LINK CLICKS --------------------------------------------------
// POST /api/share/hit — "I opened someone's /?chat=<name> link and I already
// have an account." The client reports it once per link open, after the
// session exists (an anonymous opener reports nothing; if that visitor signs
// up instead, the CREATED edge is written by /api/signup's `r` field).
//
// Requires a JWT: the fact being recorded is a relation between two real
// accounts (owner -> viewer), and an unauthenticated endpoint here would be
// a free write-anywhere graph spoofer. The write is an upsert on the
// (owner, viewer) pair, so a client re-reporting the same link only bumps a
// counter — bounded by design, and rate limited on top (catalog: sharehit).
//
// Nothing about the CONVERSATION is recorded. Metadata only: who clicked
// whose link, how often, when. See lib/shares.js for the whole model.
export default async function shareRoutes(app, { users, redis, config, settings, shares }) {
  app.post('/api/share/hit', async (request, reply) => {
    const denied = requireAuth(request, reply);
    if (denied) return denied;
    const viewer = String(request.auth.sub ?? '').toLowerCase();

    const lim = await effectiveLimit(settings, config, 'sharehit', viewer);
    const rl = await rateLimit(redis, `rl:sharehit:${viewer}`, lim.limit, lim.windowSec);
    if (!rl.ok) return limited(reply, rl);

    const owner = shareableName(request.body?.o);
    if (!owner) return fail(reply, 'bad_username', 'Invalid username', 400);
    // Opening your OWN shared link is not a referral event — the client
    // suppresses it too; this is the server-side half of that rule.
    if (owner === viewer) return { recorded: false, reason: 'self' };
    if (!await users.findOne({ ul: owner }, { projection: { _id: 1 } })) {
      return fail(reply, 'unknown_account', 'No such user', 404);
    }

    const recorded = await recordShareHit(shares, { owner, viewer });
    return { recorded, o: owner };
  });

  // GET /api/me/share-link — the deep link this account hands out, plus what
  // it has produced so far (counts only: created / clicked). The client uses
  // it for the share sheet copy; the counts let a future UI show "N people
  // joined from your link" without exposing WHO to the account itself.
  app.get('/api/me/share-link', async (request, reply) => {
    const denied = requireAuth(request, reply);
    if (denied) return denied;
    const ul = String(request.auth.sub ?? '').toLowerCase();
    if (!shares) return { ul, path: `/?chat=${ul}`, created: 0, clicked: 0 };
    const [created, clicked] = await Promise.all([
      shares.countDocuments({ o: ul, created: { $exists: true } }),
      shares.countDocuments({ o: ul }),
    ]);
    return { ul, path: `/?chat=${ul}`, created, clicked };
  });
}
