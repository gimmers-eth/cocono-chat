import { randomBytes } from 'node:crypto';
import { b64uEncode } from '../../lib/b64u.js';
import { importRawPublicKey, verifySignature } from '../../lib/ed25519.js';
import { signJwt } from '../../lib/jwt.js';
import { rateLimit } from '../../lib/rateLimit.js';
import { isValidDeviceId, isValidUsername } from '../../lib/username.js';
import { fail, limited } from '../shared.js';
import { effectiveLimit } from '../../lib/limits.js';
import { evaluateBadges } from '../../lib/badges.js';

// POST /api/auth/challenge + POST /api/auth/verify — passwordless login.
export default async function authRoutes(app, { users, redis, config, settings }) {
  // L1 fix: always issue a nonce. A 404 here used to confirm which
  // (username, device) pairs exist; now unknown pairs get a nonce that will
  // simply never verify, indistinguishable from a real one.
  app.post('/api/auth/challenge', async (request, reply) => {
    const lim = await effectiveLimit(settings, config, 'challenge');
    const rl = await rateLimit(redis, `rl:challenge:${request.ip}`, lim.limit, lim.windowSec);
    if (!rl.ok) return limited(reply, rl);

    const { u, d } = request.body ?? {};
    if (!isValidUsername(u) || !isValidDeviceId(d)) {
      return fail(reply, 'invalid_request', 'u and d are required', 400);
    }

    const n = b64uEncode(randomBytes(32));
    await redis.set(`auth:nonce:${n}`, JSON.stringify({ ul: u.toLowerCase(), d }), { EX: config.nonceTtlSec });
    return { n };
  });

  // Sign the nonce with the device's private key, receive a JWT.
  app.post('/api/auth/verify', async (request, reply) => {
    const { u, d, n, s } = request.body ?? {};
    if (typeof u !== 'string' || typeof d !== 'string' || typeof n !== 'string') {
      return fail(reply, 'invalid_request', 'u, d and n are required', 400);
    }
    // L3 fix: validate before touching Redis, so junk subjects cannot create
    // unbounded rate-limit keys.
    if (!isValidUsername(u) || !isValidDeviceId(d)) {
      return fail(reply, 'invalid_request', 'u and d are malformed', 400);
    }

    // M1 fix: consume the nonce BEFORE counting against the account's budget.
    // Otherwise an attacker could exhaust a victim's verify allowance with
    // junk requests and lock them out of their own account for a full window.
    const ul = u.toLowerCase();
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

    const limV = await effectiveLimit(settings, config, 'verify', ul);
    const rlAccount = await rateLimit(redis, `rl:verify:${ul}`, limV.limit, limV.windowSec);
    if (!rlAccount.ok) return limited(reply, rlAccount);
    const limVI = await effectiveLimit(settings, config, 'verifyip');
    const rlIp = await rateLimit(redis, `rl:verifyip:${request.ip}`, limVI.limit, limVI.windowSec);
    if (!rlIp.ok) return limited(reply, rlIp);

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

    // login is the second badge checkpoint: accounts predating a new badge
    // get evaluated the moment they next sign in (queued, cap-safe, no await)
    evaluateBadges(users, config, ul).catch(() => {});
    const token = signJwt({ sub: ul, u: user.u, d }, config.jwtSecret, config.jwtExpiresInSec);
    return { token };
  });
}
