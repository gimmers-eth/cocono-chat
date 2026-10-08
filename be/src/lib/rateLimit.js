// Fixed-window rate limiter on Redis.
// The counter is created atomically with its TTL (SET NX EX) before the INCR:
// a plain INCR-then-EXPIRE pair could crash in between and leave a key with no
// TTL, rate-limiting that subject forever.
//
// ---- server-wide kill switch ----
// buildApp() wires a gate that decides, per call, whether limits apply at all:
//   • RATE_LIMITS_DISABLED=true at boot = hard off (no reads, dev experiments)
//   • settings doc {_id:'traffic'}.rateLimitsDisabled = RUNTIME switch, flipped
//     by the admin API (checked lazily, cached 5s; admin writes invalidate
//     instantly in-process, peers follow within the TTL). Used by
//     ops/fake-users to generate bulk traffic without tripping the guards.
// Gate unwired (the admin app process, raw unit use) = limits always ON — the
// kill switch never accidentally disables the admin surface's own guards.
let gate = null;
let gateCache = { at: 0, off: false };

export function setRateLimitsGate(fn) {
  gate = fn;
  invalidateRateLimitsGate();
}

export function invalidateRateLimitsGate() {
  gateCache = { at: 0, off: false };
}

async function limitsDisabled() {
  if (!gate) return false;
  if (Date.now() - gateCache.at > 5000) {
    let off = false;
    try { off = await gate() === true; } catch { off = false; }
    gateCache = { at: Date.now(), off };
  }
  return gateCache.off;
}

export async function rateLimit(redis, key, limit, windowSec) {
  if (await limitsDisabled()) return { ok: true, retryAfterSec: 0 };
  await redis.set(key, 0, { EX: windowSec, NX: true });
  const count = await redis.incr(key);
  if (count <= limit) return { ok: true, retryAfterSec: 0 };
  const ttl = await redis.ttl(key);
  return { ok: false, retryAfterSec: Math.max(ttl, 1) };
}
