// Fixed-window rate limiter on Redis.
// The counter is created atomically with its TTL (SET NX EX) before the INCR:
// a plain INCR-then-EXPIRE pair could crash in between and leave a key with no
// TTL, rate-limiting that subject forever.
export async function rateLimit(redis, key, limit, windowSec) {
  await redis.set(key, 0, { EX: windowSec, NX: true });
  const count = await redis.incr(key);
  if (count <= limit) return { ok: true, retryAfterSec: 0 };
  const ttl = await redis.ttl(key);
  return { ok: false, retryAfterSec: Math.max(ttl, 1) };
}
