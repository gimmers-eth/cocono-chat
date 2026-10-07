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
  await admin.register(adminRoutes, {
    users: ctx.mongo.db.collection('users'),
    redis: ctx.redis,
    config,
    diagnostics: ctx.mongo.db.collection('diagnostics'),
    settings: ctx.mongo.db.collection('settings'),
    messages: ctx.mongo.db.collection('messages'),
    idDocs: ctx.mongo.db.collection('id_docs'),
    profiles: ctx.mongo.db.collection('profiles'),
  });

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

test('admin device removal cascades: detaching the last device deletes the account', async () => {
  const { admin, users, teardown } = await setupAdmin();
  try {
    const res = await admin.inject({
      method: 'DELETE',
      url: '/api/admin/users/alice/devices/device-one-123',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.devices, 0);
    assert.equal(body.accountDeleted, true);
    // No orphan rows are kept: the account doc is gone and the username frees up.
    assert.equal(await users.findOne({ ul: 'alice' }), null);
  } finally {
    await teardown();
  }
});

test('branding: admin GET reflects default, PATCH overrides and resets', async () => {
  const { admin, teardown } = await setupAdmin();
  try {
    const g0 = await admin.inject({ method: 'GET', url: '/api/admin/branding' });
    assert.equal(g0.statusCode, 200);
    assert.equal(g0.json().appName, null);
    assert.equal(g0.json().defaultName, config.appName);

    const p = await admin.inject({
      method: 'PATCH', url: '/api/admin/branding', payload: { appName: '  My Chat  ' },
    });
    assert.equal(p.statusCode, 200);
    assert.equal(p.json().appName, 'My Chat');

    const g1 = await admin.inject({ method: 'GET', url: '/api/admin/branding' });
    assert.equal(g1.json().appName, 'My Chat');

    // Rejected: oversized / control chars / empty-ish.
    for (const bad of [{ appName: 'x'.repeat(41) }, { appName: 'a\u0000b' }, { appName: '.' }]) {
      const r = await admin.inject({ method: 'PATCH', url: '/api/admin/branding', payload: bad });
      assert.equal(r.statusCode, 400, JSON.stringify(bad));
      assert.equal(r.json().error, 'invalid_name');
    }

    // Reset to the env default.
    const reset = await admin.inject({ method: 'PATCH', url: '/api/admin/branding', payload: { appName: '' } });
    assert.equal(reset.statusCode, 200);
    assert.equal(reset.json().appName, null);
    const g2 = await admin.inject({ method: 'GET', url: '/api/admin/branding' });
    assert.equal(g2.json().appName, null);
  } finally {
    await teardown();
  }
});
