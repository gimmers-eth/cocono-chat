import { b64uDecode } from '../../lib/b64u.js';
import { canonical } from '../../lib/canon.js';
import { importRawPublicKey, importRawX25519PublicKey, verifySignature } from '../../lib/ed25519.js';
import { rateLimit } from '../../lib/rateLimit.js';
import { isValidUsername, isValidDeviceId, isReserved } from '../../lib/username.js';
import { fail, limited, isReplayedSignature, payloadTooOld } from '../shared.js';

const AES_KEY_BYTES = new Set([16, 24, 32]);

// POST /api/signup — create an account with the first device.
// Body: { u, p, x, a, d, t, s } where p is the Ed25519 public key, x the
// X25519 key-agreement public key (milestone 3), t a client epoch-seconds
// timestamp, and s the Ed25519 signature over canonical({ a, d, p, t, u, x })
// (M6 fix: freshness + replay protection).
export default async function signupRoutes(app, { users, redis, config }) {
  app.post('/api/signup', async (request, reply) => {
    const rl = await rateLimit(redis, `rl:signup:${request.ip}`, config.signupIpLimit, config.signupIpWindowSec);
    if (!rl.ok) return limited(reply, rl);

    const { u, p, x, a, d, t, s } = request.body ?? {};

    if (!isValidUsername(u)) {
      return fail(reply, 'invalid_username', 'Username must be 5-64 chars of [a-zA-Z0-9_-]', 400);
    }
    if (isReserved(u, config.reservedUsernames)) {
      return fail(reply, 'reserved_username', 'That username is reserved', 400);
    }
    if (!isValidDeviceId(d)) {
      return fail(reply, 'invalid_device_id', 'Device id must be 8-64 chars of [a-zA-Z0-9_-]', 400);
    }
    if (payloadTooOld(t, config.signedPayloadMaxAgeSec)) {
      return fail(reply, 'stale_payload', 'Payload timestamp missing or outside the accepted window', 400);
    }
    const pubRaw = b64uDecode(p);
    if (!pubRaw || pubRaw.length !== 32) {
      return fail(reply, 'invalid_public_key', 'Public key must be 32 raw bytes, base64url', 400);
    }
    if (!importRawX25519PublicKey(x)) {
      return fail(reply, 'invalid_x25519_key', 'X25519 public key must be 32 raw bytes, base64url', 400);
    }
    const aesRaw = b64uDecode(a);
    if (!aesRaw || !AES_KEY_BYTES.has(aesRaw.length)) {
      return fail(reply, 'invalid_aes_key', 'AES key must be 16/24/32 raw bytes, base64url', 400);
    }
    const publicKey = importRawPublicKey(p);
    if (!publicKey) {
      return fail(reply, 'invalid_public_key', 'Public key could not be imported', 400);
    }

    const signedBytes = Buffer.from(canonical({ a, d, p, t, u, x }), 'utf8');
    if (!verifySignature(publicKey, signedBytes, s)) {
      return fail(reply, 'invalid_signature', 'Signup signature does not verify', 401);
    }
    if (await isReplayedSignature(redis, s, config.signedPayloadMaxAgeSec)) {
      return fail(reply, 'replay', 'Signature has already been used', 401);
    }

    const now = new Date();
    try {
      await users.insertOne({
        u,
        ul: u.toLowerCase(),
        devices: [{ id: d, pub: p, x, aes: a, main: true, createdAt: now, lastSeenAt: now }],
        maxDevices: config.maxDevicesDefault,
        createdAt: now,
      });
    } catch (err) {
      if (err?.code === 11000) {
        return fail(reply, 'username_taken', 'Username already registered', 409);
      }
      throw err;
    }

    return reply.code(201).send({ u });
  });
}
