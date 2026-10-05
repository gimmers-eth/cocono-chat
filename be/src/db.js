import { MongoClient } from 'mongodb';
import { createClient } from 'redis';

export async function connectMongo(url) {
  const client = new MongoClient(url);
  await client.connect();
  const db = client.db();
  await db.collection('users').createIndex({ ul: 1 }, { unique: true });
  // Usernames are normalised to lowercase; migrate legacy docs that stored
  // the typed casing in `u` (idempotent — matches only mixed-case rows).
  await db.collection('users').updateMany({ u: /[A-Z]/ }, [{ $set: { u: '$ul' } }]);
  // Diagnostics reports ('Send diagnostics' button): auto-expire after 30 days.
  await db.collection('diagnostics').createIndex({ ts: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });
  // Store-and-forward message queue (milestone 3): one doc per recipient
  // device, deleted once that device pulls it.
  const messages = db.collection('messages');
  await messages.createIndex({ 'to.ul': 1, 'to.dv': 1, ts: 1 });
  // Idempotent client retries: same (sender device, client id) cannot be
  // queued twice.
  await messages.createIndex({ 'from.ul': 1, 'from.fd': 1, cid: 1 }, { unique: true });
  // Retention sweep: copies get expireAt = pulledAt + MSG_RETENTION_SEC when
  // confirmed pulled; MongoDB's TTL monitor removes them once past it.
  // Never-pulled copies have no expireAt and stay queued for delivery.
  await messages.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
  return { client, db };
}

export async function connectRedis(url) {
  const client = createClient({ url });
  await client.connect();
  return client;
}
