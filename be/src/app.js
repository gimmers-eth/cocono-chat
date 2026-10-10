import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { verifyJwt } from './lib/jwt.js';
import { rateLimit, setRateLimitsGate } from './lib/rateLimit.js';
import { effectiveLimit } from './lib/limits.js';
import { registerSecurityHeaders, limited, fail } from './routes/shared.js';
import appRoutes from './routes/app-routes/index.js';
import { resolveAppName } from './routes/app-routes/appInfo.js';
import { resetLimitsCache } from './lib/limits.js';
import wsRoutes from './routes/ws-routes/index.js';

// M5 fix: the enroll-status URL carries an unguessable capability and the
// /ws upgrade URL carries the JWT — keep both out of the logs.
function redactUrl(url) {
  if (/^\/api\/devices\/enroll-status\/.+/.test(url)) {
    return '/api/devices/enroll-status/:redacted';
  }
  if (url.startsWith('/ws')) return '/ws?token=:redacted';
  return url;
}

export async function buildApp({ mongo, redis, config, feRoot, sdkRoot }) {
  // the limits override cache is per-process; fresh app instance = fresh
  // read of the settings doc (test isolation: separate suites would
  // otherwise inherit a previous app's cached overrides for up to the TTL)
  resetLimitsCache();
  // TLS is opt-in via TLS_KEY_PATH/TLS_CERT_PATH (validated at boot in
  // server.js). Fastify serves https + wss when the options are present.
  const tls = config.tlsKeyPath && config.tlsCertPath
    ? { https: { key: fs.readFileSync(config.tlsKeyPath), cert: fs.readFileSync(config.tlsCertPath) } }
    : {};

  const app = Fastify({
    ...tls,
    // M2 fix: behind nginx, request.ip must be the real client IP or every
    // IP-scoped rate limit collapses into one shared bucket.
    trustProxy: config.trustProxy,
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: redactUrl(request.url),
            hostname: request.hostname,
            remoteAddress: request.ip,
            remotePort: request.socket?.remotePort,
          };
        },
      },
    },
  });

  const users = mongo.db.collection('users');

  // M4 fix: strict same-origin security headers on every response.
  registerSecurityHeaders(app);

