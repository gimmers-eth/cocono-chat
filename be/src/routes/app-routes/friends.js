import { fail, requireAuth, limited } from '../shared.js';
import { rateLimit } from '../../lib/rateLimit.js';
import { USERNAME_RE } from '../../lib/username.js';

// Friends: a per-account, ONE-WAY trust list ANCHORED TO IDENTITY KEYS.
//
// An entry is { u, p } where p is the target account's identity key
// (users.identity.p — the founder device key, frozen for that account's
// lifetime). The SERVER fills p authoritatively on add: clients cannot
// claim a key, so the binding is ground truth at that moment. A username
// re-registered after deletion gets a NEW identity key — which is exactly
// the signal that the trusted account is gone.
//
// Reads resolve the live directory and annotate every entry:
//   gone     -> that account no longer exists
//   changed  -> exists, but identity.p no longer matches the binding
//               (username re-registered): the anchor is broken
//   trusted  -> binding matches the live identity
// Legacy string entries (pre-key-anchoring) normalize to p:null and are
// UNTRUSTED by policy until explicitly re-added (nothing was live when the
// anchoring shipped, so strictness costs nothing and avoids silent binds).
//
// Devices seeing changed/gone should drop the entry locally, DELETE it from
// the server, and broadcast an E2EE friend- system message to their own
// account (client SDK) — so every device of every holder converges.
//
// Live sync between a user's OWN devices rides E2EE system messages from
// the acting device; the server list remains the source of truth that new
// and offline devices reconcile against (GET /api/me/friends on app entry).
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

  const normalize = (list) => (list ?? []).map((f) => (
    typeof f === 'string'
      ? { u: f, p: null, v: false, t: false }
      : { u: String(f.u ?? '').toLowerCase(), p: f.p ?? null, v: f.v === true, t: f.t === true }
  )).filter((f) => f.u);

  // entries + live-directory annotations (one $in query for all targets)
  async function enriched(ul) {
    const user = await users.findOne({ ul }, { projection: { friends: 1 } });
    const entries = normalize(user?.friends);
    const names = entries.map((e) => e.u);
    const live = new Map();
    if (names.length) {
      const docs = await users.find(
        { ul: { $in: names } },
        { projection: { ul: 1, identity: 1, devices: 1 } },
      ).toArray();
      for (const doc of docs) live.set(doc.ul, doc.identity?.p ?? doc.devices?.[0]?.pub ?? null);
    }
    return entries.map((e) => {
      const idp = live.get(e.u) ?? null;
      const trusted = idp !== null && e.p !== null && e.p === idp;
      return {
        u: e.u,
        p: e.p,
        gone: idp === null,
        changed: idp !== null && e.p !== null && e.p !== idp,
        trusted,
        // verification AND the trust stage live HERE (server) so they
        // propagate to every device of this account (sys messages for live
        // ones, reconcile-on-entry for the rest). Both only count while the
        // binding itself is valid; re-binding (new key) resets them.
        verified: trusted && e.v === true,
        trust: trusted && e.v === true && e.t === true,
      };
    });
  }

  app.get('/api/me/friends', async (request, reply) => {
    const denied = await guard(request, reply, config.friendsIpLimit);
    if (denied) return denied;
    return { friends: await enriched(request.auth.sub) };
  });

  app.put('/api/me/friends/:ul', async (request, reply) => {
    const denied = await guard(request, reply, config.friendsChangeIpLimit);
    if (denied) return denied;
    const ul = request.auth.sub;
    const target = targetOf(request);
    if (!target) return fail(reply, 'bad_username', 'Invalid username', 400);
    if (target === ul) return fail(reply, 'self_friend', 'You cannot friend yourself', 400);
    const targetDoc = await users.findOne({ ul: target }, { projection: { identity: 1, devices: 1 } });
    if (!targetDoc) return fail(reply, 'unknown_account', 'No such user', 404);
    // ground-truth binding — whatever the client thinks, we store the NOW
    const idp = targetDoc.identity?.p ?? targetDoc.devices?.[0]?.pub ?? null;

    // read-modify-write (single-account scale; unique-ul index protects the
    // doc, and the operation is idempotent: re-add = RE-BIND, and a new key
    // is never "verified" until the numbers are compared again)
    const user = await users.findOne({ ul }, { projection: { friends: 1 } });
    const list = normalize(user?.friends);
    const existing = list.find((f) => f.u === target);
    if (existing) {
      existing.p = idp;
      existing.v = false; // a new key is never pre-verified or pre-trusted
      existing.t = false;
    } else {
      if (list.length >= config.friendsMax) {
        return fail(reply, 'friends_full', `Friends list is full (max ${config.friendsMax})`, 409);
      }
      list.push({ u: target, p: idp, v: false, t: false });
    }
    await users.updateOne({ ul }, { $set: { friends: list.sort((a, b) => a.u.localeCompare(b.u)) } });
    return { friends: await enriched(ul) };
  });

  // shared flag setter for the two post-add stages (verify / trust)
  async function setFlag(request, reply, field, bodyKey, requires) {
    const denied = await guard(request, reply, config.friendsChangeIpLimit);
    if (denied) return denied;
    const target = targetOf(request);
    if (!target) return fail(reply, 'bad_username', 'Invalid username', 400);
    const on = request.body?.[bodyKey] === true;
    const ul = request.auth.sub;
    const user = await users.findOne({ ul }, { projection: { friends: 1 } });
    const list = normalize(user?.friends);
    const existing = list.find((f) => f.u === target);
    if (!existing) return fail(reply, 'not_friends', 'Add this user first', 404);
    if (on && requires && !existing[requires]) {
      return fail(reply, 'stage_required', 'Verify the safety number before trusting', 409);
    }
    existing[field] = on;
    if (!on && field === 'v') existing.t = false; // un-verifying revokes trust too
    await users.updateOne({ ul }, { $set: { friends: list } });
    return { friends: await enriched(ul) };
  }

  // PUT /api/me/friends/:ul/verify — "we compared the safety numbers".
  app.put('/api/me/friends/:ul/verify', (request, reply) => setFlag(request, reply, 'v', 'verified', null));

  // PUT /api/me/friends/:ul/trust — third stage: "I know this person".
  // Requires the verify stage (a key you never confirmed cannot be trusted).
  app.put('/api/me/friends/:ul/trust', (request, reply) => setFlag(request, reply, 't', 'trust', 'v'));

  app.delete('/api/me/friends/:ul', async (request, reply) => {
    const denied = await guard(request, reply, config.friendsChangeIpLimit);
    if (denied) return denied;
    const target = targetOf(request);
    if (!target) return fail(reply, 'bad_username', 'Invalid username', 400);
    // read-modify-write (same pattern as PUT): removes BOTH legacy string
    // entries and bound {u,p} objects without $pull query gymnastics
    const user = await users.findOne({ ul: request.auth.sub }, { projection: { friends: 1 } });
    const kept = normalize(user?.friends).filter((f) => f.u !== target);
    await users.updateOne(
      { ul: request.auth.sub },
      { $set: { friends: kept.sort((a, b) => a.u.localeCompare(b.u)) } },
    );
    return { friends: await enriched(request.auth.sub) };
  });
}
