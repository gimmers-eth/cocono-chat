import { fail, requireAuth, limited } from '../shared.js';
import { rateLimit } from '../../lib/rateLimit.js';
import { USERNAME_RE } from '../../lib/username.js';
import { createNotifier } from '../../lib/notify.js';
import { badgesFor, badgeScore, validDisplayBadge, visibleDisplayBadge } from '../../lib/badges.js';
import { effectiveLimit } from '../../lib/limits.js';
import { effectiveVerified, moderationFlags } from '../../lib/moderation.js';

// Profiles: a short bio (≤ PROFILE_BIO_MAX_LEN) + a tiny avatar
// (≤ PROFILE_AVATAR_MAX_BYTES, JPEG only — clients resize on-canvas before
// upload; the server still checks magic bytes AND size).
//
// Privacy rule (the whole point): a target's avatar is delivered ONLY when
// viewer and target have MUTUALLY added each other — or the viewer is the
// owner. Unfriending in either direction therefore makes the photo vanish
// with no cleanup jobs: it is a read-time property, not stored copies.
export default async function profileRoutes(app, { users, redis, config, profiles, settings }) {
  const decodeAvatar = (b64) => {
    if (typeof b64 !== 'string' || !b64.length) return null;
    const buf = Buffer.from(b64.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
    // JPEG SOI required
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    if (buf.length > config.profileAvatarMaxBytes) return 'too_large';
    return buf;
  };

  const hasAdded = (doc, ul) => (doc?.friends ?? []).some(
    (f) => (typeof f === 'string' ? f : f.u) === ul,
  );

  // --- own profile: read + edit ---
  app.get('/api/me/profile', async (request, reply) => {
    const denied = requireAuth(request, reply);
    if (denied) return denied;
    const me = await profiles.findOne({ ul: request.auth.sub }, { projection: { _id: 0, bio: 1, avatar: 1, updatedAt: 1 } });
    const userDoc = await users.findOne({ ul: request.auth.sub }, { projection: { premium: 1, premiumAt: 1, awards: 1, verified: 1, displayBadge: 1 } });
    return {
      u: request.auth.sub,
      bio: me?.bio ?? '',
      badges: badgesFor(userDoc ?? {}),
      displayBadge: userDoc?.displayBadge ?? null,
      updatedAt: me?.updatedAt ?? null,
      // owner always sees their own photo
      avatar: me?.avatar ? me.avatar.toString('base64') : null,
    };
  });

  app.put('/api/me/profile', async (request, reply) => {
    const denied = requireAuth(request, reply);
    if (denied) return denied;
    const ul = request.auth.sub;
    const lim = await effectiveLimit(settings, config, 'profile', ul);
    const rl = await rateLimit(redis, `rl:profile:${ul}`, lim.limit, lim.windowSec);
    if (!rl.ok) return limited(reply, rl);

    const { bio, avatar, clearAvatar } = request.body ?? {};
    const set = {};
    let displayBadgeSet = null; let haveDisplay = false;
    if (bio !== undefined) {
      if (typeof bio !== 'string') return fail(reply, 'invalid_request', 'bio must be a string', 400);
      const trimmed = bio.trim();
      if (trimmed.length > config.profileBioMaxLen) {
        return fail(reply, 'bio_too_long', `Bio is limited to ${config.profileBioMaxLen} characters`, 400);
      }
      set.bio = trimmed;
    }
    if (clearAvatar === true) {
      set.avatar = null;
    } else if (avatar !== undefined) {
      const buf = decodeAvatar(avatar);
      if (buf === null) return fail(reply, 'bad_avatar', 'Avatar must be a valid JPEG', 400);
      if (buf === 'too_large') {
        return fail(reply, 'too_large', `Avatar exceeds ${Math.floor(config.profileAvatarMaxBytes / 1024)} KB — zoom out or crop closer`, 413);
      }
      set.avatar = buf;
      set.avatarType = 'image/jpeg';
    }
    if (request.body?.displayBadge !== undefined) {
      const wanted = request.body.displayBadge;
      if (wanted !== null && (typeof wanted !== 'string' || (wanted !== '' && !/^\w+$/.test(wanted)))) {
        return fail(reply, 'invalid_request', 'displayBadge must be a string or null', 400);
      }
      const owner = await users.findOne({ ul }, { projection: { premium: 1, premiumAt: 1, awards: 1, displayBadge: 1 } });
      if (!validDisplayBadge(owner ?? {}, wanted)) {
        return fail(reply, 'badge_not_held', 'You can only display a badge you have earned', 400);
      }
      displayBadgeSet = wanted === null ? '' : wanted; // '' persists "none"
      haveDisplay = true;
    }
    if (!Object.keys(set).length && !haveDisplay) return fail(reply, 'invalid_request', 'nothing to update', 400);

    if (Object.keys(set).length) {
      await profiles.updateOne({ ul }, { $set: { ...set, ul, updatedAt: new Date() } }, { upsert: true });
    }
    if (haveDisplay) {
      // the name-chip choice lives on the account (badges engine reads it)
      await users.updateOne({ ul }, { $set: { displayBadge: displayBadgeSet } });
    }
    // peers cache bios/avatars (day-ish priming): nudge everyone who added
    // this account so the new photo/bio lands immediately (lib/notify.js)
    await createNotifier({ redis, users }).notifyPeers(ul, 'profile');
    return { updated: true, bio: set.bio, displayBadge: haveDisplay ? displayBadgeSet : undefined };
  });

  // --- viewing someone else: bio public, avatar only on mutual add ---
  app.get('/api/users/:username/profile', async (request, reply) => {
    const denied = requireAuth(request, reply);
    if (denied) return denied;
    const viewer = request.auth.sub;
    const lim = await effectiveLimit(settings, config, 'profileip');
    const rl = await rateLimit(redis, `rl:profileip:${request.ip}`, lim.limit, lim.windowSec);
    if (!rl.ok) return limited(reply, rl);
    const username = request.params.username;
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
      return fail(reply, 'invalid_username', 'Malformed username', 400);
    }
    const ul = username.toLowerCase();
    const targetDoc = await users.findOne({ ul }, { projection: { _id: 1, verified: 1, premium: 1, premiumAt: 1, awards: 1, displayBadge: 1, timeoutUntil: 1, banned: 1 } });
    if (!targetDoc) return fail(reply, 'unknown_account', 'No such user', 404);

    const [prof, viewerDoc, targetUserDoc] = await Promise.all([
      profiles.findOne({ ul }, { projection: { _id: 0, bio: 1, avatar: 1, avatarType: 1 } }),
      users.findOne({ ul: viewer }, { projection: { friends: 1 } }),
      ul === viewer ? null : users.findOne({ ul }, { projection: { friends: 1 } }),
    ]);
    const mutual = ul === viewer || (hasAdded(viewerDoc, ul) && hasAdded(targetUserDoc, viewer));
    // photos require BOTH mutual-add and the target's ID verification —
    // and a staff TIMEOUT withdraws that verification for as long as it
    // runs (the photo was shown under a trust state just revoked)
    const maySeePhoto = ul === viewer || (mutual && effectiveVerified(targetDoc));

    const targetBadges = badgesFor(targetDoc ?? {});
    return {
      u: ul,
      // staff moderation marks (public trust metadata): the profile sheet
      // raises the staff warning / ban notice from these (lib/moderation.js)
      ...moderationFlags(targetDoc),
      // badges are as public as the certificate they replace: name chips and
      // the profile sheet render straight from this
      premium: targetDoc.premium === true,
      badges: targetBadges,
      displayBadge: visibleDisplayBadge(targetDoc),
      bio: prof?.bio ?? '',
      // non-eligible viewers get no photo AT ALL (not even a "hidden" flag —
      // photo presence stays unobservable until trust conditions are met)
      avatar: maySeePhoto && prof?.avatar ? prof.avatar.toString('base64') : null,
      avatarType: maySeePhoto && prof?.avatar ? (prof.avatarType ?? 'image/jpeg') : null,
    };
  });
}