// API data (bios, avatars, friends, stats) changes server-side at any time —
// heuristic browser caching of these JSON GETs makes profiles show stale
// photos. Statics keep their no-cache/ETag handling; /api/* is never cached.
app.addHook('onSend', async (request, reply, payload) => {
  if (request.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
  return payload;
});

  // Parse the bearer token up front; routes decide whether to require it.
  // H4 fix: also re-check that the token's device is still registered — a
  // removed device loses access immediately, not at token expiry.
  // BAN fix: a staff-BANNED account is locked out of EVERY authenticated
  // call and the WS (lib/moderation.js) — the token stays cryptographically
  // valid, the account doc refuses service. Data stays untouched.
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request, reply) => {
    const header = request.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return;
    const payload = verifyJwt(header.slice(7), config.jwtSecret);
    if (!payload) return;

    const user = await users.findOne({ ul: payload.sub }, { projection: { 'devices.id': 1, banned: 1 } });
    if (user?.banned === true) {
      return fail(reply, 'account_banned',
        'This account has been banned by CoCoNo staff. Your data is preserved; contact support if you believe this is a mistake.', 403);
    }
    if (user?.devices.some((dev) => dev.id === payload.d)) {
      request.auth = payload;
      // Device egress-IP tracking + FLAP limiter: the latest IP per device
      // is kept (Redis fast path + devices.$.lastIp for the admin 'known
      // IPs' display), and every genuine IP CHANGE spends one unit of a
      // fixed-window budget (rl:ipflap:<ul>:<dv>, default 5 / 5 min).
      // Over budget the device gets 429 until the window passes — self-
      // healing for carrier-NAT reshuffles, a hard stall for proxy hops,
      // and scoped to THIS device (siblings on the account are untouched).
      const ipKey = `devip:${payload.sub}:${payload.d}`;
      const seen = await redis.get(ipKey);
      if (seen !== request.ip) {
        // first sighting (fresh device / TTL lapsed / redis restart) records
        // for free — only a genuine CHANGE spends the budget
        if (seen !== null) {
          // catalog-resolved: app-wide Tune defaults + per-device overrides
          // (subject 'user:device') all apply here, kill switch included
          const flapSubject = `${payload.sub}:${payload.d}`;
          const flapLim = await effectiveLimit(ctx.settings, config, 'ipflap', flapSubject);
          const fl = await rateLimit(redis, `rl:ipflap:${flapSubject}`, flapLim.limit, flapLim.windowSec);
          if (!fl.ok) return limited(reply, fl);
        }
        await Promise.all([
          redis.set(ipKey, request.ip, { EX: config.deviceIpTtlSec }),
          users.updateOne(
            { ul: payload.sub, 'devices.id': payload.d },
            { $set: { 'devices.$.lastIp': request.ip, 'devices.$.lastIpAt': new Date() } },
          ),
        ]);
      }
    }
  });

  const ctx = {
    users,
    redis,
    config,
    diagnostics: mongo.db.collection('diagnostics'),
    // abuse reports ('Report user' in the chat menu) — moderation records,
    // kept until an admin deletes them (NO TTL, unlike diagnostics)
    reports: mongo.db.collection('reports'),
    // username-keyed counters (messages sent) that SURVIVE account deletion
    // by design: a deleted-then-re-registered user keeps their badge
    // progress. wipe-data.sh still drops it (a full dev reset resets all).
    counters: mongo.db.collection('counters'),
    settings: mongo.db.collection('settings'),
    messages: mongo.db.collection('messages'),
    idDocs: mongo.db.collection('id_docs'),
    profiles: mongo.db.collection('profiles'),
    // share-link attribution (created/seen edges) + the durable
    // "has messaged" edges the God View graph draws — see lib/shares.js
    shares: mongo.db.collection('shares'),
    contacts: mongo.db.collection('contacts'),
    graph: mongo.db.collection('graph'),
  };
  // Kill switch: env hard-off, else the runtime settings-doc flag (cached 5s
  // inside rateLimit; admin writes invalidate this process instantly).
  setRateLimitsGate(config.rateLimitsDisabled
    ? async () => true
    : async () => (await ctx.settings.findOne({ _id: 'traffic' }))?.rateLimitsDisabled === true);
  await app.register(appRoutes, ctx);
  await app.register(wsRoutes, ctx);

  if (feRoot) {
    // PWA manifest served dynamically so the app-name setting is reflected
    // in installed apps too. Registered BEFORE @fastify/static so the
    // explicit route wins over the static wildcard.
    let manifestTemplate = null;
    app.get('/manifest.webmanifest', async (request, reply) => {
      if (!manifestTemplate) {
        manifestTemplate = JSON.parse(
          fs.readFileSync(path.join(feRoot, 'manifest.webmanifest'), 'utf8'),
        );
      }
      const name = await resolveAppName(ctx.settings, config);
      return reply
        .type('application/manifest+json')
        .send({ ...manifestTemplate, name, short_name: name });
    });

    await app.register(fastifyStatic, { root: feRoot ,
      cacheControl: 'no-cache'});
    // The client SDK is imported by the app as '/sdk/index.js' (no bundler).
    // Wrapped in an anonymous (encapsulated) plugin: a second @fastify/static
    // in the same scope would collide on the 'sendFile' decorator.
    if (sdkRoot) {
      await app.register((instance) => instance.register(fastifyStatic, { root: sdkRoot, prefix: '/sdk/', cacheControl: 'no-cache' }));
    }
  }

  return app;
}

export const defaultFeRoot = path.resolve(import.meta.dirname, '..', '..', 'client', 'app');
export const defaultSdkRoot = path.resolve(import.meta.dirname, '..', '..', 'client', 'src');
