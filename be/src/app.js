import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { verifyJwt } from './lib/jwt.js';
import appRoutes from './routes/app-routes/index.js';

export async function buildApp({ mongo, redis, config, feRoot }) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  // Parse the bearer token up front; routes decide whether to require it.
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    const header = request.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return;
    const payload = verifyJwt(header.slice(7), config.jwtSecret);
    if (payload) request.auth = payload;
  });

  await app.register(appRoutes, { users: mongo.db.collection('users'), redis, config });

  if (feRoot) {
    await app.register(fastifyStatic, { root: feRoot });
  }

  return app;
}

export const defaultFeRoot = path.resolve(import.meta.dirname, '..', '..', 'fe');
