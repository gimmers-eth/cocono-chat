import { randomBytes, randomInt } from 'node:crypto';
import { b64uDecode, b64uEncode } from '../../lib/b64u.js';
import { canonical } from '../../lib/canon.js';
import { importRawPublicKey, importRawX25519PublicKey, verifySignature } from '../../lib/ed25519.js';
import { rateLimit } from '../../lib/rateLimit.js';
import { isValidUsername, isValidDeviceId } from '../../lib/username.js';
import { fail, limited, requireAuth, isReplayedSignature, payloadTooOld } from '../shared.js';
import { deleteAccountFully } from '../../lib/accountState.js';
import { effectiveLimit } from '../../lib/limits.js';
import { effectiveMaxDevices } from '../../lib/devicePolicy.js';

const AES_KEY_BYTES = new Set([16, 24, 32]);
const CODE_RE = /^\d{6}$/;
const ENROLL_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const CODE_DRAW_ATTEMPTS = 3;

// Device names: short, printable, human — the user's label for a physical
// device ('iPhone', 'Office Chromebook'). Empty/null clears (UIs then fall
// back to their own heuristic). Control chars stripped, ≤ 40 after trim.
const DEVICE_NAME_MAX = 40;
function sanitizeDeviceName(raw) {
  if (typeof raw !== 'string') return null;
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, DEVICE_NAME_MAX);
  return clean.length ? clean : null;
}

// Redis keys:
//   denroll:c:<ul>:<code>  pending enrollment (JSON { p, x, a, d, enrollId, requestedAt }),
//                          single-use
//   denroll:p:<enrollId>   pending marker, so the new device can poll its state
//   denroll:ok:<enrollId>  approval marker, set when a device is added

function validateDevicePayload(body) {
  const { u, p, x, a, d } = body ?? {};
  if (!isValidUsername(u)) return 'invalid_username';
  if (!isValidDeviceId(d)) return 'invalid_device_id';
  const pubRaw = b64uDecode(p);
  if (!pubRaw || pubRaw.length !== 32) return 'invalid_public_key';
  if (!importRawX25519PublicKey(x)) return 'invalid_x25519_key';
  const aesRaw = b64uDecode(a);
  if (!aesRaw || !AES_KEY_BYTES.has(aesRaw.length)) return 'invalid_aes_key';
  return null;
}

