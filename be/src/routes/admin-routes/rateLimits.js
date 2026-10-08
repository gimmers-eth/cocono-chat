import { fail } from '../shared.js';
import { LIMIT_CATALOG, effectiveLimit } from '../../lib/limits.js';
import { invalidateRateLimitsGate } from '../../lib/rateLimit.js';

// Display metadata for limiters NOT in the admin-tunable catalog (the admin
// surface's own guards — deliberately fixed, ops never needs to tune them).
const EXTRA_META = {
  admintoken: () => ({ limit: 10, windowSec: 15 * 60, scope: 'ip', label: 'Admin token (per IP)' }),
  // admin-surface guards (rl:admindiag:<op>:<ip>) — fixed, not tunable, but
  // searchable like everything else
  'admindiag-list': () => ({ limit: 600, windowSec: 3600, scope: 'ip', label: 'Admin diag list' }),
  'admindiag-del': () => ({ limit: 200, windowSec: 3600, scope: 'ip', label: 'Admin diag delete' }),
  'admindiag-purge': () => ({ limit: 20, windowSec: 3600, scope: 'ip', label: 'Admin diag purge' }),
};

/* KEY SHAPE NOTE (keep in sync when adding limiters!):
   rl:<name>:<subject>  =>  subject is an IP for the ip-scoped catalog
   entries and a username for account-scoped ones. admindiag keys are
   rl:admindiag:<op>:<ip> (two segments) and surface under the
   'admindiag-<op>' meta names. Subjects are IPs (IPv4/IPv6, never ':') or
   lowercase usernames, so the split by ':' is unambiguous. */
// IP-subject for everything except the account-scoped catalog entries
// (EXTRA_META entries are IP guards; unknown names clear as IP-shaped).
const subjectIsIp = (name) => !(LIMIT_CATALOG[name] && !LIMIT_CATALOG[name].ip);

// rl:admindiag:<op>:<ip> → name 'admindiag-<op>', real subject last
function parseKey(key) {
  const [, name, ...rest] = key.split(':');
  if (name === 'admindiag') {
    const [op, ...ip] = rest;
    return { name: `admindiag-${op}`, subject: ip.join(':') };
  }
  return { name, subject: rest.join(':') };
}

// Scan one pattern into a Set (redis scanIterator yields batches).
async function collectKeys(redis, pattern, into) {
  for await (const batch of redis.scanIterator({ MATCH: pattern, COUNT: 100 })) {
    for (const key of batch) into.add(key);
  }
}

// GET /api/admin/rate-limits — full sweep (no subjects) or, preferred by the
// admin UI, ?subjects=ip,user,… scoped SCANs so a busy box never ships its
// entire counter space to the browser. POST /api/admin/rate-limits/clear.
export default async function rateLimitsRoutes(app, { redis, config, settings }) {
  app.get('/api/admin/rate-limits', async (request) => {
    const subjects = typeof request.query?.subjects === 'string'
      ? request.query.subjects
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0 && s.length <= 80)
        .slice(0, 20)
      : null;
    if (subjects && !subjects.length) return [];

    const keys = new Set();
    if (subjects) {
      for (const s of subjects) {
        await collectKeys(redis, `rl:*:${s}`, keys);
        await collectKeys(redis, `rl:admindiag:*:${s}`, keys);
      }
    } else {
      await collectKeys(redis, 'rl:*', keys);
    }

    const entries = [];
    for (const key of keys) {
      const { name, subject } = parseKey(key);
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
    entries.sort((a, b) => a.key.localeCompare(b.key));
    return entries;
  });

  // PUT /api/admin/rate-limits/state { disabled: bool } — the server-wide
  // KILL SWITCH (cocono-be enforcement). Runtime-off exists for ops tooling
  // (ops/fake-users bulk traffic); flip it back on when done — the admin
  // Traffic page shows a loud banner while off. Invalidating here makes the
  // change instant in this process; the app server follows within the 5s
  // gate cache. NOTE: guards around the admin surface itself (token, admin
  // diag/ops limiters) live in the admin process, which never wires the gate.
  app.put('/api/admin/rate-limits/state', async (request, reply) => {
    const disabled = request.body?.disabled === true;
    await settings.updateOne(
      { _id: 'traffic' },
      { $set: { rateLimitsDisabled: disabled, updatedAt: new Date() } },
      { upsert: true },
    );
    invalidateRateLimitsGate();
    request.log.warn(`[admin] rate limits ${disabled ? 'DISABLED server-wide' : 're-enabled'}`);
    return { rateLimitsDisabled: disabled };
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
