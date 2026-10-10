import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import Fastify from 'fastify';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { b64uEncode } from '../src/lib/b64u.js';
import { canonical } from '../src/lib/canon.js';
import { connectMongo, connectRedis } from '../src/db.js';
import adminRoutes from '../src/routes/admin-routes/index.js';

export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15';

export async function setupApp(overrides = {}) {
  const mongod = await MongoMemoryServer.create();
  const mongo = await connectMongo(mongod.getUri('cocono-chat-test'));
  const redis = await connectRedis(TEST_REDIS_URL);
  await redis.flushDb();
  // Identity policy OFF by default so message tests stay about transport;
  // verification.test/messaging policy tests opt back in via overrides.
  const app = await buildApp({
    mongo, redis,
    config: { ...config, coldSendRequiresVerification: false, ...overrides },
    feRoot: null,
  });
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

// Simulates a client device: Ed25519 key pair + X25519 key pair + signing
// helpers, matching what the browser does with WebCrypto.
export const nowEpoch = () => Math.floor(Date.now() / 1000);

export function makeClient() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const p = b64uEncode(spki.subarray(spki.length - 32));
  // X25519 key-agreement pair (milestone 3); raw pub = JWK x coordinate.
  const xkp = generateKeyPairSync('x25519');
  const x = xkp.publicKey.export({ format: 'jwk' }).x;
  return {
    p,
    x,
    xPriv: xkp.privateKey,
    signBytes(bytes) {
      return b64uEncode(sign(null, bytes, privateKey));
    },
    // Signed payload shape for signup AND enroll (M6: timestamp t; M3: x key).
    signSignup({ u, a, d, t = nowEpoch() }) {
      return this.signBytes(Buffer.from(canonical({ a, d, p: this.p, t, u, x: this.x }), 'utf8'));
    },
  };
}

export const randomAesKey = () => b64uEncode(randomBytes(32));

// Admin panel harness: the real admin route tree mounted on a bare Fastify
// over the SAME stores as the app (that is how src/admin.js runs it, minus the
// token gate). Every collection the routes touch is passed explicitly, so a
// new store shows up here as a missing dependency rather than a silent null.
export async function setupAdmin(overrides = {}) {
  const ctx = await setupApp(overrides);
  const db = ctx.mongo.db;
  const admin = Fastify({ logger: false });
  await admin.register(adminRoutes, {
    users: db.collection('users'),
    redis: ctx.redis,
    config: { ...config, coldSendRequiresVerification: false, ...overrides },
    diagnostics: db.collection('diagnostics'),
    reports: db.collection('reports'),
    reportMedia: db.collection('report_media'),
    media: db.collection('media'),
    settings: db.collection('settings'),
    messages: db.collection('messages'),
    idDocs: db.collection('id_docs'),
    profiles: db.collection('profiles'),
    counters: db.collection('counters'),
    shares: db.collection('shares'),
    contacts: db.collection('contacts'),
    graph: db.collection('graph'),
  });
  return {
    ...ctx,
    admin,
    db,
    async teardown() {
      await admin.close();
      await ctx.teardown();
    },
  };
}

// Signup (+ optional share-link referrer `r`) through the real route, then a
// session token for the authed endpoints. Returns the created user's handle.
export async function signupUser(app, client, u, { r, d = `device-${Math.random().toString(36).slice(2, 10)}-1` } = {}) {
  const a = randomAesKey();
  const t = nowEpoch();
  const s = client.signSignup({ u, a, d, t });
  const res = await app.inject({
    method: 'POST',
    url: '/api/signup',
    payload: { u, p: client.p, x: client.x, a, d, t, s, ...(r ? { r } : {}) },
  });
  if (res.statusCode !== 201) return { res, ul: u.toLowerCase(), d };
  const { n } = (await app.inject({ method: 'POST', url: '/api/auth/challenge', payload: { u, d } })).json();
  const ve = await app.inject({
    method: 'POST', url: '/api/auth/verify',
    payload: { u, d, n, s: client.signBytes(Buffer.from(n, 'utf8')) },
  });
  return { res, ul: u.toLowerCase(), d, token: ve.json()?.token ?? null };
}
