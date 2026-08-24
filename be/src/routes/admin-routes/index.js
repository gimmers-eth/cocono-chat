import users from './users.js';
import rateLimits from './rateLimits.js';

// All admin routes. ctx = { users, redis, config }, passed through from
// admin.js.
export default async function adminRoutes(app, ctx) {
  await app.register(users, ctx);
  await app.register(rateLimits, ctx);
}
