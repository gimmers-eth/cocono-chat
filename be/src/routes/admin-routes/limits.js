import { fail } from '../shared.js';
import { USERNAME_RE } from '../../lib/username.js';
import {
  LIMIT_CATALOG, effectiveLimit, readLimitsDoc, writeOverride, validOverride,
} from '../../lib/limits.js';

// ---- limit tuning ----
// Everything the catalog knows (all app limiters, IP and account) is
// tunable app-wide; account-scoped limiters — including the verify/trust
// budgets (fvday/fvweek/ftday/ftweek) — are ALSO tunable per user. Layering
// at check time: user override > app override > config default. IP-scoped
// names reject per-user edits (the subject is an address, not an account).
//
// Writes take effect in this process immediately (writeOverride invalidates
// the cache); the app server process picks them up within the cache TTL.

export default async function limitsRoutes(app, { config, settings }) {
  app.get('/api/admin/limits', async () => {
    const doc = await readLimitsDoc(settings);
    const traffic = await settings.findOne({ _id: 'traffic' });
    const limiters = [];
    for (const [name, entry] of Object.entries(LIMIT_CATALOG)) {
      const def = entry.def(config);
      limiters.push({
        name,
        label: entry.label,
        scope: entry.ip ? 'ip' : 'account',
        device: entry.device === true,
        defaultLimit: def.limit,
        defaultWindowSec: def.windowSec,
        override: doc.global[name] ?? null,
        effective: await effectiveLimit(settings, config, name),
      });
    }
    const userOverrides = [];
    for (const [ul, per] of Object.entries(doc.users)) {
      for (const [name, o] of Object.entries(per)) {
        userOverrides.push({ ul, name, ...o });
      }
    }
    return { limiters, userOverrides, rateLimitsDisabled: traffic?.rateLimitsDisabled === true };
  });

  // PATCH /api/admin/limits
  //   { name, value: {limit?, windowSec?} | null }                 → app-wide
  //   { name, user: '<ul>' | '<ul>:<deviceId>', value }            → per subject
  // value null clears that override layer (falls back a level).
  app.patch('/api/admin/limits', async (request, reply) => {
    const { name, value, user } = request.body ?? {};
    const entry = LIMIT_CATALOG[name];
    if (!entry) return fail(reply, 'bad_limiter', `Unknown limiter '${name}'`, 400);
    if (user !== undefined && user !== null) {
      if (entry.ip) {
        return fail(reply, 'ip_scoped', `${name} is IP-scoped — tune it app-wide, not per subject`, 400);
      }
      // subject: an account ('alice') or a DEVICE ('alice:<deviceId>' — the
      // ipflap limiter's key shape); stored verbatim as the override key
      const compound = /^([a-zA-Z0-9_-]{4,64}):([a-zA-Z0-9_-]{8,64})$/.exec(String(user));
      if (typeof user !== 'string' || (!USERNAME_RE.test(user) && !compound)) {
        return fail(reply, 'bad_username', 'Subject must be a username or username:deviceId', 400);
      }
    }
    const check = validOverride(value === undefined ? null : value);
    if (!check.ok) return fail(reply, 'invalid_request', check.why, 400);
    if (user) {
      await writeOverride(settings, name, check.value, { user: user.toLowerCase() });
    } else {
      await writeOverride(settings, name, check.value, null);
    }
    const ul = user ? user.toLowerCase() : null;
    return {
      name,
      user: ul,
      effective: await effectiveLimit(settings, config, name, ul),
    };
  });
}
