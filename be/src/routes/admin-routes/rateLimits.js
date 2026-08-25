import { fail } from '../shared.js';

// Keyed by the middle segment of the Redis rate-limit keys (rl:<name>:<subject>).
const LIMIT_META = {
  signup: (config) => ({ limit: config.signupIpLimit, windowSec: config.signupIpWindowSec, scope: 'ip' }),
  challenge: (config) => ({ limit: config.challengeIpLimit, windowSec: config.challengeIpWindowSec, scope: 'ip' }),
  verify: (config) => ({ limit: config.verifyAccountLimit, windowSec: config.verifyAccountWindowSec, scope: 'account' }),
  verifyip: (config) => ({ limit: config.verifyIpLimit, windowSec: config.verifyIpWindowSec, scope: 'ip' }),
  denroll: (config) => ({ limit: config.deviceEnrollIpLimit, windowSec: config.deviceEnrollIpWindowSec, scope: 'ip' }),
  dapprove: (config) => ({ limit: config.deviceApproveAccountLimit, windowSec: config.deviceApproveAccountWindowSec, scope: 'account' }),
  dpending: (config) => ({ limit: config.deviceApproveAccountLimit, windowSec: config.deviceApproveAccountWindowSec, scope: 'account' }),
  denrollstatus: (config) => ({ limit: config.enrollStatusIpLimit, windowSec: config.enrollStatusIpWindowSec, scope: 'ip' }),
  admintoken: () => ({ limit: 10, windowSec: 15 * 60, scope: 'ip' }),
};

// Every IP-scoped counter cleared by POST /api/admin/rate-limits/clear { ip }.
const IP_SCOPED = ['signup', 'challenge', 'verifyip', 'denroll', 'denrollstatus', 'admintoken'];

// GET /api/admin/rate-limits, POST /api/admin/rate-limits/clear.
export default async function rateLimitsRoutes(app, { redis, config }) {
  app.get('/api/admin/rate-limits', async () => {
    const entries = [];
    // redis v5's scanIterator yields batches of keys, not single keys.
    for await (const batch of redis.scanIterator({ MATCH: 'rl:*', COUNT: 100 })) {
      for (const key of batch) {
        const [, name, ...rest] = key.split(':');
        const metaFor = LIMIT_META[name];
        if (!metaFor) continue;
        const meta = metaFor(config);
        const [count, ttlSec] = await Promise.all([redis.get(key), redis.ttl(key)]);
        entries.push({
          key,
          name,
          scope: meta.scope,
          subject: rest.join(':'),
          count: Number(count ?? 0),
          limit: meta.limit,
          windowSec: meta.windowSec,
          ttlSec,
        });
      }
    }
    entries.sort((a, b) => a.key.localeCompare(b.key));
    return entries;
  });

  // Body: { ip } clears every IP-scoped limit for that IP,
  //       { key } clears one exact rl:* key.
  app.post('/api/admin/rate-limits/clear', async (request, reply) => {
    const { ip, key } = request.body ?? {};
    if (typeof key === 'string' && key.startsWith('rl:')) {
      return { cleared: await redis.del(key) };
    }
    if (typeof ip === 'string' && ip.length > 0) {
      const cleared = await redis.del(...IP_SCOPED.map((name) => `rl:${name}:${ip}`));
      return { cleared };
    }
    return fail(reply, 'invalid_request', 'Provide { ip } or { key }', 400);
  });
}
