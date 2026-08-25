import { MongoClient } from 'mongodb';
import { createClient } from 'redis';

export async function connectMongo(url) {
  const client = new MongoClient(url);
  await client.connect();
  const db = client.db();
  await db.collection('users').createIndex({ ul: 1 }, { unique: true });
  // Store-and-forward message queue (milestone 3): one doc per recipient
  // device, deleted once that device pulls it.
  const messages = db.collection('messages');
  await messages.createIndex({ 'to.ul': 1, 'to.dv': 1, ts: 1 });
  // Idempotent client retries: same (sender device, client id) cannot be
  // queued twice.
  await messages.createIndex({ 'from.ul': 1, 'from.fd': 1, cid: 1 }, { unique: true });
  return { client, db };
}

export async function connectRedis(url) {
  const client = createClient({ url });
  await client.connect();
  return client;
}
