import { fail } from '../shared.js';
import { cleanupAccountState } from '../../lib/accountState.js';

// Per-account device cap: 1..MAX_DEVICES_CAP. Raising it lets a user enroll
// more devices; lowering it below the current device count is allowed (the
// existing devices keep working, no new ones can be added).
const MAX_DEVICES_CAP = 1000;

// GET /api/admin/users, PATCH max-devices, DELETE user, DELETE device.
export default async function usersRoutes(app, { users, redis, messages }) {
  app.get('/api/admin/users', async () => {
    const docs = await users.find({}, { projection: { _id: 0 } }).sort({ ul: 1 }).toArray();
    return docs.map((doc) => ({
      u: doc.u,
      ul: doc.ul,
      createdAt: doc.createdAt,
      maxDevices: doc.maxDevices,
      devices: (doc.devices ?? []).map((dev) => ({
        id: dev.id,
        main: dev.main ?? false,
        createdAt: dev.createdAt,
        lastSeenAt: dev.lastSeenAt,
      })),
    }));
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
    await cleanupAccountState(redis, ul);
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
      await cleanupAccountState(redis, ul);
      if (messages) await messages.deleteMany({ $or: [{ 'to.ul': ul }, { 'from.ul': ul }] });
      return { removed: deviceId, devices: 0, accountDeleted: true };
    }
    return { removed: deviceId, devices: after.devices.length };
  });
}
