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
    settings: ctx.mongo.db.collection('settings'),
    messages: ctx.mongo.db.collection('messages'),
  });
  return {
    admin,
    redis: ctx.redis,
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
