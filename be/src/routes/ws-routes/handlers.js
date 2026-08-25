// WebSocket frame handlers (milestone 3). These are the store-and-forward
// seams flagged in DESIGN.md for a future worker_threads move.
import { randomUUID } from 'node:crypto';
import { rateLimit } from '../../lib/rateLimit.js';
import { verifyEnvelope } from './envelope.js';
import { devKey, sendJson, PENDING_BATCH } from './protocol.js';

export function createHandlers({ users, redis, pub, config, messages }) {
  async function handleSend(socket, request, body, auth) {
    const env = body.msg;
    const m = env?.m;
    const cid = typeof m?.cid === 'string' ? m.cid : null;
    const ack = (ok, error) =>
      sendJson(socket, { type: 'ack', cid, ok, ...(error ? { error } : {}) });

    if (!m || typeof m !== 'object') return ack(false, 'invalid_envelope');

    const rlAccount = await rateLimit(redis, `rl:msg:${auth.sub}`, config.msgAccountLimit, config.msgAccountWindowSec);
    if (!rlAccount.ok) return ack(false, 'rate_limited');
    const rlIp = await rateLimit(redis, `rl:msgip:${request.ip}`, config.msgIpLimit, config.msgIpWindowSec);
    if (!rlIp.ok) return ack(false, 'rate_limited');

    // The claimed sender must match the authenticated connection.
    if (typeof m.f !== 'string' || m.f.toLowerCase() !== auth.sub || m.fd !== auth.d) {
      return ack(false, 'sender_mismatch');
    }

    const sender = await users.findOne({ ul: auth.sub });
    const senderDevice = sender?.devices.find((dev) => dev.id === auth.d);
    if (!senderDevice) return ack(false, 'unknown_device');

    const problem = verifyEnvelope(env, senderDevice, config);
    if (problem) return ack(false, problem);

    // Recipient account + device must exist.
    const rul = m.u.toLowerCase();
    const recipient = await users.findOne({ ul: rul }, { projection: { 'devices.id': 1 } });
    if (!recipient || !recipient.devices.some((dev) => dev.id === m.dv)) {
      return ack(false, 'unknown_recipient');
    }

    const doc = {
      mid: randomUUID(),
      to: { ul: rul, dv: m.dv },
      from: { ul: auth.sub, fd: auth.d },
      cid: m.cid,
      env,
      ts: new Date(),
    };
    try {
      await messages.insertOne(doc);
    } catch (err) {
      // Unique (from, cid) index hit: idempotent retry of a queued message.
      if (err?.code === 11000) return ack(true);
      throw err;
    }

    await pub.publish(devKey(rul, m.dv), JSON.stringify({ type: 'msg', id: doc.mid, ts: doc.ts.getTime(), env }));
    return ack(true);
  }

  async function deliverPending(socket, ul, dv) {
    const pending = await messages
      .find({ 'to.ul': ul, 'to.dv': dv })
      .sort({ ts: 1 })
      .limit(PENDING_BATCH)
      .toArray();
    for (const doc of pending) {
      sendJson(socket, {
        type: 'msg',
        id: doc.mid,
        ts: doc.ts instanceof Date ? doc.ts.getTime() : doc.ts,
        env: doc.env,
      });
    }
  }

  async function handlePulled(socket, body, auth) {
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((id) => typeof id === 'string').slice(0, PENDING_BATCH)
      : [];
    if (!ids.length) return;

    // Scope the delete to THIS device so a client can only confirm its own.
    const docs = await messages
      .find({ mid: { $in: ids }, 'to.ul': auth.sub, 'to.dv': auth.d })
      .toArray();
    if (!docs.length) return;
    await messages.deleteMany({ mid: { $in: docs.map((d) => d.mid) } });

    // Receipts: tell each sender's device that this message was pulled.
    for (const doc of docs) {
      await pub.publish(
        devKey(doc.from.ul, doc.from.fd),
        JSON.stringify({ type: 'delivered', cid: doc.cid, to: doc.to.ul }),
      );
    }
  }

  return { handleSend, handlePulled, deliverPending };
}
