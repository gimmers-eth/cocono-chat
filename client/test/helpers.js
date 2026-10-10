// Integration-test harness: boots the REAL backend in-process (Fastify +
// mongodb-memory-server + Redis) and hands out configured SDK clients.

import { MongoMemoryServer } from 'mongodb-memory-server';
import { buildApp } from '@cocono/be/src/app.js';
import { config } from '@cocono/be/src/config.js';
import { connectMongo, connectRedis } from '@cocono/be/src/db.js';
import { CoconoClient } from '../src/index.js';

export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15';

// Generous limits so tests don't trip rate-limits.
const LIMITS = {
  // SDK tests pair second devices freely — the shipped 1-device unverified
  // policy is covered by be/test/premium.test.js
  deviceLimitUnverified: 5,
  signupIpLimit: 1000,
  // transport tests exercise messaging, not the identity policy
  coldSendRequiresVerification: false,
  challengeIpLimit: 1000,
  verifyAccountLimit: 1000,
  verifyIpLimit: 1000,
  msgAccountLimit: 1000,
  msgIpLimit: 1000,
  // media: a few hundred tiny blobs per suite must not trip the caps the
  // lifecycle tests are about (the caps themselves are covered in be/test)
  mediaUpIpLimit: 5000,
  mediaUpAccountLimit: 5000,
  mediaDlIpLimit: 5000,
  mediaDlAccountLimit: 5000,
  userKeysIpLimit: 1000,
  deviceEnrollIpLimit: 1000,
  deviceApproveAccountLimit: 1000,
  enrollStatusIpLimit: 1000,
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const randUser = (prefix = 'sdk') =>
  `${prefix}${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;

export async function startServer() {
  const mongod = await MongoMemoryServer.create();
  const mongo = await connectMongo(mongod.getUri('cocono-sdk-test'));
  const redis = await connectRedis(TEST_REDIS_URL);
  await redis.flushDb();
  const app = await buildApp({ mongo, redis, config: { ...config, ...LIMITS }, feRoot: null });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

  return {
    app,
    mongo,
    redis,
    baseUrl,

    /** New SDK client against this server (silent logging by default). */
    client(options = {}) {
      return new CoconoClient({ baseUrl, logging: false, ...options });
    },

    /** Hard-delete an account + its messages + its account-scoped Redis state. */
    async deleteUser(username) {
      const ul = username.toLowerCase();
      await mongo.db.collection('users').deleteOne({ ul });
      await mongo.db
        .collection('messages')
        .deleteMany({ $or: [{ 'to.ul': ul }, { 'from.ul': ul }] });
      // media blobs owned by the account (milestone 4) — same reason the app
      // server does it: an account that is gone leaves no uploads behind
      await mongo.db.collection('media').deleteMany({ 'owner.ul': ul });
      // share-link attribution + graph contact edges naming this account
      await mongo.db.collection('shares').deleteMany({ $or: [{ o: ul }, { viewer: ul }] });
      await mongo.db.collection('contacts').deleteMany({ $or: [{ from: ul }, { to: ul }] });
      for (const key of [
        `rl:verify:${ul}`,
        `rl:dapprove:${ul}`,
        `rl:dpending:${ul}`,
        `rl:msg:${ul}`,
      ]) {
        await redis.del(key);
      }
      for await (const batch of redis.scanIterator({ MATCH: `denroll:c:${ul}:*`, COUNT: 100 })) {
        for (const key of batch) await redis.del(key);
      }
    },

    async stop() {
      await app.close();
      await redis.quit();
      await mongo.client.close();
      await mongod.stop();
    },
  };
}

/** Resolves with the first matching payload emitted for `type`. */
export function waitFor(emitter, type, pred = () => true, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const off = emitter.on(type, (payload) => {
      if (!pred(payload)) return;
      clearTimeout(timer);
      off();
      resolve(payload);
    });
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timeout waiting for "${type}"`));
    }, timeoutMs);
  });
}

export const waitOpen = (client, timeoutMs = 6000) =>
  waitFor(client, 'state', (p) => p.state === 'open', timeoutMs);
