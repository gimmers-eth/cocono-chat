import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { connectMongo, connectRedis } from './db.js';
import { buildApp, defaultFeRoot } from './app.js';

export async function start() {
  // H2 fix: refuse to serve with the dev default (or a too-short) JWT secret.
  // Local dev may opt out with ALLOW_DEV_JWT_SECRET=true (set by dev.js).
  if (config.jwtSecretInsecure && !config.allowDevJwtSecret) {
    throw new Error(
      'JWT_SECRET is unset, the dev default, or shorter than 32 characters. ' +
        'Generate one with: openssl rand -base64 48 — or set ALLOW_DEV_JWT_SECRET=true ' +
        'to accept the risk in local development.',
    );
  }

  const mongo = await connectMongo(config.mongoUrl);
  const redis = await connectRedis(config.redisUrl);
  const app = await buildApp({ mongo, redis, config, feRoot: defaultFeRoot });

  await app.listen({ port: config.port, host: config.host });

  const shutdown = async (signal) => {
    app.log.info(`[server] ${signal} received, shutting down`);
    await app.close();
    await mongo.client.close();
    await redis.quit();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  return app;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((err) => {
    console.error('[server] failed to start:', err);
    process.exit(1);
  });
}
