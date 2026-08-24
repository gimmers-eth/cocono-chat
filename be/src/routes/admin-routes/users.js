import { fail } from '../shared.js';

// GET /api/admin/users, DELETE user, DELETE device.
export default async function usersRoutes(app, { users }) {
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

  app.delete('/api/admin/users/:username', async (request, reply) => {
    const ul = request.params.username.toLowerCase();
    const { deletedCount } = await users.deleteOne({ ul });
    if (!deletedCount) {
      return fail(reply, 'unknown_account', 'No such user', 404);
    }
    return { deleted: ul };
  });

  app.delete('/api/admin/users/:username/devices/:deviceId', async (request, reply) => {
    const ul = request.params.username.toLowerCase();
    const { deviceId } = request.params;

    const user = await users.findOne({ ul });
    if (!user) return fail(reply, 'unknown_account', 'No such user', 404);
    if (!user.devices.some((dev) => dev.id === deviceId)) {
      return fail(reply, 'unknown_device', 'No such device on this account', 404);
    }
    if (user.devices.length <= 1) {
      return fail(reply, 'last_device', 'Cannot remove the only device — delete the user instead', 400);
    }

    await users.updateOne({ ul }, { $pull: { devices: { id: deviceId } } });
    return { removed: deviceId };
  });
}
