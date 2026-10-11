// Where a blob's bytes actually live (M4, and the 100 MB question).
//
// A Mongo document caps at 16 MB, so a 100 MB ciphertext CANNOT be a field on
// the `media` doc. A small one should be: an 8 MB photo in a document is one
// indexed read, while GridFS costs two collections and a chunk walk. So the
// choice is size-based and INVISIBLE to the callers — `blob`/`thumb` on the doc
// are either a Buffer (inline) or the marker string 'fs:<id>' meaning "the
// bytes are in GridFS under that files _id". Nothing else in the codebase has
// to know which storage a blob ended up in: the delete/ack/sweep paths stay as
// they were and only the read path asks.

import { GridFSBucket, ObjectId } from 'mongodb';
import { asBytes } from './media.js';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const FS_PREFIX = 'fs:';
const CHUNK_BYTES = 1 << 20;   // 1 MB: fewer chunks than GridFS' 255 kB default,
                               // still comfortably under the 16 MB doc limit

export const isFileRef = (v) => typeof v === 'string' && v.startsWith(FS_PREFIX);
export const fileRef = (id) => `${FS_PREFIX}${id}`;
export const fileIdOf = (ref) => String(ref).slice(FS_PREFIX.length);

// A file younger than this is assumed to be an upload in flight, not an orphan:
// the sweep must never race a client that is mid-PUT.
const ORPHAN_FILE_GRACE_MS = 30 * 60 * 1000;

export function createMediaStore({ db, config, mediaDocs = db.collection('media') }) {
  const bucket = new GridFSBucket(db, { bucketName: 'media', chunkSizeBytes: CHUNK_BYTES });
  const fileName = (id, part) => `${id}.${part}`;

  return {
    /** Whole buffer already in hand (the JSON path): inline while it fits. */
    async putBuffer(id, part, buf) {
      if (buf.length <= config.mediaInlineMaxBytes) return { inline: buf };
      const name = fileName(id, part);
      await pipeline(Readable.from(buf), bucket.openUploadStream(name));
      const files = await bucket.find({ filename: name }).toArray();
      return { fileRef: fileRef(String(files[0]._id)), bytes: buf.length };
    },

    /**
     * Stream an upload straight into storage, hashing and counting as it goes.
     * This is the raw-PUT path, and the reason it exists: a 100 MB file as
     * base64 JSON is a 133 MB body that would be buffered more than once. The
     * cap is therefore enforced DURING the stream — the moment a client sends
     * more than `maxBytes` the pipe is torn down and the partial file deleted,
     * so there is no such thing as a half-stored blob.
     */
    async putStream(id, part, stream, { maxBytes, sha256 } = {}) {
      const name = fileName(id, part);
      const hash = createHash('sha256');
      let bytes = 0;
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          bytes += chunk.length;
          if (bytes > maxBytes) { cb(new RangeError('media_too_large')); return; }
          hash.update(chunk);
          cb(null, chunk);
        },
      });
      try {
        await pipeline(stream, counter, bucket.openUploadStream(name));
      } catch (err) {
        // nothing survives a failed upload: an orphan here is quota the
        // account paid for bytes nobody can ever read
        await dropByName(bucket, name);
        if (err instanceof RangeError) return { overflow: true, bytes };
        throw err;
      }
      const digest = hash.digest('base64url');
      if (sha256 && digest !== sha256) {
        // what arrived is not what the sender said it was — recipients verify
        // THIS digest against the value inside the encrypted payload, so
        // accepting a mismatch would hand them garbage they could not trust
        await dropByName(bucket, name);
        return { mismatch: true, got: digest, bytes };
      }
      const files = await bucket.find({ filename: name }).toArray();
      return { fileRef: fileRef(String(files[0]._id)), bytes, digest };
    },

    /**
     * A byte range — or the whole file — as a stream, for GET /api/media/:id.
     * Ranges are what make a interrupted 100 MB download resumable, which on
     * mobile data is the difference between 'working' and 'never arrives'.
     */
    async read(ref, { start = 0, end = null, total = null } = {}) {
      const id = new ObjectId(fileIdOf(ref));
      if (start > 0 || (end !== null && end !== undefined)) {
        // the driver throws on `start` without `end` ('start must not be
        // greater than stream end'), so an open-ended range is closed with the
        // file's own length — passed in when the caller already knows it
        const stop = end ?? (total ?? await lengthOf(bucket, id)) - 1;
        // +1: HTTP `bytes=a-b` is inclusive at both ends and the driver's
        // `end` is exclusive — mixing them up loses one byte per range, which
        // is invisible until a resuming client stitches two halves together.
        return bucket.openDownloadStream(id, { start, end: Math.max(start + 1, stop + 1) });
      }
      return bucket.openDownloadStream(id);
    },

    async length(ref) {
      return lengthOf(bucket, new ObjectId(fileIdOf(ref)));
    },

    /**
     * Reclaim stored files that no `media` document references any more. Every
     * other delete path goes through a document, so a file left without one is
     * permanently invisible — this is the only thing that can find it. Called
     * from the sweeper, not from a request path.
     */
    async dropOrphanFiles() {
      const names = new Set();
      const docs = await mediaDocs.find({}, { projection: { _id: 1 } }).toArray();
      for (const d of docs) { names.add(`${d._id}.blob`); names.add(`${d._id}.thumb`); }
      const staleBefore = new Date(Date.now() - ORPHAN_FILE_GRACE_MS);
      const files = await bucket.find({ uploadDate: { $lt: staleBefore } }).toArray();
      let dropped = 0;
      for (const f of files) {
        if (names.has(f.filename)) continue;
        await bucket.delete(f._id);
        dropped += 1;
      }
      return dropped;
    },

    /** Remove every GridFS file a doc points at (both parts). */
    async removeParts(doc) {
      for (const part of ['blob', 'thumb']) {
        if (isFileRef(doc?.[part])) await dropByName(bucket, `${doc._id}.${part}`);
      }
    },
  };
}

async function lengthOf(bucket, id) {
  const files = await bucket.find({ _id: id }).toArray();
  return files[0]?.length ?? 0;
}

async function dropByName(bucket, name) {
  const files = await bucket.find({ filename: name }).toArray();
  for (const f of files) await bucket.delete(f._id);
}

/**
 * Read a stored part as a Buffer, for the few callers that must have the bytes
 * in hand (moderation decrypting a reported attachment). Inline values pass
 * straight through; a GridFS ref is drained.
 */
export async function readAll(store, doc, part = 'blob') {
  const v = doc?.[part];
  if (!v) return null;
  // inline: Mongo hands a stored Buffer back as a Binary wrapper, so this is
  // asBytes() and not Buffer.isBuffer (the same mistake twice in one feature is
  // the reason it lives in exactly one helper)
  if (!isFileRef(v)) return asBytes(v);
  const chunks = [];
  for await (const c of await store.read(v)) chunks.push(c);
  return Buffer.concat(chunks);
}
