// Response helpers shared by all route modules.

export function fail(reply, code, message, status) {
  return reply.code(status).send({ error: code, message });
}

export function limited(reply, result) {
  reply.header('retry-after', String(result.retryAfterSec));
  return fail(reply, 'rate_limited', 'Too many requests', 429);
}
