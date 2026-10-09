import { fail, requireAuth, limited } from '../shared.js';
import { rateLimit } from '../../lib/rateLimit.js';
import { USERNAME_RE } from '../../lib/username.js';
import { effectiveLimit } from '../../lib/limits.js';
import { createNotifier } from '../../lib/notify.js';

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
// VERIFICATION IS A MUTUAL RELATION: the v (verified) stage may only be SET
// once both accounts have added each other, and verified/trust are gated on
// that mutuality on EVERY read — the moment either side un-adds, the
// confirmed state is dead on both ends. DELETE additionally REVOKES the
// peer's stored v/t flags on me (their add survives as one-sided,
// unconfirmed).
//
// Live sync between a user's OWN devices rides E2EE system messages from
// the acting device; the server list remains the source of truth that new
// and offline devices reconcile against (GET /api/me/friends on app entry).
export default async function friendsRoutes(app, { users, redis, config, settings }) {
  const key = (request) => `rl:friends:${request.ip}`;

  async function guard(request, reply, limiterName) {
    const denied = requireAuth(request, reply);
    if (denied) return denied;
    // 'friends' = reads, 'friendschange' = mutations; both admin-tunable
    // (lib/limits.js) and sharing one per-IP counter, limit applied per verb.
    const lim = await effectiveLimit(settings, config, limiterName);
    const rl = await rateLimit(redis, key(request), lim.limit, lim.windowSec);
    return rl.ok ? null : limited(reply, rl);
  }

  // Per-account BUDGETS on the vouching actions (verify / trust): daily and
  // weekly fixed-window counters (fvday/fvweek/ftday/ftweek), admin-tunable
  // globally AND per user. Rejected attempts still consume the counter — the
  // budget caps grinding, not just successes. Returns a reply to send, or null.
  const fmtWait = (sec) => (sec >= 3600 ? `${Math.ceil(sec / 3600)}h` : `${Math.max(1, Math.ceil(sec / 60))}m`);
  async function stageBudget(reply, ul, names, verb) {
    for (const nm of names) {
      const lim = await effectiveLimit(settings, config, nm, ul);
      const rl = await rateLimit(redis, `rl:${nm}:${ul}`, lim.limit, lim.windowSec);
      if (rl.ok) continue;
      reply.header('retry-after', String(rl.retryAfterSec));
      const unit = nm.endsWith('week') ? 'week' : 'day';
      // 'stage_limited' (not plain rate_limited): the daily/weekly budget is
      // a policy allowance, not an abuse signal — the app shows this exact
      // human sentence instead of the generic "too many messages" copy.
      return fail(reply, 'stage_limited',
        `${verb} limit: ${lim.limit} per ${unit} — try again in ${fmtWait(rl.retryAfterSec)}.`, 429);
    }
    return null;
  }

  function targetOf(request) {
    const ul = String(request.params.ul ?? '').toLowerCase();
    return USERNAME_RE.test(ul) ? ul : null;
  }

  // Real-time relationship changes ride the shared control-nudge pattern
  // (see lib/notify.js): when MY list gains/loses a peer, the PEER's own
  // view flips too (their addedBack of me unlocks/revokes the verification
  // gate), so their devices get a content-free 'friends' nudge and re-pull.
  const { notify: notifyAccount } = createNotifier({ redis, users });

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
        { projection: { ul: 1, identity: 1, devices: 1, friends: 1 } },
      ).toArray();
      for (const doc of docs) {
        live.set(doc.ul, {
          idp: doc.identity?.p ?? doc.devices?.[0]?.pub ?? null,
          // did they add ME back? verification is a relation BETWEEN two
          // accounts — a one-sided list entry has nothing to confirm
          addedBack: normalize(doc.friends).some((f) => f.u === ul),
        });
      }
    }
    return entries.map((e) => {
      const info = live.get(e.u);
      const idp = info?.idp ?? null;
      const addedBack = info?.addedBack ?? false;
      const trusted = idp !== null && e.p !== null && e.p === idp;
      return {
        u: e.u,
        p: e.p,
        gone: idp === null,
        changed: idp !== null && e.p !== null && e.p !== idp,
        trusted,
        addedBack,
        // verification AND the trust stage live HERE (server) so they
        // propagate to every device of this account (sys messages for live
        // ones, reconcile-on-entry for the rest). Both only count while the
        // binding itself is valid; re-binding (new key) resets them — and
        // both REQUIRE the mutual add (see header): an un-add on EITHER
        // side silently voids the flags until both re-add and re-compare.
        verified: trusted && addedBack && e.v === true,
        trust: trusted && addedBack && e.v === true && e.t === true,
      };
    });
  }

  app.get('/api/me/friends', async (request, reply) => {
    const denied = await guard(request, reply, 'friends');
    if (denied) return denied;
    return { friends: await enriched(request.auth.sub) };
  });

  // GET /api/me/stage-limits — the app's Settings > Usage panel shows the
  // vouching budgets THIS account has: the limit actually in force (same
  // resolver as enforcement: user override > app override > default) and the
  // spend from the very counters the budget checks use. Safe to return:
  // subjects only ever read their own counters, and the numbers are theirs.
  app.get('/api/me/stage-limits', async (request, reply) => {
    const denied = requireAuth(request, reply);
    if (denied) return denied;
    const ul = request.auth.sub;
    const spec = [
      ['verifyDaily', 'fvday'], ['verifyWeekly', 'fvweek'],
      ['trustDaily', 'ftday'], ['trustWeekly', 'ftweek'],
    ];
    const out = {};
    for (const [key, nm] of spec) {
      const lim = await effectiveLimit(settings, config, nm, ul);
      const [count, ttl] = await Promise.all([
        redis.get(`rl:${nm}:${ul}`),
        redis.ttl(`rl:${nm}:${ul}`),
      ]);
      out[key] = {
        limit: lim.limit,
        // blocked attempts still consume the counter by design (grinding
        // protection) — clamp the display so it never reads '5 of 4'
        used: Math.min(lim.limit, Math.max(0, Number(count ?? 0))),
        resetInSec: Math.max(0, Number(ttl ?? 0)),
      };
    }
    return out;
  });

  app.put('/api/me/friends/:ul', async (request, reply) => {
    const denied = await guard(request, reply, 'friendschange');
    if (denied) return denied;
    const ul = request.auth.sub;
    const target = targetOf(request);
    if (!target) return fail(reply, 'bad_username', 'Invalid username', 400);
    if (target === ul) return fail(reply, 'self_friend', 'You cannot friend yourself', 400);
    const targetDoc = await users.findOne({ ul: target }, { projection: { identity: 1, devices: 1, blocked: 1 } });
    if (!targetDoc) return fail(reply, 'unknown_account', 'No such user', 404);
    // ground-truth binding — whatever the client thinks, we store the NOW
    // BLOCK GATE (add seam): the blocker never learns who tried — the
    // attempt just never lands. Copy stays neutral (no "you are blocked").
    if (Array.isArray(targetDoc.blocked) && targetDoc.blocked.includes(ul)) {
      return fail(reply, 'blocked', 'This user is not accepting contacts.', 403);
    }

    const idp = targetDoc.identity?.p ?? targetDoc.devices?.[0]?.pub ?? null;

    // read-modify-write (single-account scale; unique-ul index protects the
    // doc, and the operation is idempotent: re-add = RE-BIND, and a new key
    // is never "verified" until the numbers are compared again)
    const user = await users.findOne({ ul }, { projection: { friends: 1 } });
    const list = normalize(user?.friends);
    const existing = list.find((f) => f.u === target);
    let freshAdd = false;
    if (existing) {
      existing.p = idp;
      existing.v = false; // a new key is never pre-verified or pre-trusted
      existing.t = false;
    } else {
      if (list.length >= config.friendsMax) {
        return fail(reply, 'friends_full', `Friends list is full (max ${config.friendsMax})`, 409);
      }
      list.push({ u: target, p: idp, v: false, t: false });
      freshAdd = true;
    }
    await users.updateOne({ ul }, { $set: { friends: list.sort((a, b) => a.u.localeCompare(b.u)) } });
    // the peer's view of THIS relation just moved — nudge. A brand-new add
    // gets its own kind so the client can raise a real OS notification
    // ("someone added you"); a re-bind is just ordinary list churn.
    await notifyAccount(target, freshAdd ? 'request' : 'friends', { by: ul });
    return { friends: await enriched(ul) };
  });

  // shared flag setter for the two post-add stages (verify / trust)
  async function setFlag(request, reply, field, bodyKey, requires) {
    const denied = await guard(request, reply, 'friendschange');
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
    // The peer's derived view moved too — and when someone CONFIRMS us
    // (verify) or EXTENDS trust, that is a headline event: dedicated nudge
    // kinds so the client always OS-notifies. Undoing is quiet churn.
    if (on) await notifyAccount(target, field === 'v' ? 'verify' : 'trusts', { by: ul });
    else await notifyAccount(target, 'friends');
    return { friends: await enriched(ul) };
  }

  // PUT /api/me/friends/:ul/verify — "we compared the safety numbers".
  // SETTING requires the MUTUAL add: a stranger list is exactly the surface
  // a MITM would target, and there is no two-way relationship to confirm a
  // key inside. Undo is always allowed. (The "add this user first" 404 keeps
  // priority: no entry at all → not_friends, not not_mutual.)
  app.put('/api/me/friends/:ul/verify', async (request, reply) => {
    if (request.body?.verified === true) {
      const target = targetOf(request);
      if (!target) return fail(reply, 'bad_username', 'Invalid username', 400);
      const ul = String(request.auth.sub ?? '').toLowerCase();
      const meDoc = await users.findOne({ ul }, { projection: { friends: 1 } });
      if (normalize(meDoc?.friends).some((f) => f.u === target)) {
        const tDoc = await users.findOne({ ul: target }, { projection: { friends: 1 } });
        const back = tDoc ? normalize(tDoc.friends).some((f) => f.u === ul) : false;
        if (!back) {
          return fail(reply, 'not_mutual', `${target} has not added you back — verification unlocks once both of you have added each other`, 409);
        }
        // …and the per-account verify budget must allow it (fvday/fvweek)
        const over = await stageBudget(reply, ul, ['fvday', 'fvweek'], 'Verification');
        if (over) return over;
      }
    }
    return setFlag(request, reply, 'v', 'verified', null);
  });

  // PUT /api/me/friends/:ul/trust — third stage: "I know this person".
  // Requires the verify stage (a key you never confirmed cannot be trusted),
  // and spends the per-account trust budget (ftday/ftweek) — but only for a
  // genuine candidate (existing + verified), so impossible calls that
  // setFlag rejects with 404/409 never consume the budget.
  app.put('/api/me/friends/:ul/trust', async (request, reply) => {
    if (request.body?.trust === true) {
      const target = targetOf(request);
      if (!target) return fail(reply, 'bad_username', 'Invalid username', 400);
      const ul = String(request.auth.sub ?? '').toLowerCase();
      const meDoc = await users.findOne({ ul }, { projection: { friends: 1 } });
      const existing = normalize(meDoc?.friends).find((f) => f.u === target);
      if (existing?.v === true) {
        const over = await stageBudget(reply, ul, ['ftday', 'ftweek'], 'Trust');
        if (over) return over;
      }
    }
    return setFlag(request, reply, 't', 'trust', 'v');
  });

  // ---- BLOCKING ------------------------------------------------------
  // Blocking is the loud end of the ladder: it SEVERS the relation both
  // ways (stronger than un-adding) and walls off inbound traffic. Data:
  // account-level `blocked: [ul]`. Effects (enforced server-side):
  //   * the blocked party cannot send messages (ws handleSend gate — before
  //     storage, so store-and-forward + live delivery + push are ALL gated)
  //   * already-stored copies from them stop draining (deliverPending /
  //     handleResync filter — see ws-routes/handlers.js)
  //   * they cannot add you back ('blocked' 403 on the add route)
  //   * both friends entries are removed and every v/t flag they carried
  //     on you is revoked — trust never survives a block on either side.
  // The blocked party is NOT nudged that they were blocked (that is the
  // blocker's privacy); their own reconcile just shows the severed relation
  // as a stranger again. Unblocking restores nothing: relations are
  // rebuilt deliberately, like after an un-add.
  app.put('/api/me/friends/:ul/block', async (request, reply) => {
    const denied = await guard(request, reply, 'friendschange');
    if (denied) return denied;
    const target = targetOf(request);
    if (!target) return fail(reply, 'bad_username', 'Invalid username', 400);
    if (target === request.auth.sub) return fail(reply, 'self_block', 'You cannot block yourself', 400);
    // The blocker picks WHY (one of three, enforced as an enum). This is the
    // blocker's own account data — for recall in Settings and for admin
    // context — and is NEVER shown to the blocked party.
    // ids: 'nospeak' | 'unknown' | 'scam' (copy lives client-side in BLOCK_REASONS)
    const reason = String(request.body?.r ?? '');
    if (!['nospeak', 'unknown', 'scam'].includes(reason)) {
      return fail(reply, 'invalid_request', 'Pick a block reason', 400);
    }
    const ul = String(request.auth.sub ?? '').toLowerCase();
    const tDoc = await users.findOne({ ul: target }, { projection: { _id: 1, friends: 1 } });
    if (!tDoc) return fail(reply, 'unknown_account', 'No such user', 404);

    await users.updateOne({ ul }, {
      $addToSet: { blocked: target },
      $set: { [`blockReasons.${target}`]: { r: reason, at: new Date() } },
    });

    // sever BOTH ways (stronger than un-add: their entry on me goes too,
    // and my flags on them die with it — no half-trust may persist)
    const user = await users.findOne({ ul }, { projection: { friends: 1 } });
    const kept = normalize(user?.friends).filter((f) => f.u !== target);
    await users.updateOne({ ul }, { $set: { friends: kept.sort((a, b) => a.u.localeCompare(b.u)) } });
    const theirKept = normalize(tDoc.friends).filter((f) => f.u !== ul);
    if (theirKept.length !== normalize(tDoc.friends).length) {
      await users.updateOne({ ul: target }, { $set: { friends: theirKept.sort((a, b) => a.u.localeCompare(b.u)) } });
      // their view of the relation moved completely — nudge (they learn the
      // severing via their own re-pull, never that they are blocked)
      await notifyAccount(target, 'friends');
    }
    // my other devices: the entry left MY list too
    await notifyAccount(ul, 'friends');
    return { blocked: true };
  });

  app.delete('/api/me/friends/:ul/block', async (request, reply) => {
    const denied = await guard(request, reply, 'friendschange');
    if (denied) return denied;
    const target = targetOf(request);
    if (!target) return fail(reply, 'bad_username', 'Invalid username', 400);
    const ul = String(request.auth.sub ?? '').toLowerCase();
    await users.updateOne({ ul }, { $pull: { blocked: target }, $unset: { [`blockReasons.${target}`]: '' } });
    await notifyAccount(ul, 'friends');
    return { blocked: false };
  });

  // ---- MUTING --------------------------------------------------------
  // A mute silences NOTIFICATIONS from one person — messages still deliver
  // and the relation is untouched (unlike a block). The list lives on the
  // ACCOUNT (users.muted:[ul]) so every device mirrors it; enforcement sits
  // where pushes are decided (ws handleSend) — a muted sender can never
  // reach the notification layer from any device.
  app.put('/api/me/friends/:ul/mute', async (request, reply) => {
    const denied = await guard(request, reply, 'friendschange');
    if (denied) return denied;
    const target = targetOf(request);
    if (!target) return fail(reply, 'bad_username', 'Invalid username', 400);
    if (target === request.auth.sub) return fail(reply, 'self_mute', 'You cannot mute yourself', 400);
    const ul = String(request.auth.sub ?? '').toLowerCase();
    if (!await users.findOne({ ul: target }, { projection: { _id: 1 } })) {
      return fail(reply, 'unknown_account', 'No such user', 404);
    }
    await users.updateOne({ ul }, { $addToSet: { muted: target } });
    await notifyAccount(ul, 'muted'); // mirror to the blocker's other devices
    return { muted: true };
  });

  app.delete('/api/me/friends/:ul/mute', async (request, reply) => {
    const denied = await guard(request, reply, 'friendschange');
    if (denied) return denied;
    const target = targetOf(request);
    if (!target) return fail(reply, 'bad_username', 'Invalid username', 400);
    const ul = String(request.auth.sub ?? '').toLowerCase();
    await users.updateOne({ ul }, { $pull: { muted: target } });
    await notifyAccount(ul, 'muted');
    return { muted: false };
  });

  // GET /api/me/relationships — the unified view the Settings tab renders:
  // every contact I added (with trust stages) + everyone I blocked.
  app.get('/api/me/relationships', async (request, reply) => {
    const denied = await guard(request, reply, 'friends');
    if (denied) return denied;
    const ul = String(request.auth.sub ?? '').toLowerCase();
    const me = await users.findOne({ ul }, { projection: { friends: 1, blocked: 1, blockReasons: 1, muted: 1 } });
    const added = await enriched(ul);
    const blockedList = [...new Set((me?.blocked ?? []).map((u) => String(u).toLowerCase()))].sort();
    const blocked = [];
    for (const bu of blockedList) {
      // addedBack survives the sever ONLY if they re-added after blocking
      // (the add gate means they cannot while blocked — so this is always
      // false today; computed, not assumed, so the shape stays honest if
      // the policy ever gains a "block without severing" mode)
      const doc = await users.findOne({ ul: bu }, { projection: { friends: 1 } });
      blocked.push({
        peer: bu,
        addedBack: normalize(doc?.friends).some((f) => f.u === ul),
        reason: me?.blockReasons?.[bu]?.r ?? null,
        at: me?.blockReasons?.[bu]?.at ?? null,
      });
    }
    return { added, blocked, muted: [...new Set((me?.muted ?? []).map((u) => String(u).toLowerCase()))].sort() };
  });

  app.delete('/api/me/friends/:ul', async (request, reply) => {
    const denied = await guard(request, reply, 'friendschange');
    if (denied) return denied;
    const target = targetOf(request);
    if (!target) return fail(reply, 'bad_username', 'Invalid username', 400);
    // read-modify-write (same pattern as PUT): removes BOTH legacy string
    // entries and bound {u,p} objects without $pull query gymnastics
    const ul = String(request.auth.sub ?? '').toLowerCase();
    const user = await users.findOne({ ul }, { projection: { friends: 1 } });
    const kept = normalize(user?.friends).filter((f) => f.u !== target);
    await users.updateOne(
      { ul },
      { $set: { friends: kept.sort((a, b) => a.u.localeCompare(b.u)) } },
    );
    // un-adding breaks the verification BOTH ways: my entry is gone (above)
    // and their v/t flags on me are revoked server-side — their add survives
    // one-sided and unconfirmed until both re-add and re-compare numbers.
    const tDoc = await users.findOne({ ul: target }, { projection: { friends: 1 } });
    if (tDoc) {
      const their = normalize(tDoc.friends);
      const mine = their.find((f) => f.u === ul);
      if (mine && (mine.v || mine.t)) {
        mine.v = false;
        mine.t = false;
        await users.updateOne({ ul: target }, { $set: { friends: their } });
      }
    }
    // their side flipped twice (entry removed + flags revoked) — nudge
    await notifyAccount(target, 'friends');
    return { friends: await enriched(ul) };
  });
}
