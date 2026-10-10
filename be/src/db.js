import { MongoClient } from 'mongodb';
import { createClient } from 'redis';

export async function connectMongo(url, { msgQueueMaxSec = 30 * 24 * 3600 } = {}) {
  const client = new MongoClient(url);
  await client.connect();
  const db = client.db();
  await db.collection('users').createIndex({ ul: 1 }, { unique: true });
  // Usernames are normalised to lowercase; migrate legacy docs that stored
  // the typed casing in `u` (idempotent — matches only mixed-case rows).
  await db.collection('users').updateMany({ u: /[A-Z]/ }, [{ $set: { u: '$ul' } }]);
  // Account identity anchor (founder key) added alongside the friends
  // feature: backfill from the first device for pre-existing docs (the
  // founder device was historically devices[0]; no live accounts existed
  // when this shipped, so the fallback is effectively test-only).
  await db.collection('users').updateMany(
    { identity: { $exists: false }, 'devices.0': { $exists: true } },
    [{ $set: { identity: { d: '$devices.0.id', p: '$devices.0.pub' } } }],
  );
  // Diagnostics reports ('Send diagnostics' button): auto-expire after 30 days.
  await db.collection('diagnostics').createIndex({ ts: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });
  // Abuse reports ('Report user' in the chat menu): moderation records — NO
  // TTL (kept until the admin deletes them); indexed for newest-first lists.
  await db.collection('reports').createIndex({ ts: -1 });
  // A report's DECRYPTED attachments (req 9): one doc per item (Mongo's 16 MB
  // document limit makes a multi-attachment report doc impossible), keyed by
  // the report it belongs to, addressed by the index the admin panel shows.
  await db.collection('report_media').createIndex({ report: 1, index: 1 }, { unique: true });
  // Identity-verification document photos (image binaries; ONLY the admin
  // reads them; deleted on demand after review — see VERIFICATION docs).
  await db.collection('id_docs').createIndex({ ul: 1 }, { unique: true });
  // Friends are queried by WHO a list contains (trust gate + reputation
  // stats): multikey index over the entry usernames.
  await db.collection('users').createIndex({ 'friends.u': 1 });
  // Profile bios + tiny avatars (see routes/app-routes/profile.js).
  await db.collection('profiles').createIndex({ ul: 1 }, { unique: true });
  // Store-and-forward message queue (milestone 3): one doc per recipient
  // device, deleted once that device pulls it.
  const messages = db.collection('messages');  await messages.createIndex({ 'to.ul': 1, 'to.dv': 1, ts: 1 });
  // Idempotent client retries: same (sender device, client id) cannot be
  // queued twice.
  await messages.createIndex({ 'from.ul': 1, 'from.fd': 1, cid: 1 }, { unique: true });
  // Retention sweep: copies get expireAt = pulledAt + MSG_RETENTION_SEC when
  // confirmed pulled; MongoDB's TTL monitor removes them once past it.
  await messages.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
  // Queue cap backfill: copies inserted BEFORE the queue-max policy have no
  // expireAt and would stay queued forever — stamp them so legacy rows age
  // out under the same TTL (old ones expire promptly; that is the policy).
  await messages.updateMany(
    { expireAt: { $exists: false } },
    [{ $set: { expireAt: { $add: ['$ts', msgQueueMaxSec * 1000] } } }],
  );
  // Share-link attribution (lib/shares.js): one doc per (link owner -> the
  // account that followed it). The pair IS the identity, and the admin
  // Shares tab reads both directions.
  const shares = db.collection('shares');
  await shares.createIndex({ o: 1, viewer: 1 }, { unique: true });
  await shares.createIndex({ viewer: 1 });
  // Durable "A has messaged B" edges for the God View graph — the message
  // queue itself expires, so the graph needs its own bounded record.
  // Metadata only (no envelope, no content).
  await db.collection('contacts').createIndex({ from: 1, to: 1 }, { unique: true });
  // Media blobs (milestone 4): ciphertext + encrypted thumbnail, one doc per
  // SEND (not per recipient). Owner lookup drives the quota; `ts` drives the
  // retention/orphan sweep (lib/media.js). Deliberately NO unique index on
  // sha256: cross-send dedup would turn a hash match into an upload oracle
  // ("someone else already has this exact ciphertext").
  const media = db.collection('media');
  await media.createIndex({ 'owner.ul': 1 });
  await media.createIndex({ ts: 1 });
  return { client, db };
}

export async function connectRedis(url) {
  const client = createClient({ url });
  await client.connect();
  return client;
}
