// WebSocket frame handlers (milestone 3). These are the store-and-forward
// seams flagged in DESIGN.md for a future worker_threads move.
import { randomUUID } from 'node:crypto';
import { rateLimit } from '../../lib/rateLimit.js';
import { verifyEnvelope } from './envelope.js';
import { devKey, sendJson, PENDING_BATCH } from './protocol.js';
import { sendBlindPush, presenceKey } from '../../lib/push.js';

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
    const recipient = await users.findOne({ ul: rul }, { projection: { devices: 1 } });
    const recipientDevice = recipient?.devices.find((dev) => dev.id === m.dv);
    if (!recipient || !recipientDevice) {
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

    // Phase 1 notifications: push ONLY when the recipient device is offline
    // (no live WS). Blind payload — event type, nothing else. Never push to
    // the sender's own device (self-chat echo arrives via its live WS anyway).
    if (recipientDevice.push && m.d !== auth.d) {
      try {
        const online = await redis.exists(presenceKey(rul, m.dv));
        if (online) request.log.info(`[push] skip ${rul}/${m.dv.slice(0, 8)}: device online (live WS)`);
        if (!online) {
          const outcome = await sendBlindPush(config, recipientDevice.push, 'msg');
          request.log.info(`[push] ${rul}/${m.dv.slice(0, 8)} -> ${outcome}`);
          if (outcome === 'gone') {
            // Push service says subscription is dead: clear it, nothing else.
            await users.updateOne(
              { ul: rul, 'devices.id': m.dv, 'devices.push.endpoint': recipientDevice.push.endpoint },
              { $unset: { 'devices.$.push': '' } },
            );
          }
        }
      } catch (err) {
        // Push is best-effort: never let it break the send/ack path.
        request.log.warn(`[push] ${rul}/${m.dv.slice(0, 8)} failed: ${err?.message ?? err}`);
      }
    } else if (m.d !== auth.d) {
      request.log.info(`[push] skip ${rul}/${m.dv.slice(0, 8)}: no push subscription on this device`);
    }
    return ack(true);
  }

  async function deliverPending(socket, ul, dv) {
    const pending = await messages
      .find({ 'to.ul': ul, 'to.dv': dv, pulledAt: null })
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

    // Scope to THIS device so a client can only confirm its own copies.
    // Retention: copies are NOT deleted on pull — they are marked and swept
    // by the expireAt TTL index (MSG_RETENTION_SEC). That keeps a bounded
    // re-delivery window (see handleResync) for a device that pulled but
    // then lost its local message store. E2EE caveat: ciphertext is
    // per-device, so only the SAME device identity can read it back.
    const docs = await messages
      .find({ mid: { $in: ids }, 'to.ul': auth.sub, 'to.dv': auth.d, pulledAt: null })
      .toArray();
    if (!docs.length) return;
    const now = new Date();
    await messages.updateMany(
      { mid: { $in: docs.map((d) => d.mid) } },
      { $set: { pulledAt: now, expireAt: new Date(now.getTime() + config.msgRetentionSec * 1000) } },
    );

    // Receipts: tell each sender's device that this message was pulled
    // (newly-pulled copies only — a resynced copy re-pulled stays silent).
    for (const doc of docs) {
      await pub.publish(
        devKey(doc.from.ul, doc.from.fd),
        JSON.stringify({ type: 'delivered', cid: doc.cid, to: doc.to.ul }),
      );
    }
  }

  // Re-deliver this device's already-pulled copies still inside the
  // retention window. Client dedupes by mid, so resync is safe to retry.
  async function handleResync(socket, ul, dv) {
    const kept = await messages
      .find({ 'to.ul': ul, 'to.dv': dv, pulledAt: { $ne: null } })
      .sort({ ts: 1 })
      .limit(PENDING_BATCH)
      .toArray();
    for (const doc of kept) {
      sendJson(socket, {
        type: 'msg',
        id: doc.mid,
        ts: doc.ts instanceof Date ? doc.ts.getTime() : doc.ts,
        env: doc.env,
      });
    }
  }

  return { handleSend, handlePulled, handleResync, deliverPending };
}
