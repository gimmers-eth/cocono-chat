import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { verifyJwt } from './lib/jwt.js';
import { registerSecurityHeaders } from './routes/shared.js';
import appRoutes from './routes/app-routes/index.js';
import { resolveAppName } from './routes/app-routes/appInfo.js';
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

  const ctx = {
    users,
    redis,
    config,
    diagnostics: mongo.db.collection('diagnostics'),
    settings: mongo.db.collection('settings'),
    messages: mongo.db.collection('messages'),
    idDocs: mongo.db.collection('id_docs'),
  };
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

    await app.register(fastifyStatic, { root: feRoot });
    // The client SDK is imported by the app as '/sdk/index.js' (no bundler).
    // Wrapped in an anonymous (encapsulated) plugin: a second @fastify/static
    // in the same scope would collide on the 'sendFile' decorator.
    if (sdkRoot) {
      await app.register((instance) => instance.register(fastifyStatic, { root: sdkRoot, prefix: '/sdk/' }));
    }
  }

  return app;
}

export const defaultFeRoot = path.resolve(import.meta.dirname, '..', '..', 'client', 'app');
export const defaultSdkRoot = path.resolve(import.meta.dirname, '..', '..', 'client', 'src');
