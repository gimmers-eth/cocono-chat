import { fail } from '../shared.js';

// L9 fix: removing an account should also sweep its Redis state (login
// nonces, pending/approved enrollments, per-account rate-limit counters)
// instead of leaving it to TTL expiry.
async function cleanupAccountState(redis, ul) {
  await redis.del(`rl:verify:${ul}`, `rl:dapprove:${ul}`, `rl:dpending:${ul}`);

  for await (const batch of redis.scanIterator({ MATCH: `denroll:c:${ul}:*`, COUNT: 100 })) {
    for (const key of batch) {
      const raw = await redis.getDel(key);
      try {
        const { enrollId } = JSON.parse(raw);
        await redis.del(`denroll:p:${enrollId}`, `denroll:ok:${enrollId}`);
      } catch {
        // Not a enrollment record — ignore.
      }
    }
  }

  // Login nonces are keyed by the nonce itself; inspect the bound account.
  for await (const batch of redis.scanIterator({ MATCH: 'auth:nonce:*', COUNT: 100 })) {
    for (const key of batch) {
      try {
        const bound = JSON.parse(await redis.get(key));
        if (bound?.ul === ul) await redis.del(key);
      } catch {
        // ignore
      }
    }
  }
}

// GET /api/admin/users, DELETE user, DELETE device.
export default async function usersRoutes(app, { users, redis }) {
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
    await cleanupAccountState(redis, ul);
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
    if (user.devices.length <= 1) {
      return fail(reply, 'last_device', 'Cannot remove the only device — delete the user instead', 400);
    }

    await users.updateOne({ ul }, { $pull: { devices: { id: deviceId } } });
    return { removed: deviceId };
  });
}
