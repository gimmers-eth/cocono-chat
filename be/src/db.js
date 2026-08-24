import { MongoClient } from 'mongodb';
import { createClient } from 'redis';

export async function connectMongo(url) {
  const client = new MongoClient(url);
  await client.connect();
  const db = client.db();
  await db.collection('users').createIndex({ ul: 1 }, { unique: true });
  return { client, db };
}

export async function connectRedis(url) {
  const client = createClient({ url });
  await client.connect();
  return client;
}
