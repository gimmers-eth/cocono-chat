// Response helpers shared by all route modules.

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