export default async function deviceRoutes(app, { users, redis, config, messages, profiles, settings, idDocs, diagnostics, shares, contacts, media }) {
  // POST /api/devices/enroll — a new device asks to join an existing account.
  // Body is shaped like signup: { u, p, a, d, t, s }, signed by the NEW
  // device's key. An already-registered device must then approve the 6-digit
  // code. (M6 fix: t + replay protection, same as signup.)
  app.post('/api/devices/enroll', async (request, reply) => {
    const lim = await effectiveLimit(settings, config, 'denroll');
    const rl = await rateLimit(redis, `rl:denroll:${request.ip}`, lim.limit, lim.windowSec);
    if (!rl.ok) return limited(reply, rl);

    const problem = validateDevicePayload(request.body);
    if (problem) return fail(reply, problem, 'Invalid enrollment payload', 400);

    const { u, p, x, a, d, t, s } = request.body;
    if (payloadTooOld(t, config.signedPayloadMaxAgeSec)) {
      return fail(reply, 'stale_payload', 'Payload timestamp missing or outside the accepted window', 400);
    }

    const publicKey = importRawPublicKey(p);
    const signedBytes = Buffer.from(canonical({ a, d, p, t, u, x }), 'utf8');
    if (!publicKey || !verifySignature(publicKey, signedBytes, s)) {
      return fail(reply, 'invalid_signature', 'Enrollment signature does not verify', 401);
    }
    if (await isReplayedSignature(redis, s, config.signedPayloadMaxAgeSec)) {
      return fail(reply, 'replay', 'Signature has already been used', 401);
    }

    const ul = u.toLowerCase();
    const user = await users.findOne({ ul });
    if (!user) return fail(reply, 'unknown_account', 'No such account', 404);
    if (user.devices.some((dev) => dev.id === d)) {
      return fail(reply, 'device_exists', 'That device is already registered', 409);
    }
    // cap is POLICY-derived (override > premium > verified > unverified) —
    // an unverified account is single-device by design
    const maxNow = effectiveMaxDevices(user, config);
    if (user.devices.length >= maxNow) {
      return fail(reply, 'device_limit', `Account already has ${user.devices.length} of ${maxNow} devices (limits rise with verification & premium)`, 409);
    }

    // L4 fix: SET NX so a drawn code can never clobber another pending
    // enrollment; re-draw on collision (vanishingly rare with 1M codes).
    const enrollId = b64uEncode(randomBytes(24));
    // the enrolling device's User-Agent, carried through to the APPROVING
    // device's review so a human sees WHICH device is knocking ('iPhone /
    // Safari', 'Windows / Chrome'…); truncated defensively
    const agent = String(request.headers['user-agent'] ?? '').slice(0, 200);
    const enrollment = JSON.stringify({
      p, x, a, d, enrollId, requestedAt: new Date().toISOString(), agent,
    });
    let code = null;
    for (let attempt = 0; attempt < CODE_DRAW_ATTEMPTS; attempt++) {
      const candidate = String(randomInt(1_000_000)).padStart(6, '0');
      const claimed = await redis.set(`denroll:c:${ul}:${candidate}`, enrollment, {
        EX: config.deviceCodeTtlSec,
        NX: true,
      });
      if (claimed) {
        code = candidate;
        break;
      }
    }
    if (!code) return fail(reply, 'enroll_busy', 'Could not allocate a pairing code — retry', 503);

    await redis.set(`denroll:p:${enrollId}`, ul, { EX: config.deviceCodeTtlSec });
    return reply.code(201).send({ code, enrollId, expiresInSec: config.deviceCodeTtlSec });
  });

  // GET /api/devices/enroll-status/:enrollId — polled by the enrolling device.
  // Unauthenticated by necessity (the device has no JWT yet); the enrollId is
  // an unguessable 192-bit capability. Generous per-IP limit because devices
  // poll every couple of seconds; the capability entropy is the real gate.
  app.get('/api/devices/enroll-status/:enrollId', async (request, reply) => {
    const lim = await effectiveLimit(settings, config, 'denrollstatus');
    const rl = await rateLimit(redis, `rl:denrollstatus:${request.ip}`, lim.limit, lim.windowSec);
    if (!rl.ok) return limited(reply, rl);

    const { enrollId } = request.params;
    if (!ENROLL_ID_RE.test(enrollId)) {
      return fail(reply, 'invalid_request', 'Malformed enrollId', 400);
    }

    if (await redis.get(`denroll:ok:${enrollId}`)) return { approved: true };
    if (await redis.get(`denroll:p:${enrollId}`)) return { approved: false };
    return fail(reply, 'expired', 'Enrollment expired or unknown', 410);
  });

  // POST /api/devices/pending — details of a pending code (JWT), so the
  // approving user can see WHAT they are approving before confirming (L6).
  app.post('/api/devices/pending', async (request, reply) => {
    const denied = requireAuth(request, reply);
    if (denied) return denied;

    const ul = request.auth.sub;
    const lim = await effectiveLimit(settings, config, 'dpending', ul);
    const rl = await rateLimit(redis, `rl:dpending:${ul}`, lim.limit, lim.windowSec);
    if (!rl.ok) return limited(reply, rl);

    const { code } = request.body ?? {};
    if (typeof code !== 'string' || !CODE_RE.test(code)) {
      return fail(reply, 'invalid_request', 'Code must be 6 digits', 400);
    }

    const raw = await redis.get(`denroll:c:${ul}:${code}`);
    if (!raw) return fail(reply, 'unknown_code', 'No pending enrollment with that code', 404);
    const { d, requestedAt, agent } = JSON.parse(raw);
    return { d, requestedAt, agent: agent ?? '' };
  });

  // POST /api/devices/approve — a registered device approves a code (JWT).
  app.post('/api/devices/approve', async (request, reply) => {
    const denied = requireAuth(request, reply);
    if (denied) return denied;

    const ul = request.auth.sub;
    const lim = await effectiveLimit(settings, config, 'dapprove', ul);
    const rl = await rateLimit(redis, `rl:dapprove:${ul}`, lim.limit, lim.windowSec);
    if (!rl.ok) return limited(reply, rl);

    const { code } = request.body ?? {};
    if (typeof code !== 'string' || !CODE_RE.test(code)) {
      return fail(reply, 'invalid_request', 'Code must be 6 digits', 400);
    }

    // Codes are scoped per account; GETDEL makes approval single-use.
    const raw = await redis.getDel(`denroll:c:${ul}:${code}`);
    if (!raw) return fail(reply, 'unknown_code', 'No pending enrollment with that code', 404);
    const { p, x, a, d, enrollId } = JSON.parse(raw);
    // optional human name chosen AT APPROVAL TIME for the joining device
    // (the approver knows what the new device is — 'Old phone', 'Work iPad')
    const name = sanitizeDeviceName(request.body?.name);

    const user = await users.findOne({ ul });
    if (!user) return fail(reply, 'unknown_account', 'Account not found', 404);
    const approveMaxNow = effectiveMaxDevices(user, config);

    const now = new Date();
    // Atomic: only push if the device is new and the cap is not yet reached.
    const res = await users.updateOne(
      {
        ul,
        'devices.id': { $ne: d },
        // literal, policy-derived: '$maxDevices' is no longer the source of
        // truth (the stored field is legacy); the atomicity stays
        $expr: { $lt: [{ $size: '$devices' }, approveMaxNow] },
      },
      { $push: { devices: { id: d, pub: p, x, aes: a, createdAt: now, lastSeenAt: now, ...(name ? { name } : {}) } } },
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
      maxDevices: effectiveMaxDevices(user, config),
      devices: user.devices.map((dev) => ({
        id: dev.id,
        current: dev.id === request.auth.d,
        name: dev.name ?? null,
        createdAt: dev.createdAt,
        lastSeenAt: dev.lastSeenAt,
      })),
    };
  });

  // PUT /api/devices/self — the device's own status report (JWT): right now
  // only whether the PWA is INSTALLED (running standalone, added to the
  // home screen) on it. The SDK fires this best-effort whenever a WS session
  // opens, so the flag ages with real use; a browser-tab session reports
  // false, and a non-browser (test/Node) device reports NOTHING — unknown
  // stays unknown. Device-scoped by the token: a caller can only ever
  // update its OWN device row. The limiter is generous (every reconnect
  // re-reports) — it gates scripted spam, not usage.
  app.put('/api/devices/self', async (request, reply) => {
    const denied = requireAuth(request, reply);
    if (denied) return denied;
    const ul = request.auth.sub;
    const lim = await effectiveLimit(settings, config, 'dself', ul);
    const rl = await rateLimit(redis, `rl:dself:${ul}`, lim.limit, lim.windowSec);
    if (!rl.ok) return limited(reply, rl);

    const installed = request.body?.installed;
    if (typeof installed !== 'boolean') {
      return fail(reply, 'invalid_request', 'installed must be a boolean', 400);
    }
    const res = await users.updateOne(
      { ul, 'devices.id': request.auth.d },
      { $set: { 'devices.$.installed': installed, 'devices.$.installedAt': new Date() } },
    );
    if (!res.matchedCount) return fail(reply, 'unknown_device', 'No such device on this account', 404);
    return { updated: request.auth.d, installed };
  });

  // PUT /api/devices/:deviceId/name — rename a device on THIS account
  // (Settings > Devices). Body { name }: 1..40 printable chars; empty
  // clears the label. Shares the device-approval budget (both are rare
  // device-management actions).
  app.put('/api/devices/:deviceId/name', async (request, reply) => {
    const denied = requireAuth(request, reply);
    if (denied) return denied;
    const ul = request.auth.sub;
    const lim = await effectiveLimit(settings, config, 'dapprove', ul);
    const rl = await rateLimit(redis, `rl:dapprove:${ul}`, lim.limit, lim.windowSec);
    if (!rl.ok) return limited(reply, rl);

    const deviceId = request.params.deviceId;
    if (!isValidDeviceId(deviceId)) return fail(reply, 'invalid_device_id', 'Malformed device id', 400);
    const raw = request.body?.name;
    if (typeof raw !== 'string') return fail(reply, 'invalid_request', 'name must be a string', 400);
    // strict here (unlike the silent clamp at approval): a rename must not
    // silently mutate what the user typed — over-length bounces as 400
    const name = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (!name || name.length > DEVICE_NAME_MAX) {
      return fail(reply, 'invalid_name', `Device name needs 1-${DEVICE_NAME_MAX} characters`, 400);
    }

    const res = await users.updateOne({ ul, 'devices.id': deviceId }, { $set: { 'devices.$.name': name } });
    if (!res.matchedCount) return fail(reply, 'unknown_device', 'No such device on this account', 404);
    return { renamed: deviceId, name };
  });

  // DELETE /api/devices/:deviceId — detach one device from the account.
  // Callable by any signed-in device, INCLUDING the device itself ("remove
  // this browser" on the login screen). Removing the LAST device deletes the
  // account outright (doc, queues, Redis state) — no orphan rows, and the
  // username becomes free again.
  app.delete('/api/devices/:deviceId', async (request, reply) => {
    const denied = requireAuth(request, reply);
    if (denied) return denied;
    const deviceId = request.params.deviceId;
    if (!isValidDeviceId(deviceId)) return fail(reply, 'invalid_device_id', 'Malformed device id', 400);

    const ul = request.auth.sub;
    const lim = await effectiveLimit(settings, config, 'dremove', ul);
    const rl = await rateLimit(redis, `rl:dremove:${ul}`, lim.limit, lim.windowSec);
    if (!rl.ok) return limited(reply, rl);

    const result = await users.updateOne(
      { ul, 'devices.id': deviceId },
      { $pull: { devices: { id: deviceId } } },
    );
    if (result.modifiedCount === 0) return fail(reply, 'unknown_device', 'No such device on this account', 404);

    await messages.deleteMany({ 'to.ul': ul, 'to.dv': deviceId });
    const user = await users.findOne({ ul }, { projection: { devices: 1 } });
    // Last device leaving => the account is deleted outright (no orphaned
    // docs, no reserved usernames); its queues and Redis state are swept.
    if (user.devices.length === 0) {
      // full teardown incl. ID photo, diagnostics and OTHERS' blocks/
      // blockReasons aimed at this name (the old inline purge missed those)
      await deleteAccountFully({ users, profiles, idDocs, messages, diagnostics, settings, redis, shares, contacts, media }, ul);
      return { removed: deviceId, devices: 0, accountDeleted: true };
    }
    return { removed: deviceId, devices: user.devices.length };
  });

  // PUT /api/devices/push-subscription — store this device's Web Push
  // subscription (blind notifications; endpoint is an https URL at a push
  // service, keys are the browser-generated P-256/p256dh pair). The push
  // subscription is device-scoped and sent over the device's own JWT, so it
  // can only ever overwrite the caller's device.
  app.put('/api/devices/push-subscription', async (request, reply) => {
    const denied = requireAuth(request, reply);
    if (denied) return denied;

    const { endpoint, keys } = request.body ?? {};
    if (
      typeof endpoint !== 'string' || !endpoint.startsWith('https://') || endpoint.length > 2048 ||
      typeof keys?.p256dh !== 'string' || keys.p256dh.length > 1024 ||
      typeof keys.auth !== 'string' || keys.auth.length > 1024
    ) {
      return fail(reply, 'invalid_subscription', 'endpoint (https) and keys {p256dh, auth} are required', 400);
    }

    const res = await users.updateOne(
      { ul: request.auth.sub, 'devices.id': request.auth.d },
      { $set: { 'devices.$.push': { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, updatedAt: new Date() } } },
    );
    if (res.matchedCount === 0) return fail(reply, 'unknown_device', 'No such device on this account', 404);
    return { subscribed: true };
  });

  // DELETE /api/devices/push-subscription — stop pushing to this device
  // (also what a 'gone' push-service response triggers server-side).
  app.delete('/api/devices/push-subscription', async (request, reply) => {
    const denied = requireAuth(request, reply);
    if (denied) return denied;
    await users.updateOne(
      { ul: request.auth.sub, 'devices.id': request.auth.d },
      { $unset: { 'devices.$.push': '' } },
    );
    return { subscribed: false };
  });
}
