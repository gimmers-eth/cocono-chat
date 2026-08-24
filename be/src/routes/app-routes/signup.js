import { b64uDecode } from '../../lib/b64u.js';
import { canonical } from '../../lib/canon.js';
import { importRawPublicKey, verifySignature } from '../../lib/ed25519.js';
import { rateLimit } from '../../lib/rateLimit.js';
import { isValidUsername, isValidDeviceId, isReserved } from '../../lib/username.js';
import { fail, limited } from '../shared.js';

const AES_KEY_BYTES = new Set([16, 24, 32]);

// POST /api/signup — create an account with the first device.
// Body: { u, p, a, d, s } where s is the Ed25519 signature over
// canonical({ a, d, p, u }).
export default async function signupRoutes(app, { users, redis, config }) {
  app.post('/api/signup', async (request, reply) => {
    const rl = await rateLimit(redis, `rl:signup:${request.ip}`, config.signupIpLimit, config.signupIpWindowSec);
    if (!rl.ok) return limited(reply, rl);

    const { u, p, a, d, s } = request.body ?? {};

    if (!isValidUsername(u)) {
      return fail(reply, 'invalid_username', 'Username must be 5+ chars of [a-zA-Z0-9_-]', 400);
    }
    if (isReserved(u, config.reservedUsernames)) {
      return fail(reply, 'reserved_username', 'That username is reserved', 400);
    }
    if (!isValidDeviceId(d)) {
      return fail(reply, 'invalid_device_id', 'Device id must be 8-64 chars of [a-zA-Z0-9_-]', 400);
    }
    const pubRaw = b64uDecode(p);
    if (!pubRaw || pubRaw.length !== 32) {
      return fail(reply, 'invalid_public_key', 'Public key must be 32 raw bytes, base64url', 400);
    }
    const aesRaw = b64uDecode(a);
    if (!aesRaw || !AES_KEY_BYTES.has(aesRaw.length)) {
      return fail(reply, 'invalid_aes_key', 'AES key must be 16/24/32 raw bytes, base64url', 400);
    }
    const publicKey = importRawPublicKey(p);
    if (!publicKey) {
      return fail(reply, 'invalid_public_key', 'Public key could not be imported', 400);
    }

    const signedBytes = Buffer.from(canonical({ a, d, p, u }), 'utf8');
    if (!verifySignature(publicKey, signedBytes, s)) {
      return fail(reply, 'invalid_signature', 'Signup signature does not verify', 401);
    }

    const now = new Date();
    try {
      await users.insertOne({
        u,
        ul: u.toLowerCase(),
        devices: [{ id: d, pub: p, aes: a, main: true, createdAt: now, lastSeenAt: now }],
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
