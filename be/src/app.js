import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { verifyJwt } from './lib/jwt.js';
import { registerSecurityHeaders } from './routes/shared.js';
import appRoutes from './routes/app-routes/index.js';

// M5 fix: enroll-status URLs carry an unguessable capability (enrollId); keep
// it out of the logs entirely.
function redactUrl(url) {
  return /^\/api\/devices\/enroll-status\/.+/.test(url)
    ? '/api/devices/enroll-status/:redacted'
    : url;
}

export async function buildApp({ mongo, redis, config, feRoot }) {
  const users = mongo.db.collection('users');

  const app = Fastify({
    // M2 fix: behind the production nginx, request.ip must be the real client
    // IP or every per-IP rate limit collapses into one shared bucket.
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

  // M4 fix: strict same-origin security headers on every response.
  registerSecurityHeaders(app);

  // Parse the bearer token up front; routes decide whether to require it.
  // H4 fix: also re-check that the token's device is still registered —
  // otherwise a removed device keeps its JWT (up to 24h) and could still
  // approve new devices. The check is cheap (one findOne per authed request).
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    const header = request.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return;
    const payload = verifyJwt(header.slice(7), config.jwtSecret);
    if (!payload) return;

    const user = await users.findOne({ ul: payload.sub }, { projection: { 'devices.id': 1 } });
    const stillRegistered = user?.devices.some((dev) => dev.id === payload.d);
    if (stillRegistered) request.auth = payload;
  });

  await app.register(appRoutes, { users, redis, config });

  if (feRoot) {
    await app.register(fastifyStatic, { root: feRoot });
  }

  return app;
}

export const defaultFeRoot = path.resolve(import.meta.dirname, '..', '..', 'fe');
