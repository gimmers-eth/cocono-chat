import { randomBytes, randomInt } from 'node:crypto';
import { b64uDecode, b64uEncode } from '../../lib/b64u.js';
import { canonical } from '../../lib/canon.js';
import { importRawPublicKey, verifySignature } from '../../lib/ed25519.js';
import { rateLimit } from '../../lib/rateLimit.js';
import { isValidUsername, isValidDeviceId } from '../../lib/username.js';
import { fail, limited, requireAuth } from '../shared.js';

const AES_KEY_BYTES = new Set([16, 24, 32]);
const CODE_RE = /^\d{6}$/;
const ENROLL_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

// Redis keys:
//   denroll:c:<ul>:<code>  pending enrollment (JSON { p, a, d, enrollId }), single-use
//   denroll:p:<enrollId>   pending marker, so the new device can poll its state
//   denroll:ok:<enrollId>  approval marker, set when a device is added

function validateDevicePayload(body) {
  const { u, p, a, d } = body ?? {};
  if (!isValidUsername(u)) return 'invalid_username';
  if (!isValidDeviceId(d)) return 'invalid_device_id';
  const pubRaw = b64uDecode(p);
  if (!pubRaw || pubRaw.length !== 32) return 'invalid_public_key';
  const aesRaw = b64uDecode(a);
  if (!aesRaw || !AES_KEY_BYTES.has(aesRaw.length)) return 'invalid_aes_key';
  return null;
}

export default async function deviceRoutes(app, { users, redis, config }) {
  // POST /api/devices/enroll — a new device asks to join an existing account.
  // Body is shaped like signup: { u, p, a, d, s }, signed by the NEW device's
  // key. An already-registered device must then approve the 6-digit code.
  app.post('/api/devices/enroll', async (request, reply) => {
    const rl = await rateLimit(redis, `rl:denroll:${request.ip}`, config.deviceEnrollIpLimit, config.deviceEnrollIpWindowSec);
    if (!rl.ok) return limited(reply, rl);

    const problem = validateDevicePayload(request.body);
    if (problem) return fail(reply, problem, 'Invalid enrollment payload', 400);

    const { u, p, a, d, s } = request.body;
    const publicKey = importRawPublicKey(p);
    const signedBytes = Buffer.from(canonical({ a, d, p, u }), 'utf8');
    if (!publicKey || !verifySignature(publicKey, signedBytes, s)) {
      return fail(reply, 'invalid_signature', 'Enrollment signature does not verify', 401);
    }

    const ul = u.toLowerCase();
    const user = await users.findOne({ ul });
    if (!user) return fail(reply, 'unknown_account', 'No such account', 404);
    if (user.devices.some((dev) => dev.id === d)) {
      return fail(reply, 'device_exists', 'That device is already registered', 409);
    }
    if (user.devices.length >= user.maxDevices) {
      return fail(reply, 'device_limit', `Account already has ${user.maxDevices} devices`, 409);
    }

    const code = String(randomInt(1_000_000)).padStart(6, '0');
    const enrollId = b64uEncode(randomBytes(24));
    await Promise.all([
      redis.set(`denroll:c:${ul}:${code}`, JSON.stringify({ p, a, d, enrollId }), { EX: config.deviceCodeTtlSec }),
      redis.set(`denroll:p:${enrollId}`, ul, { EX: config.deviceCodeTtlSec }),
    ]);

    return reply.code(201).send({ code, enrollId, expiresInSec: config.deviceCodeTtlSec });
  });

  // GET /api/devices/enroll-status/:enrollId — polled by the enrolling device.
  // Unauthenticated by necessity (the device has no JWT yet); the enrollId is
  // an unguessable 192-bit capability.
  app.get('/api/devices/enroll-status/:enrollId', async (request, reply) => {
    const { enrollId } = request.params;
    if (!ENROLL_ID_RE.test(enrollId)) {
      return fail(reply, 'invalid_request', 'Malformed enrollId', 400);
    }

    if (await redis.get(`denroll:ok:${enrollId}`)) return { approved: true };
    if (await redis.get(`denroll:p:${enrollId}`)) return { approved: false };
    return fail(reply, 'expired', 'Enrollment expired or unknown', 410);
  });

  // POST /api/devices/approve — a registered device approves a code (JWT).
  app.post('/api/devices/approve', async (request, reply) => {
    const denied = requireAuth(request, reply);
    if (denied) return denied;

    const ul = request.auth.sub;
    const rl = await rateLimit(redis, `rl:dapprove:${ul}`, config.deviceApproveAccountLimit, config.deviceApproveAccountWindowSec);
    if (!rl.ok) return limited(reply, rl);

    const { code } = request.body ?? {};
    if (typeof code !== 'string' || !CODE_RE.test(code)) {
      return fail(reply, 'invalid_request', 'Code must be 6 digits', 400);
    }

    // Codes are scoped per account; GETDEL makes approval single-use.
    const raw = await redis.getDel(`denroll:c:${ul}:${code}`);
    if (!raw) return fail(reply, 'unknown_code', 'No pending enrollment with that code', 404);
    const { p, a, d, enrollId } = JSON.parse(raw);

    const user = await users.findOne({ ul });
    if (!user) return fail(reply, 'unknown_account', 'Account not found', 404);

    const now = new Date();
    // Atomic: only push if the device is new and the cap is not yet reached.
    const res = await users.updateOne(
      {
        ul,
        'devices.id': { $ne: d },
        $expr: { $lt: [{ $size: '$devices' }, '$maxDevices'] },
      },
      { $push: { devices: { id: d, pub: p, aes: a, main: false, createdAt: now, lastSeenAt: now } } },
    );
    if (!res.matchedCount) {
      const fresh = await users.findOne({ ul });
      if (fresh?.devices.some((dev) => dev.id === d)) {
        return fail(reply, 'device_exists', 'That device is already registered', 409);
      }
      return fail(reply, 'device_limit', 'Device limit reached', 409);
    }

    await Promise.all([
      redis.del(`denroll:p:${enrollId}`),
      redis.set(`denroll:ok:${enrollId}`, '1', { EX: config.deviceCodeTtlSec }),
    ]);
    return { approved: d };
  });

  // GET /api/devices — the authenticated user's devices (JWT).
  app.get('/api/devices', async (request, reply) => {
    const denied = requireAuth(request, reply);
    if (denied) return denied;

    const user = await users.findOne({ ul: request.auth.sub });
    if (!user) return fail(reply, 'unknown_account', 'Account not found', 404);
    return {
      maxDevices: user.maxDevices,
      devices: user.devices.map((dev) => ({
        id: dev.id,
        main: dev.main ?? false,
        current: dev.id === request.auth.d,
        createdAt: dev.createdAt,
        lastSeenAt: dev.lastSeenAt,
      })),
    };
  });
}
