import { fail } from '../shared.js';
import { LIMIT_CATALOG, effectiveLimit } from '../../lib/limits.js';

// Display metadata for limiters NOT in the admin-tunable catalog (the admin
// surface's own guards — deliberately fixed, ops never needs to tune them).
const EXTRA_META = {
  admintoken: () => ({ limit: 10, windowSec: 15 * 60, scope: 'ip', label: 'Admin token (per IP)' }),
};

/* KEY SHAPE NOTE (keep in sync when adding limiters!):
   rl:<name>:<subject>  =>  subject is an IP for the ip-scoped catalog
   entries and a username for account-scoped ones. admindiag keys are
   rl:admindiag:<op>:<ip> (two segments) and are not displayed. Subjects are
   IPs (IPv4/IPv6, never ':') or lowercase usernames, so the split by ':' is
   unambiguous. */
// IP-subject for everything except the account-scoped catalog entries
// (EXTRA_META entries are IP guards; unknown names clear as IP-shaped).
const subjectIsIp = (name) => !(LIMIT_CATALOG[name] && !LIMIT_CATALOG[name].ip);


// GET /api/admin/rate-limits, POST /api/admin/rate-limits/clear.
export default async function rateLimitsRoutes(app, { redis, config, settings }) {
  app.get('/api/admin/rate-limits', async () => {
    const entries = [];
    // redis v5's scanIterator yields batches of keys, not single keys.
    for await (const batch of redis.scanIterator({ MATCH: 'rl:*', COUNT: 100 })) {
      for (const key of batch) {
        const [, name, ...rest] = key.split(':');
        const subject = rest.join(':');
        let meta;
        if (LIMIT_CATALOG[name]) {
          // show what is ACTUALLY in force: default < app override < user
          // override (for account-scoped names the subject is the user)
          const lim = await effectiveLimit(settings, config, name, LIMIT_CATALOG[name].ip ? null : subject);
          meta = { ...lim, scope: LIMIT_CATALOG[name].ip ? 'ip' : 'account' };
        } else if (EXTRA_META[name]) {
          meta = EXTRA_META[name]();
        } else continue;
        const [count, ttlSec] = await Promise.all([redis.get(key), redis.ttl(key)]);
        entries.push({
          key,
          name,
          scope: meta.scope,
          subject,
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
