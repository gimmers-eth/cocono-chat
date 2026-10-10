import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { setupApp } from './helpers.js';
import { config } from '../src/config.js';
import adminRoutes from '../src/routes/admin-routes/index.js';

async function setupAdmin() {
  const ctx = await setupApp();
  const admin = Fastify({ logger: false });
  await admin.register(adminRoutes, {
    users: ctx.mongo.db.collection('users'),
    redis: ctx.redis,
    config,
    diagnostics: ctx.mongo.db.collection('diagnostics'),
    reports: ctx.mongo.db.collection('reports'),
    settings: ctx.mongo.db.collection('settings'),
    messages: ctx.mongo.db.collection('messages'),
    idDocs: ctx.mongo.db.collection('id_docs'),
    profiles: ctx.mongo.db.collection('profiles'),
  });
  return {
    admin,
    redis: ctx.redis,
    mongo: ctx.mongo,
    async teardown() { await admin.close(); await ctx.teardown(); },
  };
}

// The 'Clear limits for IP' button must sweep EVERY IP-scoped limiter by
// scanning, including the diagnostics one that the old fixed allowlist
// silently missed, while leaving account-scoped counters alone.
test('admin clear-by-ip sweeps the diagnostics limiter too', async () => {
  const { admin: app, redis, teardown } = await setupAdmin();
  const IP = '192.0.2.44';
  try {
    await redis.incr(`rl:diag:${IP}`);
    await redis.expire(`rl:diag:${IP}`, 900);
    await redis.incr(`rl:signup:${IP}`);
    await redis.incr(`rl:admindiag:list:${IP}`);
    await redis.incr(`rl:diagacct:someuser`); // account-scoped: must survive

    const listed = (await app.inject({ method: 'GET', url: '/api/admin/rate-limits' })).json();
    assert.ok(listed.find((e) => e.key === `rl:diag:${IP}`), 'diag limiter listed');
    assert.ok(listed.find((e) => e.key === `rl:diagacct:someuser`), 'diagacct listed as account');

    const res = await app.inject({
      method: 'POST', url: '/api/admin/rate-limits/clear', payload: { ip: IP },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().cleared, 3);
    assert.equal(await redis.exists(`rl:diag:${IP}`, `rl:signup:${IP}`, `rl:admindiag:list:${IP}`), 0);
    assert.equal(await redis.exists('rl:diagacct:someuser'), 1);
  } finally {
    await teardown();
  }
});

// The traffic page searches instead of listing the world: comma-separated
// subjects, server-side SCANs, effective metadata — and an empty subject
// list must never fall back to a full sweep.
test('admin rate-limit search is subject-scoped', async () => {
  const { admin: app, redis, teardown } = await setupAdmin();
  try {
    await redis.set('rl:diag:203.0.113.5', 7, { EX: 300 });
    await redis.set('rl:signup:203.0.113.5', 2, { EX: 300 });
    await redis.set('rl:admindiag:list:203.0.113.5', 1, { EX: 300 });
    await redis.set('rl:diagacct:bob', 1, { EX: 300 });
    await redis.set('rl:fvday:bob', 2, { EX: 86400 });
    await redis.set('rl:diag:198.51.100.9', 1, { EX: 300 }); // someone else's

    const res = await app.inject({
      method: 'GET', url: '/api/admin/rate-limits?subjects=' + encodeURIComponent('203.0.113.5, bob'),
    });
    assert.equal(res.statusCode, 200);
    const keys = res.json().map((e) => e.key).sort();
    assert.deepEqual(keys, [
      'rl:admindiag:list:203.0.113.5', 'rl:diag:203.0.113.5',
      'rl:diagacct:bob', 'rl:fvday:bob', 'rl:signup:203.0.113.5',
    ], 'exactly the searched subjects (+their admindiag keys), nothing else');

    const fv = res.json().find((e) => e.key === 'rl:fvday:bob');
    assert.equal(fv.limit, 4, 'effective budget limit surfaced');
    assert.equal(fv.scope, 'account');
    const ad = res.json().find((e) => e.key === 'rl:admindiag:list:203.0.113.5');
    assert.equal(ad.name, 'admindiag-list', 'two-segment keys parsed under their meta name');

    const blank = await app.inject({ method: 'GET', url: '/api/admin/rate-limits?subjects=%20,%20' });
    assert.deepEqual(blank.json(), [], 'empty subject list never sweeps');
    const none = await app.inject({ method: 'GET', url: '/api/admin/rate-limits?subjects=nobody' });
    assert.deepEqual(none.json(), []);
  } finally {
    await teardown();
  }
});

test('admin users list: ips = latest egress IP per device, devices carry lastIp', async () => {
  const { admin: app, mongo, teardown } = await setupAdmin();
  try {
    await mongo.db.collection('users').insertOne({
      ul: 'zed', u: 'zed', maxDevices: 3, createdAt: new Date(),
      devices: [
        { id: 'device-one-000001', lastIp: '203.0.113.10' },
        { id: 'device-two-000002' },
        { id: 'device-three-00003', lastIp: '203.0.113.11' },
      ],
    });
    const users = (await app.inject({ method: 'GET', url: '/api/admin/users' })).json();
    const zed = users.find((u) => u.ul === 'zed');
    assert.deepEqual(zed.ips, ['203.0.113.10', '203.0.113.11'], 'one per device, latest only');
    assert.equal(zed.devices.find((d) => d.id === 'device-one-000001').lastIp, '203.0.113.10');
    assert.equal(zed.devices.find((d) => d.id === 'device-two-000002').lastIp, null);
  } finally {
    await teardown();
  }
});

test('admin users list carries live ipflap state per device', async () => {
  const { admin: app, redis, mongo, teardown } = await setupAdmin();
  try {
    await mongo.db.collection('users').insertOne({
      ul: 'flapzy', u: 'flapzy', maxDevices: 3, createdAt: new Date(),
      devices: [{ id: 'flap-device-00001', lastIp: '203.0.113.200' }],
    });
    await redis.set('rl:ipflap:flapzy:flap-device-00001', '7');
    await redis.expire('rl:ipflap:flapzy:flap-device-00001', 180);
    const users = (await app.inject({ method: 'GET', url: '/api/admin/users' })).json();
    const dev = users.find((u) => u.ul === 'flapzy').devices[0];
    assert.equal(dev.flap.count, 7);
    assert.equal(dev.flap.limit, config.deviceIpFlapLimit); // shipped default 20
    assert.ok(dev.flap.ttlSec > 0 && dev.flap.ttlSec <= 180);
    assert.equal(dev.flap.override, false);
  } finally {
    await teardown();
  }
});
