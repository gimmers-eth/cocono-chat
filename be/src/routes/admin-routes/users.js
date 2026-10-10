import { randomUUID } from 'node:crypto';
import { fail } from '../shared.js';
import { deleteAccountFully } from '../../lib/accountState.js';
import { createNotifier } from '../../lib/notify.js';
import { pushBadgeHint } from '../../lib/push.js';
import { effectiveLimit, readLimitsDoc } from '../../lib/limits.js';
import { effectiveMaxDevices } from '../../lib/devicePolicy.js';
import { badgeById, badgesFor, badgeOverview, evaluateBadges, grantBadge, revokeBadge } from '../../lib/badges.js';

// Per-account device cap: 1..MAX_DEVICES_CAP. Raising it lets a user enroll
// more devices; lowering it below the current device count is allowed (the
// existing devices keep working, no new ones can be added).
const MAX_DEVICES_CAP = 1000;

// GET /api/admin/users, PATCH max-devices, DELETE user, DELETE device,
// PUT verified (identity-verification toggle), GET/DELETE id-doc (review).
export default async function usersRoutes(app, { users, redis, config, messages, idDocs, profiles, settings, diagnostics, counters }) {
  // account-review outcomes are invisible to the reviewed user otherwise —
  // content-free 'identity' nudges (lib/notify.js) make the app re-pull
  const { notify: notifyAccount, notifyPeers } = createNotifier({ redis, users });
  app.get('/api/admin/users', async () => {
    const docs = await users.find({}, { projection: { _id: 0 } }).sort({ ul: 1 }).toArray();
    const metas = await idDocs.find({}, { projection: { ul: 1, contentType: 1, uploadedAt: 1, _id: 0 } }).toArray();
    const byUl = new Map(metas.map((d) => [d.ul, d]));
    const profileDocs = await profiles.find({}, { projection: { ul: 1, avatar: 1, bio: 1, _id: 0 } }).toArray();
    const hasAvatar = new Set(profileDocs.filter((a) => a.avatar).map((a) => a.ul));
    const bioBy = new Map(profileDocs.filter((b) => b.bio).map((b) => [b.ul, b.bio]));
    // live IP-flap state per device: the counter (count/ttl) + the EFFECTIVE
    // budget (catalog layering: device override > app override > default),
    // so the user panel shows exactly what enforcement applies right now
    const limitsDoc = await readLimitsDoc(settings);
    const rows = [];
    for (const doc of docs) {
      const devices = [];
      for (const dev of doc.devices ?? []) {
        const subject = `${doc.ul}:${dev.id}`;
        const [count, ttl, eff] = await Promise.all([
          redis.get(`rl:ipflap:${subject}`),
          redis.ttl(`rl:ipflap:${subject}`),
          effectiveLimit(settings, config, 'ipflap', subject),
        ]);
        devices.push({
          id: dev.id,
          name: dev.name ?? null,
          lastIp: dev.lastIp ?? null,
          createdAt: dev.createdAt,
          lastSeenAt: dev.lastSeenAt,
          // PWA install state as the device last reported it (PUT
          // /api/devices/self): true installed, false tab-mode, null never
          // reported (non-browser device or no session since the flag shipped)
          installed: dev.installed === true ? true : dev.installed === false ? false : null,
          installedAt: dev.installedAt ?? null,
          flap: {
            count: Math.max(0, Number(count ?? 0)),
            limit: eff.limit,
            windowSec: eff.windowSec,
            ttlSec: Math.max(0, Number(ttl ?? 0)),
            override: !!limitsDoc.users[subject]?.ipflap,
          },
        });
      }
      rows.push({
        u: doc.u,
        ul: doc.ul,
        createdAt: doc.createdAt,
        // policy-derived cap (override > premium > verified > unverified) —
        // exactly what enroll/approve enforce
        maxDevices: effectiveMaxDevices(doc, config),
        maxDevicesOverride: Number.isInteger(doc.maxDevicesOverride) ? doc.maxDevicesOverride : null,
        verified: !!doc.verified,
        premium: !!doc.premium,
        verifiedAt: doc.verifiedAt ?? null,
        idDoc: byUl.get(doc.ul) ?? null,
        hasAvatar: hasAvatar.has(doc.ul),
        bio: bioBy.get(doc.ul) ?? '',
        badges: badgesFor(doc),
        displayBadge: doc.displayBadge ?? null,
        // 'known IPs' = the LATEST egress IP per device (written by the auth
        // hook's flap tracker); feeds the user panel's rate-limit search link
        ips: devices.map((d) => d.lastIp).filter(Boolean),
        devices,
      });
    }
    return rows;
  });

  // PUT /api/admin/users/:username/verified {verified} — the admin toggle.
  // Admins may verify with or without an ID document on file.
  app.put('/api/admin/users/:username/verified', async (request, reply) => {
    const ul = request.params.username.toLowerCase();
    const { verified } = request.body ?? {};
    if (typeof verified !== 'boolean') {
      return fail(reply, 'invalid_request', 'verified must be a boolean', 400);
    }
    const res = await users.updateOne(
      { ul },
      { $set: { verified, ...(verified ? { verifiedAt: new Date() } : { verifiedAt: null }) } },
    );
    if (!res.matchedCount) return fail(reply, 'unknown_account', 'No such user', 404);
    // Revoking verification also removes the profile photo: it was shown to
    // others under a trust state the admin has just withdrawn.
    if (!verified) await profiles.updateOne({ ul }, { $set: { avatar: null } });
    // 'verified' is its own nudge kind: the client OS-notifies "you are
    // verified". Verification awards NO badge (the badge engine has no
    // verified-eligibility — OG/EarlyBird are the only auto awards, and
    // those land at signup/login), so this route must NOT touch the badge
    // queue or push a badge hint: doing both made every verification fire a
    // spurious "new badge" notice (and, offline, a blind badge PUSH) ahead
    // of the verified one. One event, one notification.
    await notifyAccount(ul, verified ? 'verified' : 'identity');
    // the avatar vanished from under everyone who follows this account
    if (!verified) await notifyPeers(ul, 'profile');
    return { ul, verified };
  });

  // PUT /api/admin/users/:username/premium {premium} — the premium toggle.
  // Effect: device cap jumps to the premium tier (default 5) and every UI
  // (app + admin) badges the account with the gold certificate. No device
  // rows change — the cap is policy-derived (lib/devicePolicy.js).
  app.put('/api/admin/users/:username/premium', async (request, reply) => {
    const ul = request.params.username.toLowerCase();
    const { premium } = request.body ?? {};
    if (typeof premium !== 'boolean') {
      return fail(reply, 'invalid_request', 'premium must be a boolean', 400);
    }
    // Premium = a FLAG whose award runs through THE same grant route:
    // ON → evaluation awards it (fresh gid → modal + notification dispatch);
    // OFF → THE revoke primitive removes award + seen mark + worn chip.
    const set = { premium, ...(premium ? { premiumAt: new Date() } : { premiumAt: null }) };
    const res = await users.updateOne({ ul }, { $set: set });
    if (!res.matchedCount) return fail(reply, 'unknown_account', 'No such user', 404);
    if (premium) {
      await evaluateBadges(users, config, ul, counters); // awards awards.premium
      await notifyAccount(ul, 'identity'); // cap changed
      await notifyAccount(ul, 'badges');   // new badge: poll dispatches the modal NOW
      await pushBadgeHint(users, redis, config, ul);
    } else {
      await revokeBadge(users, { id: 'premium', ul }); // clears award, seen mark, worn chip
      await notifyAccount(ul, 'identity');
      await notifyAccount(ul, 'badges'); // picker/list re-pull without it
    }
    return { ul, premium };
  });

  // GET /api/admin/badges — every badge class with live holder counts and
  // cap state; the admin Badges table renders straight from this.
  app.get('/api/admin/badges', async () => ({ badges: await badgeOverview(users, config) }));

  // PUT /api/admin/users/:username/badge { id } — award a capped badge from
  // the admin panel (premium stays its own toggle). Queued serially so the
  // OG/early-bird caps survive concurrent awards; refuses when full.
  app.put('/api/admin/users/:username/badge', async (request, reply) => {
    const ul = request.params.username.toLowerCase();
    const id = request.body?.id;
    const badge = badgeById.get(String(id));
    // premium is the flag TOGGLE's business (its eligibility lives there);
    // everything else the admin can hand out goes through THE award route
    if (!badge || badge.id === 'premium') {
      return fail(reply, 'bad_badge', 'Unknown or non-awardable badge (premium is a toggle)', 400);
    }
    if (!await users.findOne({ ul })) return fail(reply, 'unknown_account', 'No such user', 404);
    let out;
    if (badge.mode === 'admin') {
      // set the eligibility flag, then let the SHARED evaluation award —
      // same grant path, same dispatch, re-awardable after a revoke
      await users.updateOne({ ul }, { $set: { [`adminAwards.${badge.id}`]: true } });
      await evaluateBadges(users, config, ul, counters);
      const user = await users.findOne({ ul });
      const g = user?.awards?.[badge.id];
      out = g ? { awarded: true, id: badge.id, gid: g.gid, at: g.at }
              : { awarded: false, held: !!g, id: badge.id };
    } else {
      const res = await grantBadge(users, { id: badge.id, ul, config });
      if (res?.full) {
        return fail(reply, 'badge_full', `${badge.label} is capped at ${badge.capOf(config)} holders — all taken`, 409);
      }
      out = res?.held ? { awarded: false, held: true, id: badge.id }
                      : { awarded: true, id: badge.id, gid: res?.gid, at: res?.at };
    }
    // wake the client NOW (poll dispatch) instead of waiting for its 60s
    // tick — and blind-push the devices that are NOT connected at all
    await notifyAccount(ul, 'badges');
    await pushBadgeHint(users, redis, config, ul);
    request.log.info(`[admin] awarded ${badge.id} to ${ul}`);
    return out;
  });

  // DELETE /api/admin/users/:username/badge/:id — revoke a CAPPED badge
  // (og/earlybird). Premium is toggled, not revoked here. Clearing the worn
  // badge follows the same rule as the premium toggle.
  app.delete('/api/admin/users/:username/badge/:id', async (request, reply) => {
    const ul = request.params.username.toLowerCase();
    const badge = badgeById.get(String(request.params.id));
    // premium is the toggle's business (its eligibility is the premium flag;
    // revoking the award alone would just be re-granted on next evaluation)
    if (!badge || badge.id === 'premium') {
      return fail(reply, 'bad_badge', 'Unknown or non-revocable badge (premium is a toggle)', 400);
    }
    if (!await users.findOne({ ul })) return fail(reply, 'unknown_account', 'No such user', 404);
    // admin-mode badges: drop the ELIGIBILITY flag first, or the next
    // evaluation would simply re-award what we just revoked
    if (badge.mode === 'admin') {
      await users.updateOne({ ul }, { $unset: { [`adminAwards.${badge.id}`]: '' } });
    }
    // THE revoke primitive: award gone, seen-ack gone (re-award re-dispatches),
    // worn chip stripped if it was this badge
    await revokeBadge(users, { id: badge.id, ul });
    await notifyAccount(ul, 'badges'); // client re-pulls: list, chip + picker update live
    return { revoked: true, id: badge.id };
  });

  // GET /api/admin/users/:username/relationships — how ONE account stands
  // toward every other and back: {ul, added (they're on my list),
  // theyAddedMe, verified / trust (mine, gated on mutuality exactly like the
  // app sees them)}. Feeds the user panel's Relationships tab; tiny-box
  // brute force (two collection reads) over anything index gymnastics.
  app.get('/api/admin/users/:username/relationships', async (request, reply) => {
    const ul = request.params.username.toLowerCase();
    const actor = await users.findOne({ ul }, { projection: { friends: 1, blocked: 1, blockReasons: 1 } });
    if (!actor) return fail(reply, 'unknown_account', 'No such user', 404);
    const myBlocked = new Set((actor.blocked ?? []).map((u) => String(u).toLowerCase()));
    const toList = (doc) => (doc?.friends ?? []).map((f) => (typeof f === 'string' ? { u: f } : f));
    const mine = new Map(toList(actor).map((f) => [String(f.u).toLowerCase(), f]));
    const others = await users.find(
      { ul: { $ne: ul } },
      { projection: { ul: 1, friends: 1, verified: 1, premium: 1, blocked: 1, blockReasons: 1 } },
    ).toArray();
    const rows = [];
    for (const other of others) {
      const m = mine.get(other.ul);
      const theirs = toList(other).find((f) => String(f.u).toLowerCase() === ul);
      // a BLOCK severs both friend entries — the wall itself is often the
      // ONLY relation left. Do not skip blocked pairs or the block columns
      // would show nothing for exactly the case they exist for.
      const wall = myBlocked.has(other.ul) || (other.blocked ?? []).some((u) => String(u).toLowerCase() === ul);
      if (!m && !theirs && !wall) continue;
      const mutual = !!m && !!theirs;
      rows.push({
        ul: other.ul,
        premium: other.premium === true,
        // blocks are one-way walls: which side faces whom (never merged —
        // "blocks" and "blocked-by" are different facts for the operator),
        // plus the blocker's own stated reason when the wall faces outward
        blocks: myBlocked.has(other.ul),
        blockReason: myBlocked.has(other.ul) ? (actor.blockReasons?.[other.ul]?.r ?? null) : null,
        blockedBy: (other.blocked ?? []).some((u) => String(u).toLowerCase() === ul),
        // the wall's stated reason travels WITH the wall — operators see it
        // from either side of the relation (it is the blocker's own words)
        blockedByReason: (other.blocked ?? []).some((u) => String(u).toLowerCase() === ul)
          ? (other.blockReasons?.[ul]?.r ?? null)
          : null,
        theyAddedMe: !!theirs,
        added: !!m,
        verified: !!(m?.v && mutual),   // same mutuality gate the app enforces
        trust: !!(m?.v && m?.t && mutual),
      });
    }
    rows.sort((a, b) => (Number(b.blocks) - Number(a.blocks))
      || (Number(b.added) - Number(a.added)) || a.ul.localeCompare(b.ul));
    return { ul, relationships: rows };
  });

  // GET /api/admin/users/:username/blockers — who built a wall AROUND this
  // account, and why. The reasons live on the BLOCKER's doc (privacy), so
  // this is the reverse scan: Mongo's array-contains match on `blocked`
  // finds every doc naming this ul in one indexed query.
  app.get('/api/admin/users/:username/blockers', async (request, reply) => {
    const ul = request.params.username.toLowerCase();
    const me = await users.findOne({ ul }, { projection: { _id: 1 } });
    if (!me) return fail(reply, 'unknown_account', 'No such user', 404);
    const docs = await users
      .find({ blocked: ul }, { projection: { ul: 1, blockReasons: 1, premium: 1 } })
      .toArray();
    const rows = docs.map((d) => ({
      ul: d.ul,
      premium: d.premium === true,
      reason: d.blockReasons?.[ul]?.r ?? null,
      at: d.blockReasons?.[ul]?.at ?? null,
    }));
    // newest walls first (a fresh scam block is the interesting one);
    // no-time rows sink alphabetically
    rows.sort((a, b) => (b.at ? new Date(b.at).getTime() : 0) - (a.at ? new Date(a.at).getTime() : 0)
      || a.ul.localeCompare(b.ul));
    return { ul, blockers: rows };
  });

  // GET /api/admin/users/:username/id-doc — the photo itself (admin-only,
  // token-gated + loopback-bound surface).
  app.get('/api/admin/users/:username/id-doc', async (request, reply) => {
    const ul = request.params.username.toLowerCase();
    const doc = await idDocs.findOne({ ul });
    if (!doc?.data) return fail(reply, 'no_id_doc', 'No ID document for this user', 404);
    return reply.type(doc.contentType ?? 'image/jpeg').send(Buffer.from(doc.data.buffer ?? doc.data));
  });

  // GET /api/admin/users/:username/avatar — the profile photo (admin-only)
  app.get('/api/admin/users/:username/avatar', async (request, reply) => {
    const ul = request.params.username.toLowerCase();
    const doc = await profiles.findOne({ ul });
    if (!doc?.avatar) return fail(reply, 'no_avatar', 'No profile photo for this user', 404);
    return reply.type(doc.avatarType ?? 'image/jpeg').send(Buffer.from(doc.avatar.buffer ?? doc.avatar));
  });

  // DELETE /api/admin/users/:username/id-doc — purge the photo once the
  // review is done (verification state itself is kept).
  app.delete('/api/admin/users/:username/id-doc', async (request, reply) => {
    const ul = request.params.username.toLowerCase();
    const { deletedCount } = await idDocs.deleteOne({ ul });
    if (!deletedCount) return fail(reply, 'no_id_doc', 'No ID document for this user', 404);
    return { deleted: true };
  });

  // PATCH /api/admin/users/:username/max-devices {maxDevices:int|null} —
  // the admin OVERRIDE that beats the premium/verified/unverified policy
  // tiers; null clears it back to policy (lib/devicePolicy.js).
  app.patch('/api/admin/users/:username/max-devices', async (request, reply) => {
    const ul = request.params.username.toLowerCase();
    const { maxDevices } = request.body ?? {};
    if (maxDevices === null) {
      const cleared = await users.updateOne({ ul }, { $unset: { maxDevicesOverride: '' } });
      if (!cleared.matchedCount) return fail(reply, 'unknown_account', 'No such user', 404);
      return { ul, maxDevicesOverride: null };
    }
    if (!Number.isInteger(maxDevices) || maxDevices < 1 || maxDevices > MAX_DEVICES_CAP) {
      return fail(reply, 'invalid_request', `maxDevices must be a whole number between 1 and ${MAX_DEVICES_CAP}, or null for policy`, 400);
    }
    const res = await users.updateOne({ ul }, { $set: { maxDevicesOverride: maxDevices } });
    if (!res.matchedCount) return fail(reply, 'unknown_account', 'No such user', 404);
    return { ul, maxDevicesOverride: maxDevices };
  });

  app.delete('/api/admin/users/:username', async (request, reply) => {
    const ul = request.params.username.toLowerCase();
    const existing = await users.findOne({ ul }, { projection: { _id: 1 } });
    if (!existing) return fail(reply, 'unknown_account', 'No such user', 404);
    // THE full teardown (friends refs + OTHERS' blocked/blockReasons walls,
    // diagnostics, photos, messages, redis) — one helper, no per-path gaps
    await deleteAccountFully({ users, profiles, idDocs, messages, diagnostics, settings, redis }, ul);
    return { deleted: ul };
  });

  // H4 note: no explicit revocation needed here — the main app's bearer hook
  // re-checks the device registry on every request, so the removed device's
  // JWT stops working immediately.
  app.delete('/api/admin/users/:username/devices/:deviceId', async (request, reply) => {
    const ul = request.params.username.toLowerCase();
    const { deviceId } = request.params;

    const user = await users.findOne({ ul });
    if (!user) return fail(reply, 'unknown_account', 'No such user', 404);
    if (!user.devices.some((dev) => dev.id === deviceId)) {
      return fail(reply, 'unknown_device', 'No such device on this account', 404);
    }
    await users.updateOne({ ul }, { $pull: { devices: { id: deviceId } } });
    if (messages) await messages.deleteMany({ 'to.ul': ul, 'to.dv': deviceId });
    const after = await users.findOne({ ul }, { projection: { devices: 1 } });
    // Removing the LAST device deletes the account outright (no orphans, no
    // reserved usernames). Bearer tokens need no explicit revocation — the
    // hook re-checks membership and the account is gone.
    if (after.devices.length === 0) {
      await deleteAccountFully({ users, profiles, idDocs, messages, diagnostics, settings, redis }, ul);
      return { removed: deviceId, devices: 0, accountDeleted: true };
    }
    return { removed: deviceId, devices: after.devices.length };
  });
}
