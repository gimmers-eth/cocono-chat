import { fail } from '../shared.js';
import { cleanupAccountState, purgeFriendReferences } from '../../lib/accountState.js';
import { createNotifier } from '../../lib/notify.js';

// Per-account device cap: 1..MAX_DEVICES_CAP. Raising it lets a user enroll
// more devices; lowering it below the current device count is allowed (the
// existing devices keep working, no new ones can be added).
const MAX_DEVICES_CAP = 1000;

// GET /api/admin/users, PATCH max-devices, DELETE user, DELETE device,
// PUT verified (identity-verification toggle), GET/DELETE id-doc (review).
export default async function usersRoutes(app, { users, redis, messages, idDocs, profiles }) {
  // account-review outcomes are invisible to the reviewed user otherwise —
  // content-free 'identity' nudges (lib/notify.js) make the app re-pull
  const { notify: notifyAccount, notifyPeers } = createNotifier({ redis, users });
  app.get('/api/admin/users', async () => {
    const docs = await users.find({}, { projection: { _id: 0 } }).sort({ ul: 1 }).toArray();
    const metas = await idDocs.find({}, { projection: { ul: 1, contentType: 1, uploadedAt: 1, _id: 0 } }).toArray();
    const byUl = new Map(metas.map((d) => [d.ul, d]));
    const avatars = await profiles.find({}, { projection: { ul: 1, avatar: 1, _id: 0 } }).toArray();
    const hasAvatar = new Set(avatars.filter((a) => a.avatar).map((a) => a.ul));
    return docs.map((doc) => ({
      u: doc.u,
      ul: doc.ul,
      createdAt: doc.createdAt,
      maxDevices: doc.maxDevices,
      verified: !!doc.verified,
      verifiedAt: doc.verifiedAt ?? null,
      idDoc: byUl.get(doc.ul) ?? null,
      hasAvatar: hasAvatar.has(doc.ul),
      devices: (doc.devices ?? []).map((dev) => ({
        id: dev.id,
        createdAt: dev.createdAt,
        lastSeenAt: dev.lastSeenAt,
      })),
    }));
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
    await notifyAccount(ul, 'identity');
    // the avatar vanished from under everyone who follows this account
    if (!verified) await notifyPeers(ul, 'profile');
    return { ul, verified };
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

  app.patch('/api/admin/users/:username/max-devices', async (request, reply) => {
    const ul = request.params.username.toLowerCase();
    const { maxDevices } = request.body ?? {};
    if (!Number.isInteger(maxDevices) || maxDevices < 1 || maxDevices > MAX_DEVICES_CAP) {
      return fail(reply, 'invalid_request', `maxDevices must be a whole number between 1 and ${MAX_DEVICES_CAP}`, 400);
    }
    const res = await users.updateOne({ ul }, { $set: { maxDevices } });
    if (!res.matchedCount) return fail(reply, 'unknown_account', 'No such user', 404);
    return { ul, maxDevices };
  });

  app.delete('/api/admin/users/:username', async (request, reply) => {
    const ul = request.params.username.toLowerCase();
    const { deletedCount } = await users.deleteOne({ ul });
    if (!deletedCount) {
      return fail(reply, 'unknown_account', 'No such user', 404);
    }
    await idDocs.deleteOne({ ul }); // never orphan an ID photo
    await profiles.deleteOne({ ul });
    await cleanupAccountState(redis, ul);
    await purgeFriendReferences(users, ul, redis);
    if (messages) {
      await messages.deleteMany({ $or: [{ 'to.ul': ul }, { 'from.ul': ul }] });
    }
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
      await users.deleteOne({ ul });
      await idDocs.deleteOne({ ul }); // never orphan an ID photo
      await profiles.deleteOne({ ul });
      await cleanupAccountState(redis, ul);
      await purgeFriendReferences(users, ul, redis);
      if (messages) await messages.deleteMany({ $or: [{ 'to.ul': ul }, { 'from.ul': ul }] });
      return { removed: deviceId, devices: 0, accountDeleted: true };
    }
    return { removed: deviceId, devices: after.devices.length };
  });
}
