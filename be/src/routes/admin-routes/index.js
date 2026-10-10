import users from './users.js';
import rateLimits from './rateLimits.js';
import limits from './limits.js';
import diagnostics from './diagnostics.js';
import reports from './reports.js';
import branding from './branding.js';
import ops from './ops.js';
import graph from './graph.js';

// All admin routes. ctx = { users, redis, config, diagnostics, reports,
// settings, messages, shares, contacts, graph, media }, passed through from admin.js.
export default async function adminRoutes(app, ctx) {
  await app.register(users, ctx);
  await app.register(rateLimits, ctx);
  await app.register(limits, ctx);
  await app.register(diagnostics, ctx);
  await app.register(reports, ctx);
  await app.register(branding, ctx);
  await app.register(graph, ctx);
  await app.register(ops, ctx);
}
