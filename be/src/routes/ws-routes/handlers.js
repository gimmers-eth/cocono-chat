// WebSocket frame handlers (milestone 3). These are the store-and-forward
// seams flagged in DESIGN.md for a future worker_threads move.
import { randomUUID } from 'node:crypto';
import { rateLimit } from '../../lib/rateLimit.js';
import { effectiveLimit } from '../../lib/limits.js';
import { verifyEnvelope } from './envelope.js';
import { devKey, sendJson, PENDING_BATCH } from './protocol.js';
import { sendBlindPush, presenceKey, pushSentKey } from '../../lib/push.js';

export function createHandlers({ users, redis, pub, config, messages, settings, counters }) {
  async function handleSend(socket, request, body, auth) {
    const env = body.msg;
    const m = env?.m;
    const cid = typeof m?.cid === 'string' ? m.cid : null;
    const ack = (ok, error) =>
      sendJson(socket, { type: 'ack', cid, ok, ...(error ? { error } : {}) });

    if (!m || typeof m !== 'object') return ack(false, 'invalid_envelope');

    const limMsg = await effectiveLimit(settings, config, 'msg', auth.sub);
    const rlAccount = await rateLimit(redis, `rl:msg:${auth.sub}`, limMsg.limit, limMsg.windowSec);
    if (!rlAccount.ok) return ack(false, 'rate_limited');
    const limIp = await effectiveLimit(settings, config, 'msgip');
    const rlIp = await rateLimit(redis, `rl:msgip:${request.ip}`, limIp.limit, limIp.windowSec);
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
    const recipient = await users.findOne({ ul: rul }, { projection: { devices: 1, friends: 1, blocked: 1 } });
    const recipientDevice = recipient?.devices.find((dev) => dev.id === m.dv);
    if (!recipient || !recipientDevice) {
      return ack(false, 'unknown_recipient');
    }

    // BLOCK GATES (send seam, BEFORE storage — one check covers store-and-
    // forward, live delivery and push because nothing new enters the queue):
    // inbound from a blocked sender is refused; sending TO someone you
    // blocked is refused too (blocking is not an inbox you may keep using).
    if (Array.isArray(recipient.blocked) && recipient.blocked.includes(auth.sub)) {
      return ack(false, 'blocked');
    }
    if (sender.blocked?.includes(rul)) return ack(false, 'self_blocked'); // (sender doc already loaded above)

    // Cold-send policy (identity verification): an UNVERIFIED account may
    // only message someone who added them as a friend, or who messaged
    // them first (so replies always work). Verified accounts may message
    // anyone. This is the anti-spam gate a public messenger needs (P0 #1
    // sibling): names alone cannot harvest the directory.
    if (config.coldSendRequiresVerification && !sender.verified && rul !== auth.sub) {
      const addedMe = (recipient.friends ?? []).some((f) => (typeof f === 'string' ? f : f.u) === auth.sub);
      if (!addedMe) {
        const firstContact = await messages.findOne({ 'from.ul': rul, 'to.ul': auth.sub }, { projection: { _id: 1 } });
        if (!firstContact) return ack(false, 'verify_required');
      }
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
    // SENT-message counter (username-keyed, survives account deletion by
    // design): feeds the 'You've got mail' badge. Idempotent retries landed
    // in the catch above, so this increments exactly once per accepted send.
    // Self-sends count too — the badge counts messages SENT, period.
    if (counters) await counters.updateOne({ _id: `sent:${auth.sub}` }, { $inc: { n: 1 } }, { upsert: true });

    await pub.publish(devKey(rul, m.dv), JSON.stringify({ type: 'msg', id: doc.mid, ts: doc.ts.getTime(), env }));
    const acked = ack(true);

    // Notifications are fire-and-forget AFTER the ack is queued: push
    // latency/hiccups must never sit in the message-ack path (that coupling
    // was the ack jitter behind the idempotent-retry test's flake).
    // Phase 1 notifications: push ONLY when the recipient device is offline
    // (no live WS). Blind payload — event type, nothing else. Never push to
    // the sender's own device (self-chat echo arrives via its live WS anyway).
    if (recipientDevice.push && m.d !== auth.d) {
      try {
        const online = await redis.exists(presenceKey(rul, m.dv));
        if (online) request.log.info(`[push] skip ${rul}/${m.dv.slice(0, 8)}: device online (live WS)`);
        if (!online) {
          // Coalesce PER CONVERSATION: while a push for this (device, sender)
          // is recent, that sender's backlog is covered by the notification
          // already shown (the worker's peek counts '+N more'). Other chats
          // and the device's next connect (which clears the gates) still
          // notify — this keeps every genuine new event one push away.
          const fresh = await redis.set(pushSentKey(rul, m.dv, auth.ul), '1', { NX: true, EX: config.pushCoalesceSec });
          if (!fresh) {
            request.log.info(`[push] coalesce ${rul}/${m.dv.slice(0, 8)} from ${auth.ul} (within ${config.pushCoalesceSec}s)`);
          } else {
            const outcome = await sendBlindPush(config, recipientDevice.push, 'msg', auth.ul);
            request.log.info(`[push] ${rul}/${m.dv.slice(0, 8)} -> ${outcome}`);
            if (outcome === 'gone') {
              // Push service says subscription is dead: clear it, nothing else.
              await users.updateOne(
                { ul: rul, 'devices.id': m.dv, 'devices.push.endpoint': recipientDevice.push.endpoint },
                { $unset: { 'devices.$.push': '' } },
              );
            }
          }
        }
      } catch (err) {
        // Push is best-effort: never let it break the send/ack path.
        request.log.warn(`[push] ${rul}/${m.dv.slice(0, 8)} failed: ${err?.message ?? err}`);
      }
    } else if (m.d !== auth.d) {
      request.log.info(`[push] skip ${rul}/${m.dv.slice(0, 8)}: no push subscription on this device`);
    }
    return acked;
  }

  async function deliverPending(socket, ul, dv) {
    const pending = await messages
      .find({ 'to.ul': ul, 'to.dv': dv, pulledAt: null })
      .sort({ ts: 1 })
      .limit(PENDING_BATCH)
      .toArray();
    const blockedSet = await blockedOf(ul);
    for (const doc of pending) {
      if (blockedSet.has(String(doc.from?.ul ?? ''))) continue; // stored pre-block: never delivered
      sendJson(socket, {
        type: 'msg',
        id: doc.mid,
        ts: doc.ts instanceof Date ? doc.ts.getTime() : doc.ts,
        env: doc.env,
      });
    }
  }

  // one indexed read per connection/drain — the block list is tiny
  async function blockedOf(ul) {
    try {
      const doc = await users.findOne({ ul }, { projection: { blocked: 1 } });
      return new Set((doc?.blocked ?? []).map((u) => String(u).toLowerCase()));
    } catch { return new Set(); }
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
    const blockedSet = await blockedOf(ul);
    for (const doc of kept) {
      if (blockedSet.has(String(doc.from?.ul ?? ''))) continue; // resync must not refill a blocked inbox
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
