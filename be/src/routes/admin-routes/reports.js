import { ObjectId } from 'mongodb';
import { rateLimit } from '../../lib/rateLimit.js';
import { fail, limited } from '../shared.js';

const LIST_LIMIT = 50;
const MAX_TRANSCRIPT = 500; // matches the app route's cap (reports.js)

// GET /api/admin/reports — abuse reports uploaded by the app's "Report
// user" action (chat menu), newest first. Each carries the reporter's
// reason + description and the transcript the reporter chose to share
// (plaintext — the client warns before sending). DELETE /:id closes a
// single report, DELETE / purges all. Same posture as diagnostics: the
// admin API is token-gated (or loopback); the limiter just keeps the
// 10 s polling panel from hammering Mongo.
export default async function adminReportsRoutes(app, { redis, reports }) {
  const gate = async (request, reply, name, limit) => {
    const rl = await rateLimit(redis, `rl:adminreports:${name}:${request.ip}`, limit, 3600);
    return rl.ok ? null : limited(reply, rl);
  };

  app.get('/api/admin/reports', async (request, reply) => {
    const denied = await gate(request, reply, 'list', 600);
    if (denied) return denied;
    const docs = await reports
      .find({}, { projection: { _id: 1, ts: 1, ip: 1, ua: 1, account: 1, peer: 1, reason: 1, description: 1, blocked: 1, messages: 1 } })
      .sort({ ts: -1 })
      .limit(LIST_LIMIT)
      .toArray();
    return docs.map((d) => ({
      id: String(d._id),
      ts: d.ts,
      ip: d.ip,
      ua: d.ua,
      account: d.account,
      peer: d.peer,
      reason: d.reason,
      description: d.description,
      blocked: d.blocked === true,
      messages: (d.messages ?? []).slice(0, MAX_TRANSCRIPT),
    }));
  });

  app.delete('/api/admin/reports/:id', async (request, reply) => {
    const denied = await gate(request, reply, 'del', 200);
    if (denied) return denied;
    let oid;
    try {
      oid = new ObjectId(request.params.id);
    } catch {
      return fail(reply, 'invalid_id', 'Malformed report id', 400);
    }
    const { deletedCount } = await reports.deleteOne({ _id: oid });
    if (!deletedCount) return fail(reply, 'unknown_report', 'No such report', 404);
    return { deleted: true };
  });

  app.delete('/api/admin/reports', async (request, reply) => {
    const denied = await gate(request, reply, 'purge', 20);
    if (denied) return denied;
    const { deletedCount } = await reports.deleteMany({});
    return { deleted: deletedCount };
  });
}
