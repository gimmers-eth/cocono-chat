import { ObjectId } from 'mongodb';
import { rateLimit } from '../../lib/rateLimit.js';
import { fail, limited } from '../shared.js';

const LIST_LIMIT = 50;

// GET /api/admin/diagnostics — the reports uploaded by the app's "Send
// diagnostics" button, newest first. DELETE /api/admin/diagnostics/:id and
// /api/admin/diagnostics (purge all) to clean up.
// The admin API is already token-gated (or loopback); the limiter here just
// keeps the polling panel from hammering Mongo if it stays open.
export default async function adminDiagnosticsRoutes(app, { redis, diagnostics }) {
  const gate = async (request, reply, name, limit) => {
    const rl = await rateLimit(redis, `rl:admindiag:${name}:${request.ip}`, limit, 3600);
    return rl.ok ? null : limited(reply, rl);
  };

  app.get('/api/admin/diagnostics', async (request, reply) => {
    const denied = await gate(request, reply, 'list', 600);
    if (denied) return denied;
    const docs = await diagnostics
      .find({}, { projection: { _id: 1, ts: 1, ip: 1, ua: 1, account: 1, report: 1 } })
      .sort({ ts: -1 })
      .limit(LIST_LIMIT)
      .toArray();
    return docs.map((d) => ({ id: String(d._id), ts: d.ts, ip: d.ip, ua: d.ua, account: d.account, report: d.report }));
  });

  app.delete('/api/admin/diagnostics/:id', async (request, reply) => {
    const denied = await gate(request, reply, 'del', 200);
    if (denied) return denied;
    let oid;
    try {
      oid = new ObjectId(request.params.id);
    } catch {
      return fail(reply, 'invalid_id', 'Malformed report id', 400);
    }
    const { deletedCount } = await diagnostics.deleteOne({ _id: oid });
    if (!deletedCount) return fail(reply, 'unknown_report', 'No such report', 404);
    return { deleted: true };
  });

  app.delete('/api/admin/diagnostics', async (request, reply) => {
    const denied = await gate(request, reply, 'purge', 20);
    if (denied) return denied;
    const { deletedCount } = await diagnostics.deleteMany({});
    return { deleted: deletedCount };
  });
}
