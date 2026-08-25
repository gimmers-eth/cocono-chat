// Response helpers shared by all route modules.
import { createHash } from 'node:crypto';

export function fail(reply, code, message, status) {
  return reply.code(status).send({ error: code, message });
}

export function limited(reply, result) {
  reply.header('retry-after', String(result.retryAfterSec));
  return fail(reply, 'rate_limited', 'Too many requests', 429);
}

// For routes that require a valid JWT (request.auth is set by the app-level
// bearer-token hook). Returns an error response to send, or null when authed.
export function requireAuth(request, reply) {
  if (!request.auth) return fail(reply, 'unauthorized', 'Missing or invalid token', 401);
  return null;
}

// M4 fix: strict same-origin security headers. Both the FE and the admin UI
// are fully same-origin apps, so a strict CSP is cheap; the admin panel's
// styles live in a file (no inline <style>) to keep style-src strict too.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
].join('; ');

export function registerSecurityHeaders(app) {
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('content-security-policy', CSP);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
  });
}

// M6 fix: signed payloads carry a client timestamp `t` (epoch seconds).
export function payloadTooOld(t, maxAgeSec) {
  if (typeof t !== 'number' || !Number.isFinite(t)) return true;
  return Math.abs(Math.floor(Date.now() / 1000) - t) > maxAgeSec;
}

// M6 fix: reject replayed signatures. A signature can only ever be valid for
// one payload, so deduping on its hash within 2x the freshness window is safe.
export async function isReplayedSignature(redis, signature, maxAgeSec) {
  const digest = createHash('sha256').update(String(signature)).digest('hex');
  const fresh = await redis.set(`sigseen:${digest}`, '1', { NX: true, EX: maxAgeSec * 2 });
  return !fresh;
}
