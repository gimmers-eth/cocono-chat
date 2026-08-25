// Dev entry: runs the server with auto-reload.
// Uses MONGO_URL from the environment/.env when set (e.g. a remote dev server);
// otherwise falls back to a persistent mongodb-memory-server with data in
// be/.data/mongo so accounts survive restarts.
import fs from 'node:fs';
import path from 'node:path';

const redact = (url) => {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return url;
  }
};

let mongod = null;

// Dev-only opt-out for the JWT-secret boot check (server.js): `pnpm dev`
// binds localhost and a forged JWT there only harms the developer.
process.env.ALLOW_DEV_JWT_SECRET = process.env.ALLOW_DEV_JWT_SECRET ?? 'true';

if (!process.env.MONGO_URL) {
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  const dbPath = path.resolve(import.meta.dirname, '..', '.data', 'mongo');
  fs.mkdirSync(dbPath, { recursive: true });
  const port = Number(process.env.DEV_MONGO_PORT ?? 27017);
  mongod = await MongoMemoryServer.create({
    instance: { dbPath, port, storageEngine: 'wiredTiger' },
  });
  process.env.MONGO_URL = mongod.getUri('cocono-chat');
  console.log(`[dev] MongoDB (in-memory) at ${process.env.MONGO_URL} (data in be/.data/mongo)`);
} else {
  console.log(`[dev] MongoDB at ${redact(process.env.MONGO_URL)}`);
}

const { start } = await import('./server.js');
try {
  await start();
} catch (err) {
  console.error('[dev] failed to start:', err);
  if (mongod) await mongod.stop();
  process.exit(1);
}

const stop = async () => {
  if (mongod) await mongod.stop();
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
