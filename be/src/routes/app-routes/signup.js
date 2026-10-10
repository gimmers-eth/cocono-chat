import { b64uDecode } from '../../lib/b64u.js';
import { canonical } from '../../lib/canon.js';
import { importRawPublicKey, importRawX25519PublicKey, verifySignature } from '../../lib/ed25519.js';
import { rateLimit } from '../../lib/rateLimit.js';
import { isValidUsername, isValidDeviceId, isReserved } from '../../lib/username.js';
import { evaluateBadges } from '../../lib/badges.js';
import { recordReferral, shareableName } from '../../lib/shares.js';
import { fail, limited, isReplayedSignature, payloadTooOld } from '../shared.js';
import { effectiveLimit } from '../../lib/limits.js';

const AES_KEY_BYTES = new Set([16, 24, 32]);

// POST /api/signup — create an account with the first device.
// Body: { u, p, x, a, d, t, s } where p is the Ed25519 public key, x the
// X25519 key-agreement public key (milestone 3), t a client epoch-seconds
// timestamp, and s the Ed25519 signature over canonical({ a, d, p, t, u, x })
// (M6 fix: freshness + replay protection).
// Optional UNSIGNED `r`: the username whose share link (`/?chat=<r>`) this
// signup followed — the account's parent. Kept out of the signature on
// purpose (widening it would break every shipped client) and worth no
// reward, so the worst a lying client can do is mislabel its own origin in
// the admin Shares tab / God View. See lib/shares.js.
export default async function signupRoutes(app, { users, redis, config, settings , counters, shares}) {
  app.post('/api/signup', async (request, reply) => {
    const lim = await effectiveLimit(settings, config, 'signup');
    const rl = await rateLimit(redis, `rl:signup:${request.ip}`, lim.limit, lim.windowSec);
    if (!rl.ok) return limited(reply, rl);

    const { u, p, x, a, d, t, s } = request.body ?? {};

    if (!isValidUsername(u)) {
      return fail(reply, 'invalid_username', 'Username must be 4-64 chars of [a-zA-Z0-9_-]', 400);
    }
    if (isReserved(u, config.reservedUsernames, config.reservedUsernamePrefixes)) {
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
    // Usernames are normalised to lowercase at account creation. The signature
    // above is checked against the `u` as sent, so older clients that sign
    // mixed-case input keep working.
    const ul = u.toLowerCase();
    // The share link this signup arrived from (optional, unsigned — see the
    // header note). Junk, self-referrals and unknown usernames are dropped:
    // attribution must never fail a signup, so nothing here throws outward.
    const referrer = shareableName(request.body?.r);
    const ref = referrer && referrer !== ul ? { by: referrer, at: now } : null;
    if (referrer && !ref) request.log.info(`[shares] signup @${ul}: ignored referral '${referrer}'`);
    try {
      await users.insertOne({
        u: ul,
        ul,
        // ACCOUNT identity anchor: the founder device's Ed25519 key, frozen
        // for the account's lifetime (devices may come and go; a
        // re-registered username gets a NEW identity). Friend trust bindings
        // reference this value — see routes/app-routes/friends.js.
        identity: { d, p, createdAt: now },
        devices: [{ id: d, pub: p, x, aes: a, createdAt: now, lastSeenAt: now }],
        maxDevices: config.maxDevicesDefault,
        // parent: whose share link created this account (null = organic).
        // Written at creation and never changed — it is the account's origin
        // story, and the God View's solid 'created' edges come from it.
        ...(ref ? { ref } : {}),
        createdAt: now,
      });
    } catch (err) {
      if (err?.code === 11000) {
        return fail(reply, 'username_taken', 'Username already registered', 409);
      }
      throw err;
    }

    // Badge eligibility evaluated the moment the account exists — queued
    // serially so the ten OG seats / 1000 early-bird seats can never be
    // double-booked. Never blocks or fails the signup itself.
    evaluateBadges(users, config, ul, counters).catch(() => {});
    // The owner side of the same fact: a 'created' edge in the shares graph.
    // AWAITED (unlike the badge queue) so the referral is durable by the time
    // the client gets its 201 — but still unable to fail the signup: the
    // account exists, and a bookkeeping write must not orphan it.
    if (ref) {
      await recordReferral(shares, { owner: ref.by, viewer: ul, now })
        .catch((err) => request.log.warn(`[shares] referral ${ref.by} -> ${ul} not recorded: ${err.message}`));
    }
    return reply.code(201).send({ u: ul, ...(ref ? { ref: ref.by } : {}) });
  });
}
