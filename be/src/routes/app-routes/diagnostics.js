import { rateLimit } from '../../lib/rateLimit.js';
import { fail, limited } from '../shared.js';
import { effectiveLimit } from '../../lib/limits.js';

const MAX_REPORT_LEN = 16 * 1024;

// POST /api/diagnostics — the app's "Send diagnostics" button. A text
// snapshot of client state (origin, storage contents, quota) is stored so
// devices without a web inspector (phones) can still report their condition.
// Works signed (JWT attached when present) or anonymous — problems before
// login are exactly the ones worth reporting — so the per-IP rate limit is
// the spam gate, plus a size cap and TTL on the collection.
export default async function diagnosticsRoutes(app, { redis, config, diagnostics, settings }) {
  app.post('/api/diagnostics', async (request, reply) => {
    const lim = await effectiveLimit(settings, config, 'diag');
    const rl = await rateLimit(redis, `rl:diag:${request.ip}`, lim.limit, lim.windowSec);
    if (!rl.ok) return limited(reply, rl);
    // Signed reports get a second, account-scoped budget: one device cannot
    // burn the whole quota by roaming across IPs.
    if (request.auth?.sub) {
      const limAcct = await effectiveLimit(settings, config, 'diagacct', request.auth.sub);
      const rlAcct = await rateLimit(redis, `rl:diagacct:${request.auth.sub}`, limAcct.limit, limAcct.windowSec);
      if (!rlAcct.ok) return limited(reply, rlAcct);
    }

    const report = request.body?.report;
    if (typeof report !== 'string' || !report.trim()) {
      return fail(reply, 'invalid_report', 'report must be a non-empty string', 400);
    }

    await diagnostics.insertOne({
      ts: new Date(),
      ip: request.ip,
      ua: String(request.headers['user-agent'] ?? '').slice(0, 256),
      account: request.auth?.sub ?? null,
      report: report.slice(0, MAX_REPORT_LEN),
    });
    request.log.info(`[diagnostics] report received from ${request.auth?.sub ?? 'anonymous'}`);
    return reply.code(202).send({ ok: true });
  });
}
