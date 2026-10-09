import test from 'node:test';
import assert from 'node:assert/strict';
import { setupApp } from './helpers.js';
import { config } from '../src/config.js';
import limitsAdmin from '../src/routes/admin-routes/limits.js';
import rateLimitsAdmin from '../src/routes/admin-routes/rateLimits.js';
import { effectiveLimit, LIMIT_CATALOG } from '../src/lib/limits.js';

// The limit-tuning subsystem: IP defaults doubled on a 5-min window, the
// admin catalog exposes every limiter, overrides layer user > app > default,
// and the per-account verify/trust BUDGETS (fvday/fvweek/ftday/ftweek)
// are enforced exactly like any other limiter.
test('limits: config defaults — IP limiters doubled with 300s windows', () => {
  assert.equal(config.signupIpLimit, 20);
  assert.equal(config.signupIpWindowSec, 300);
  assert.equal(config.msgIpLimit, 480);
  assert.equal(config.msgIpWindowSec, 300);
  // account-scoped message send: same 300s window (per-account limit 120)
  assert.equal(config.msgAccountLimit, 120);
  // login-verify budget doubled 20 → 40 (devbox NAT/household churn)
  assert.equal(config.verifyAccountLimit, 40);
  assert.equal(config.msgAccountWindowSec, 300);
  assert.equal(config.userKeysIpLimit, 120);
  // account budgets: 4/day, 10/week verify AND trust
  assert.equal(config.friendVerifyDailyLimit, 4);
  assert.equal(config.friendVerifyWeeklyLimit, 10);
  assert.equal(config.friendTrustDailyLimit, 4);
  assert.equal(config.friendTrustWeeklyLimit, 10);
  // catalog covers every budget name and marks them account-scoped
  for (const n of ['fvday', 'fvweek', 'ftday', 'ftweek']) {
    assert.ok(LIMIT_CATALOG[n], `${n} catalogued`);
    assert.equal(LIMIT_CATALOG[n].ip, false, `${n} is account-scoped`);
  }
});

test('limits: admin overrides layer app-wide then per-user; reads follow', async () => {
  const ctx = await setupApp({
    // generous IP guards so the flow below isn't tripped by them
    friendsIpLimit: 1000, friendsChangeIpLimit: 1000,
  });
  const { app, mongo, redis } = ctx;
  await app.register(limitsAdmin, { config, settings: mongo.db.collection('settings') });
  await app.register(rateLimitsAdmin, { redis, config, settings: mongo.db.collection('settings') });
  try {
    const settings = mongo.db.collection('settings');

    // GET returns the whole catalog with defaults + effective
    const list = (await app.inject({ method: 'GET', url: '/api/admin/limits' })).json();
    assert.ok(list.limiters.find((l) => l.name === 'fvday'));

    // effective (no overrides) == default
    assert.deepEqual(
      await effectiveLimit(settings, config, 'fvday', 'someone'),
      { limit: 4, windowSec: config.friendVerifyDailyWindowSec },
    );

    // set an APP-WIDE override; it must beat the default
    const appSet = await app.inject({
      method: 'PATCH', url: '/api/admin/limits',
      payload: { name: 'fvday', value: { limit: 2 } },
    });
    assert.equal(appSet.statusCode, 200);
    assert.equal(appSet.json().effective.limit, 2);
    assert.deepEqual(
      await effectiveLimit(settings, config, 'fvday', 'someone'),
      { limit: 2, windowSec: config.friendVerifyDailyWindowSec },
    );

    // per-user override for 'alice' must beat the app-wide one
    const userSet = await app.inject({
      method: 'PATCH', url: '/api/admin/limits',
      payload: { name: 'fvday', user: 'alice', value: { limit: 5 } },
    });
    assert.equal(userSet.json().effective.limit, 5);
    assert.equal((await effectiveLimit(settings, config, 'fvday', 'alice')).limit, 5);
    // …but a different user still sees the app-wide 2
    assert.equal((await effectiveLimit(settings, config, 'fvday', 'bob')).limit, 2);

    // clearing the per-user layer falls back to app-wide (2)
    await app.inject({
      method: 'PATCH', url: '/api/admin/limits',
      payload: { name: 'fvday', user: 'alice', value: null },
    });
    assert.equal((await effectiveLimit(settings, config, 'fvday', 'alice')).limit, 2);

    // IP-scoped limiter rejects a per-user edit (subject is an address)
    const bad = await app.inject({
      method: 'PATCH', url: '/api/admin/limits',
      payload: { name: 'signup', user: 'alice', value: { limit: 1 } },
    });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error, 'ip_scoped');

    // unknown limiter + bad value rejected too
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/admin/limits',
      payload: { name: 'nope', value: { limit: 1 } } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/admin/limits',
      payload: { name: 'fvday', value: { limit: 0 } } })).statusCode, 400);

    // the live-counter view knows the new budget keys and shows the
    // EFFECTIVE (overridden) limit for them
    await redis.set('rl:fvday:alice', 1, { EX: 60 });
    const rl = (await app.inject({ method: 'GET', url: '/api/admin/rate-limits' })).json();
    const entry = rl.find((e) => e.key === 'rl:fvday:alice');
    assert.ok(entry, 'fvday surfaced in rate-limits view');
    assert.equal(entry.limit, 2); // app-wide override (alice's user layer cleared)
    assert.equal(entry.scope, 'account');
  } finally {
    await ctx.teardown();
  }
});

