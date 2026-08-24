// Internal admin app — runs separately from the main server (pnpm admin).
// Reads the same .env (MONGO_URL, REDIS_URL) via config.js. Binds to
// 127.0.0.1 by default; if you expose it on a network, set ADMIN_TOKEN.
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { connectMongo, connectRedis } from './db.js';
import adminRoutes from './routes/admin-routes/index.js';

const mongo = await connectMongo(config.mongoUrl);
const redis = await connectRedis(config.redisUrl);

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

if (config.adminToken) {
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    if (request.headers['x-admin-token'] !== config.adminToken) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Missing or invalid admin token' });
    }
  });
}

await app.register(adminRoutes, { users: mongo.db.collection('users'), redis, config });
await app.register(fastifyStatic, { root: path.resolve(import.meta.dirname, '..', 'admin') });

await app.listen({ port: config.adminPort, host: config.adminHost });
console.log(
  `[admin] http://${config.adminHost}:${config.adminPort}` +
    (config.adminToken ? ' (token required)' : ' (no ADMIN_TOKEN set — keep it local!)'),
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
