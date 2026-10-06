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
  dremove: (config) => ({ limit: config.deviceRemoveAccountLimit, windowSec: config.deviceRemoveWindowSec, scope: 'account' }),
  denrollstatus: (config) => ({ limit: config.enrollStatusIpLimit, windowSec: config.enrollStatusIpWindowSec, scope: 'ip' }),
  msg: (config) => ({ limit: config.msgAccountLimit, windowSec: config.msgAccountWindowSec, scope: 'account' }),
  msgip: (config) => ({ limit: config.msgIpLimit, windowSec: config.msgIpWindowSec, scope: 'ip' }),
  userkeys: (config) => ({ limit: config.userKeysIpLimit, windowSec: config.userKeysIpWindowSec, scope: 'ip' }),
  diag: (config) => ({ limit: config.diagIpLimit, windowSec: config.diagIpWindowSec, scope: 'ip' }),
  diagacct: (config) => ({ limit: config.diagAccountLimit, windowSec: config.diagAccountWindowSec, scope: 'account' }),
  appinfo: () => ({ limit: 120, windowSec: 600, scope: 'ip' }),
  'admindiag-list': () => ({ limit: 600, windowSec: 3600, scope: 'ip' }),
  'admindiag-del': () => ({ limit: 200, windowSec: 3600, scope: 'ip' }),
  'admindiag-purge': () => ({ limit: 20, windowSec: 3600, scope: 'ip' }),
  admintoken: () => ({ limit: 10, windowSec: 15 * 60, scope: 'ip' }),
};

/* KEY SHAPE NOTE (keep in sync when adding limiters!):
   rl:<name>:<subject>  =>  subject is an IP for the *_IP_* limiters and a
   username for account-scoped ones. admindiag keys are rl:admindiag:<op>:<ip>
   (two segments). Subjects are IPs (IPv4/IPv6, never ':') or lowercase
   usernames, so the split by ':' is unambiguous for everything except
   admindiag. */
const ACCOUNT_SCOPED = new Set(['verify', 'dapprove', 'dpending', 'dremove', 'msg', 'diagacct']);
const subjectIsIp = (name, subject) => !ACCOUNT_SCOPED.has(name);


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
      // Scan-and-clear: covers EVERY IP-subject limiter, including ones
      // added later — no maintenance of an allowlist (the old fixed list
      // silently missed the diagnostics limiter).
      let cleared = 0;
      for await (const batch of redis.scanIterator({ MATCH: `rl:*:${ip}`, COUNT: 100 })) {
        for (const key of batch) {
          const [, name, ...rest] = key.split(':');
          if (subjectIsIp(name, rest.join(':'))) cleared += await redis.del(key);
        }
      }
      for (const op of ['list', 'del', 'purge']) {
        cleared += await redis.del(`rl:admindiag:${op}:${ip}`);
      }
      return { cleared };
    }
    return fail(reply, 'invalid_request', 'Provide { ip } or { key }', 400);
  });
}
