import { fail } from '../shared.js';

function requireAuth(request, reply) {
  if (!request.auth) return fail(reply, 'unauthorized', 'Missing or invalid token', 401);
  return null;
}

// GET /api/me — who am I (smoke test for JWT auth; grows later).
export default async function meRoutes(app, { users }) {
  app.get('/api/me', async (request, reply) => {
    const denied = requireAuth(request, reply);
    if (denied) return denied;

    const user = await users.findOne({ ul: request.auth.sub });
    if (!user) return fail(reply, 'unknown_account', 'Account not found', 404);
    return { u: user.u, d: request.auth.d, createdAt: user.createdAt };
  });
}
