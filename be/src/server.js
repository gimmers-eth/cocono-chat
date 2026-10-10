import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { connectMongo, connectRedis } from './db.js';
import { buildApp, defaultFeRoot, defaultSdkRoot } from './app.js';
import { startMediaSweeper } from './lib/media.js';

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

  // Boot-check TLS config: half-configured TLS is a silent footgun
  // (server would come up plain http while operators think it's https).
  if (Boolean(config.tlsKeyPath) !== Boolean(config.tlsCertPath)) {
    throw new Error('TLS_KEY_PATH and TLS_CERT_PATH must both be set (or both unset).');
  }

  const mongo = await connectMongo(config.mongoUrl, { msgQueueMaxSec: config.msgQueueMaxSec });
  const redis = await connectRedis(config.redisUrl);
  const app = await buildApp({ mongo, redis, config, feRoot: defaultFeRoot, sdkRoot: defaultSdkRoot });

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`[server] listening on ${config.tlsCertPath ? 'https' : 'http'}://${config.host}:${config.port}`);

  // Media sweeper: the inline delete-on-last-ack (routes/app-routes/media.js)
  // is the fast path, this is the safety net — un-acked blobs past
  // MEDIA_RETENTION_DAYS and never-sent orphan uploads. A setInterval behind
  // the single-process assumption (same as the WS heartbeat above); the
  // message queue's own bounds are handled by Mongo's TTL index instead.
  const sweeper = startMediaSweeper({
    media: mongo.db.collection('media'), config, log: app.log,
    everyMs: config.mediaSweepSec * 1000,
  });

  const shutdown = async (signal) => {
    app.log.info(`[server] ${signal} received, shutting down`);
    sweeper.stop();
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
