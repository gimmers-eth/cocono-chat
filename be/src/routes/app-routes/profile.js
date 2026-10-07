import { fail, requireAuth, limited } from '../shared.js';
import { rateLimit } from '../../lib/rateLimit.js';
import { USERNAME_RE } from '../../lib/username.js';

// Profiles: a short bio (≤ PROFILE_BIO_MAX_LEN) + a tiny avatar
// (≤ PROFILE_AVATAR_MAX_BYTES, JPEG only — clients resize on-canvas before
// upload; the server still checks magic bytes AND size).
//
// Privacy rule (the whole point): a target's avatar is delivered ONLY when
// viewer and target have MUTUALLY added each other — or the viewer is the
// owner. Unfriending in either direction therefore makes the photo vanish
// with no cleanup jobs: it is a read-time property, not stored copies.
export default async function profileRoutes(app, { users, redis, config, profiles }) {
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
    return {
      u: request.auth.sub,
      bio: me?.bio ?? '',
      updatedAt: me?.updatedAt ?? null,
      // owner always sees their own photo
      avatar: me?.avatar ? me.avatar.toString('base64') : null,
    };
  });

  app.put('/api/me/profile', async (request, reply) => {
    const denied = requireAuth(request, reply);
    if (denied) return denied;
    const ul = request.auth.sub;
    const rl = await rateLimit(redis, `rl:profile:${ul}`, config.profileEditAccountLimit, config.profileEditWindowSec);
    if (!rl.ok) return limited(reply, rl);

    const { bio, avatar, clearAvatar } = request.body ?? {};
    const set = {};
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
    if (!Object.keys(set).length) return fail(reply, 'invalid_request', 'nothing to update', 400);

    await profiles.updateOne({ ul }, { $set: { ...set, ul, updatedAt: new Date() } }, { upsert: true });
    return { updated: true, bio: set.bio };
  });

  // --- viewing someone else: bio public, avatar only on mutual add ---
  app.get('/api/users/:username/profile', async (request, reply) => {
    const denied = requireAuth(request, reply);
    if (denied) return denied;
    const viewer = request.auth.sub;
    const rl = await rateLimit(redis, `rl:profileip:${request.ip}`, config.userKeysIpLimit, config.userKeysIpWindowSec);
    if (!rl.ok) return limited(reply, rl);
    const username = request.params.username;
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
      return fail(reply, 'invalid_username', 'Malformed username', 400);
    }
    const ul = username.toLowerCase();
    const targetDoc = await users.findOne({ ul }, { projection: { _id: 1 } });
    if (!targetDoc) return fail(reply, 'unknown_account', 'No such user', 404);

    const [prof, viewerDoc, targetUserDoc] = await Promise.all([
      profiles.findOne({ ul }, { projection: { _id: 0, bio: 1, avatar: 1, avatarType: 1 } }),
      users.findOne({ ul: viewer }, { projection: { friends: 1 } }),
      ul === viewer ? null : users.findOne({ ul }, { projection: { friends: 1 } }),
    ]);
    const mutual = ul === viewer || (hasAdded(viewerDoc, ul) && hasAdded(targetUserDoc, viewer));

    return {
      u: ul,
      bio: prof?.bio ?? '',
      // non-mutual viewers get no photo AT ALL (not even a "hidden" flag
      // value — presence of a private photo shouldn't be observable beyond
      // the fact you are not connected yet)
      avatar: mutual && prof?.avatar ? prof.avatar.toString('base64') : null,
      avatarType: mutual && prof?.avatar ? (prof.avatarType ?? 'image/jpeg') : null,
    };
  });
}