test('limits: enforcement honours the admin override on a real route (challenge)', async () => {
  const ctx = await setupApp({ challengeIpLimit: 100 });
  const { app, mongo } = ctx;
  await app.register(limitsAdmin, { config, settings: mongo.db.collection('settings') });
  try {
    // drop the per-IP challenge budget to 1 via the admin panel
    await app.inject({
      method: 'PATCH', url: '/api/admin/limits',
      payload: { name: 'challenge', value: { limit: 1 } },
    });
    // rate-limit runs BEFORE payload validation on this route
    const first = await app.inject({
      method: 'POST', url: '/api/auth/challenge', payload: { u: 'nobody' },
    });
    assert.notEqual(first.statusCode, 429);
    const second = await app.inject({
      method: 'POST', url: '/api/auth/challenge', payload: { u: 'nobody' },
    });
    assert.equal(second.statusCode, 429);
    assert.equal(second.json().error, 'rate_limited');

    // raising it back clears the way (override reset → default 100)
    await app.inject({
      method: 'PATCH', url: '/api/admin/limits',
      payload: { name: 'challenge', value: null },
    });
    const third = await app.inject({
      method: 'POST', url: '/api/auth/challenge', payload: { u: 'nobody' },
    });
    assert.notEqual(third.statusCode, 429);
  } finally {
    await ctx.teardown();
  }
});

test('kill switch: settings-doc flag disables enforcement app-wide and back', async () => {
  const ctx = await setupApp({ challengeIpLimit: 2 });
  const { app, mongo, redis, teardown } = ctx;
  try {
    // wire both admin endpoints (buildApp already wired the GATE on the app)
    await app.register(limitsAdmin, { config, settings: mongo.db.collection('settings') });
    await app.register(rateLimitsAdmin, { redis, config, settings: mongo.db.collection('settings') });

    const challenge = () => app.inject({
      method: 'POST', url: '/api/auth/challenge', payload: { u: 'nobody' },
    });

    // ON: third hit over the 2-challenge budget is 429
    await redis.del('rl:challenge:127.0.0.1');
    assert.notEqual((await challenge()).statusCode, 429);
    assert.notEqual((await challenge()).statusCode, 429);
    assert.equal((await challenge()).statusCode, 429, 'limits should bite while enabled');

    // OFF via the admin state endpoint — same process, instant
    const off = await app.inject({
      method: 'PUT', url: '/api/admin/rate-limits/state', payload: { disabled: true },
    });
    assert.equal(off.json().rateLimitsDisabled, true);
    assert.notEqual((await challenge()).statusCode, 429, 'kill switch off: no 429s');

    // the limits GET reports the state for the admin UI
    const cfg = (await app.inject({ method: 'GET', url: '/api/admin/limits' })).json();
    assert.equal(cfg.rateLimitsDisabled, true);

    // back ON
    await app.inject({
      method: 'PUT', url: '/api/admin/rate-limits/state', payload: { disabled: false },
    });
    await redis.del('rl:challenge:127.0.0.1');
    await challenge(); await challenge();
    assert.equal((await challenge()).statusCode, 429, 'limits bite again');
  } finally {
    await teardown();
  }
});

test('ipflap limiter: catalogued, tunable app-wide and per device', async () => {
  const ctx = await setupApp();
  const { app, mongo, teardown } = ctx;
  const settings = mongo.db.collection('settings');
  await app.register(limitsAdmin, { config, settings });
  try {
    // appears in the catalog rows, flagged device-scoped, default 20/300
    const cfg = (await app.inject({ method: 'GET', url: '/api/admin/limits' })).json();
    const row = cfg.limiters.find((l) => l.name === 'ipflap');
    assert.ok(row, 'ipflap is tunable via the admin catalog');
    assert.equal(row.device, true);
    assert.equal(row.defaultLimit, 20);
    assert.equal(row.defaultWindowSec, 300);

    // app-wide override applies to every device subject
    await app.inject({
      method: 'PATCH', url: '/api/admin/limits',
      payload: { name: 'ipflap', value: { limit: 1 } },
    });
    assert.equal((await effectiveLimit(settings, config, 'ipflap', 'alice:dev-one-000001')).limit, 1);

    // a per-DEVICE override (subject 'user:deviceId') beats the app-wide one
    const devSet = await app.inject({
      method: 'PATCH', url: '/api/admin/limits',
      payload: { name: 'ipflap', user: 'alice:dev-one-000001', value: { limit: 9 } },
    });
    assert.equal(devSet.statusCode, 200);
    assert.equal(devSet.json().effective.limit, 9);
    assert.equal((await effectiveLimit(settings, config, 'ipflap', 'alice:dev-two-000002')).limit, 1);

    // clearing the device layer falls back to app-wide (1)
    await app.inject({
      method: 'PATCH', url: '/api/admin/limits',
      payload: { name: 'ipflap', user: 'alice:dev-one-000001', value: null },
    });
    assert.equal((await effectiveLimit(settings, config, 'ipflap', 'alice:dev-one-000001')).limit, 1);

    // malformed subjects rejected
    const bad = await app.inject({
      method: 'PATCH', url: '/api/admin/limits',
      payload: { name: 'ipflap', user: 'no spaces allowed!', value: { limit: 3 } },
    });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error, 'bad_username');
  } finally {
    await teardown();
  }
});
