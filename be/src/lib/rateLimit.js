// Sliding-window-ish rate limiter on Redis: INCR + EXPIRE on first hit.
export async function rateLimit(redis, key, limit, windowSec) {
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSec);
  if (count <= limit) return { ok: true, retryAfterSec: 0 };
  const ttl = await redis.ttl(key);
  return { ok: false, retryAfterSec: Math.max(ttl, 1) };
}
