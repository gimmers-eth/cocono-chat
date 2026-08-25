// Internal admin app — runs separately from the main server (pnpm admin).
// Reads the same .env (MONGO_URL, REDIS_URL) via config.js. Binds to
// 127.0.0.1 by default; ADMIN_TOKEN is mandatory for non-loopback binds.
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { connectMongo, connectRedis } from './db.js';
import { rateLimit } from './lib/rateLimit.js';
import { registerSecurityHeaders } from './routes/shared.js';
import adminRoutes from './routes/admin-routes/index.js';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

// M7 fix (fail closed): a non-loopback admin bind without a token would be an
// open, unauthenticated admin API — refuse to start.
if (!config.adminToken && !LOOPBACK.has(config.adminHost)) {
  console.error('[admin] ADMIN_TOKEN must be set when ADMIN_HOST is not loopback.');
  process.exit(1);
}
if (!config.adminToken) {
  console.warn(
    '[admin] ADMIN_TOKEN not set — the admin API is UNAUTHENTICATED. ' +
      'This is only tolerable because the bind is loopback; set ADMIN_TOKEN before exposing it.',
  );
}

// M7 fix: constant-time token comparison.
function tokenMatches(provided) {
  if (typeof provided !== 'string') return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(config.adminToken).digest();
  return timingSafeEqual(a, b);
}

const mongo = await connectMongo(config.mongoUrl);
const redis = await connectRedis(config.redisUrl);

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  trustProxy: config.trustProxy,
});
registerSecurityHeaders(app);

// H1 fix: the token gate lives INSIDE the admin routes' encapsulation scope,
// so it keys off the matched route, not the raw request URL. The old
// `request.url.startsWith('/api/')` check was bypassable with percent-encoded
// paths (/%61pi/...) because the router decodes before matching.
await app.register(async function adminScope(instance) {
  if (config.adminToken) {
    instance.addHook('onRequest', async (request, reply) => {
      if (tokenMatches(request.headers['x-admin-token'])) return;
      // M7 fix: throttle failed tokens against online brute force.
      const rl = await rateLimit(redis, `rl:admintoken:${request.ip}`, 10, 15 * 60);
      if (!rl.ok) reply.header('retry-after', String(rl.retryAfterSec));
      return reply
        .code(rl.ok ? 401 : 429)
        .send({ error: rl.ok ? 'unauthorized' : 'rate_limited', message: 'Missing or invalid admin token' });
    });
  }
  await instance.register(adminRoutes, { users: mongo.db.collection('users'), redis, config });
});

await app.register(fastifyStatic, { root: path.resolve(import.meta.dirname, '..', 'admin') });

await app.listen({ port: config.adminPort, host: config.adminHost });
console.log(
  `[admin] http://${config.adminHost}:${config.adminPort}` +
    (config.adminToken ? ' (token required)' : ' (no ADMIN_TOKEN set — loopback only!)'),
);

const shutdown = async (signal) => {
  app.log.info(`[admin] ${signal} received, shutting down`);
  await app.close();
  await mongo.client.close();
  await redis.quit();
  process.exit(0);
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
