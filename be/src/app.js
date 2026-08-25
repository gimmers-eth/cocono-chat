import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { verifyJwt } from './lib/jwt.js';
import { registerSecurityHeaders } from './routes/shared.js';
import appRoutes from './routes/app-routes/index.js';
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

export async function buildApp({ mongo, redis, config, feRoot }) {
  const app = Fastify({
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

  // Parse the bearer token up front; routes decide whether to require it.
  // H4 fix: also re-check that the token's device is still registered — a
  // removed device loses access immediately, not at token expiry.
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    const header = request.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return;
    const payload = verifyJwt(header.slice(7), config.jwtSecret);
    if (!payload) return;

    const user = await users.findOne({ ul: payload.sub }, { projection: { 'devices.id': 1 } });
    if (user?.devices.some((dev) => dev.id === payload.d)) request.auth = payload;
  });

  const ctx = { users, redis, config };
  await app.register(appRoutes, ctx);
  await app.register(wsRoutes, { ...ctx, messages: mongo.db.collection('messages') });

  if (feRoot) {
    await app.register(fastifyStatic, { root: feRoot });
  }

  return app;
}

export const defaultFeRoot = path.resolve(import.meta.dirname, '..', '..', 'fe');
