import { randomBytes } from 'node:crypto';
import { b64uEncode } from '../../lib/b64u.js';
import { importRawPublicKey, verifySignature } from '../../lib/ed25519.js';
import { signJwt } from '../../lib/jwt.js';
import { rateLimit } from '../../lib/rateLimit.js';
import { fail, limited } from '../shared.js';

// POST /api/auth/challenge + POST /api/auth/verify — passwordless login.
export default async function authRoutes(app, { users, redis, config }) {
  app.post('/api/auth/challenge', async (request, reply) => {
    const rl = await rateLimit(redis, `rl:challenge:${request.ip}`, config.challengeIpLimit, config.challengeIpWindowSec);
    if (!rl.ok) return limited(reply, rl);

    const { u, d } = request.body ?? {};
    if (typeof u !== 'string' || typeof d !== 'string') {
      return fail(reply, 'invalid_request', 'u and d are required', 400);
    }

    const user = await users.findOne({ ul: u.toLowerCase() });
    if (!user || !user.devices.some((dev) => dev.id === d)) {
      return fail(reply, 'unknown_account', 'No such account/device', 404);
    }

    const n = b64uEncode(randomBytes(32));
    await redis.set(`auth:nonce:${n}`, JSON.stringify({ ul: user.ul, d }), { EX: config.nonceTtlSec });
    return { n };
  });

  // Sign the nonce with the device's private key, receive a JWT.
  app.post('/api/auth/verify', async (request, reply) => {
    const { u, d, n, s } = request.body ?? {};
    if (typeof u !== 'string' || typeof d !== 'string' || typeof n !== 'string') {
      return fail(reply, 'invalid_request', 'u, d and n are required', 400);
    }

    const ul = u.toLowerCase();
    const rl = await rateLimit(redis, `rl:verify:${ul}`, config.verifyAccountLimit, config.verifyAccountWindowSec);
    if (!rl.ok) return limited(reply, rl);

    const raw = await redis.getDel(`auth:nonce:${n}`);
    let nonce;
    try {
      nonce = raw ? JSON.parse(raw) : null;
    } catch {
      nonce = null;
    }
    if (!nonce || nonce.ul !== ul || nonce.d !== d) {
      return fail(reply, 'bad_nonce', 'Nonce unknown, expired or mismatched', 401);
    }

    const user = await users.findOne({ ul });
    const device = user?.devices.find((dev) => dev.id === d);
    const publicKey = device ? importRawPublicKey(device.pub) : null;
    if (!publicKey || !verifySignature(publicKey, Buffer.from(n, 'utf8'), s)) {
      return fail(reply, 'bad_signature', 'Nonce signature does not verify', 401);
    }

    await users.updateOne(
      { ul, 'devices.id': d },
      { $set: { 'devices.$.lastSeenAt': new Date() } },
    );

    const token = signJwt({ sub: ul, u: user.u, d }, config.jwtSecret, config.jwtExpiresInSec);
    return { token };
  });
}
