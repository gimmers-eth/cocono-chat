import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { b64uEncode } from '../src/lib/b64u.js';
import { canonical } from '../src/lib/canon.js';
import { connectMongo, connectRedis } from '../src/db.js';

export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15';

export async function setupApp(overrides = {}) {
  const mongod = await MongoMemoryServer.create();
  const mongo = await connectMongo(mongod.getUri('cocono-chat-test'));
  const redis = await connectRedis(TEST_REDIS_URL);
  await redis.flushDb();
  const app = await buildApp({ mongo, redis, config: { ...config, ...overrides }, feRoot: null });
  return {
    app,
    mongo,
    redis,
    async teardown() {
      await app.close();
      await redis.quit();
      await mongo.client.close();
      await mongod.stop();
    },
  };
}

// Simulates a client device: Ed25519 key pair + signing helpers, matching
// what the browser does with WebCrypto.
export const nowEpoch = () => Math.floor(Date.now() / 1000);

export function makeClient() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const p = b64uEncode(spki.subarray(spki.length - 32));
  return {
    p,
    signBytes(bytes) {
      return b64uEncode(sign(null, bytes, privateKey));
    },
    // Signed payload shape for signup AND enroll (M6: includes timestamp t).
    signSignup({ u, a, d, t = nowEpoch() }) {
      return this.signBytes(Buffer.from(canonical({ a, d, p: this.p, t, u }), 'utf8'));
    },
  };
}

export const randomAesKey = () => b64uEncode(randomBytes(32));
