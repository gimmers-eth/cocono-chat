import users from './users.js';
import rateLimits from './rateLimits.js';
import diagnostics from './diagnostics.js';
import branding from './branding.js';

// All admin routes. ctx = { users, redis, config, diagnostics, settings,
// messages }, passed through from admin.js.
export default async function adminRoutes(app, ctx) {
  await app.register(users, ctx);
  await app.register(rateLimits, ctx);
  await app.register(diagnostics, ctx);
  await app.register(branding, ctx);
}
