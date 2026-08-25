import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { setupApp } from './helpers.js';
import { config } from '../src/config.js';
import adminRoutes from '../src/routes/admin-routes/index.js';

// Admin routes are registered by admin.js in production (with the token gate);
// here they are mounted on a bare app over the same stores to test the
// handlers directly.
async function setupAdmin() {
  const ctx = await setupApp();
  const admin = Fastify({ logger: false });
  await admin.register(adminRoutes, { users: ctx.mongo.db.collection('users'), redis: ctx.redis, config });

  const now = new Date();
  await ctx.mongo.db.collection('users').insertOne({
    u: 'Alice',
    ul: 'alice',
    devices: [{ id: 'device-one-123', pub: 'x', aes: 'x', main: true, createdAt: now, lastSeenAt: now }],
    maxDevices: 3,
    createdAt: now,
  });

  return {
    admin,
    users: ctx.mongo.db.collection('users'),
    async teardown() {
      await admin.close();
      await ctx.teardown();
    },
  };
}

test('PATCH max-devices updates the account cap', async () => {
  const { admin, users, teardown } = await setupAdmin();
  try {
    const res = await admin.inject({
      method: 'PATCH',
      url: '/api/admin/users/alice/max-devices',
      payload: { maxDevices: 7 },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ul: 'alice', maxDevices: 7 });

    const doc = await users.findOne({ ul: 'alice' });
    assert.equal(doc.maxDevices, 7);

    // The users listing reflects the new cap.
    const list = await admin.inject({ method: 'GET', url: '/api/admin/users' });
    assert.equal(list.json().find((u) => u.ul === 'alice').maxDevices, 7);
  } finally {
    await teardown();
  }
});

test('PATCH max-devices is case-insensitive on the username', async () => {
  const { admin, users, teardown } = await setupAdmin();
  try {
    const res = await admin.inject({
      method: 'PATCH',
      url: '/api/admin/users/ALICE/max-devices',
      payload: { maxDevices: 5 },
    });
    assert.equal(res.statusCode, 200);
    assert.equal((await users.findOne({ ul: 'alice' })).maxDevices, 5);
  } finally {
    await teardown();
  }
});

test('PATCH max-devices rejects invalid values', async () => {
  const { admin, users, teardown } = await setupAdmin();
  try {
    for (const bad of [0, -1, 2.5, 1001, 'abc', null]) {
      const res = await admin.inject({
        method: 'PATCH',
        url: '/api/admin/users/alice/max-devices',
        payload: { maxDevices: bad },
      });
      assert.equal(res.statusCode, 400, `maxDevices=${JSON.stringify(bad)} should be rejected`);
    }
    const missing = await admin.inject({
      method: 'PATCH',
      url: '/api/admin/users/alice/max-devices',
      payload: {},
    });
    assert.equal(missing.statusCode, 400);

    // Nothing changed.
    assert.equal((await users.findOne({ ul: 'alice' })).maxDevices, 3);
  } finally {
    await teardown();
  }
});

test('PATCH max-devices on an unknown account returns 404', async () => {
  const { admin, teardown } = await setupAdmin();
  try {
    const res = await admin.inject({
      method: 'PATCH',
      url: '/api/admin/users/ghost/max-devices',
      payload: { maxDevices: 5 },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'unknown_account');
  } finally {
    await teardown();
  }
});

test('device removal guard still refuses the last device', async () => {
  const { admin, teardown } = await setupAdmin();
  try {
    const res = await admin.inject({
      method: 'DELETE',
      url: '/api/admin/users/alice/devices/device-one-123',
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'last_device');
  } finally {
    await teardown();
  }
});
