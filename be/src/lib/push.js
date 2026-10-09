// Web Push (Phase 1): BLIND notifications only.
//
// The payload deliberately carries nothing but an event TYPE (plus padding) —
// push traffic transits Google/Apple/Mozilla servers and our E2EE contract
// says content and usernames must never leave our own wire format. The
// receiver's service worker wakes on the signal, and the app itself renders
// or fetches the real thing.
//
// Presence: a device that currently holds a live WS is NOT pushed (the socket
// already delivered); offline devices are. Presence lives in Redis because
// any node may receive a send for a device connected to another node.
import webpush from 'web-push';
import { createHash } from 'node:crypto';

let initialized = false;

export function pushEnabled(config) {
  return Boolean(config.vapidPublicKey && config.vapidPrivateKey);
}

function ensureInit(config) {
  if (!initialized && pushEnabled(config)) {
    // web-push API is positional: setVapidDetails(subject, publicKey, privateKey)
    webpush.setVapidDetails(
      config.vapidSubject || 'mailto:unknown@example.com',
      config.vapidPublicKey,
      config.vapidPrivateKey,
    );
    initialized = true;
  }
}

export const presenceKey = (ul, dv) => `presence:${ul}:${dv}`;
// Coalescing key, ONE PER (device, conversation): set (NX) when a push
// fires; while it lives, further pushes FROM THE SAME SENDER to the same
// device are skipped (see handlers.js). A message in a different chat still
// notifies; and the device coming back online clears all its gates (the
// backlog was just delivered — the next offline message must notify again).
export const pushSentKey = (ul, dv, senderUl) => `pushsent:${ul}:${dv}:${senderUl}`;
export const pushSentPattern = (ul, dv) => `pushsent:${ul}:${dv}:*`;

// RFC 8030 Topic: [a-zA-Z0-9_-]{1,35}; lets the push service collapse
// unread notifications for an offline device per topic instead of replaying
// the whole backlog on wake. Topic is per-conversation (hashed sender — the
// clear-text name must never reach the push service) so one chatty chat
// cannot hide another chat's hint.
const topicFor = (type, senderUl = '') => {
  const hash = senderUl ? createHash('sha256').update(String(senderUl)).digest('hex').slice(0, 10) : '';
  const t = hash ? `${type}-${hash}` : String(type);
  return (t.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 35) || 'activity');
};

/**
 * Fire a blind push at a device's stored subscription.
 * @param {string} senderUl lowercase sender username (hashed into the Topic;
 *   never transmitted). @returns {'sent'|'gone'|'no-subscription'|'skipped'|'error'}
 *   'gone'  => subscription expired at the push service; caller should clear it.
 */
/**
 * Blind 'badge' push for every push-subscribed device of an account that is
 * NOT currently holding a live WS. Admin awards are the offline case (login
 * -time awards land while the user is connected — the dm nudge + poll cover
 * those). Repeated offline awards coalesce per RFC-8030 topic ('badge'),
 * and the client poll dispatches ALL unseen grants in one modal queue when
 * the app next opens — one push is all it takes.
 */
export async function pushBadgeHint(users, redis, config, ul) {
  if (!pushEnabled(config)) return 'disabled';
  let user = null;
  try { user = await users.findOne({ ul }, { projection: { devices: 1 } }); } catch { return 'error'; }
  let sent = 0;
  for (const dev of user?.devices ?? []) {
    if (!dev.push?.endpoint) continue;
    try {
      if (await redis.exists(presenceKey(ul, dev.id))) continue; // live device: nudge got it
      if (await sendBlindPush(config, dev.push, 'badge') === 'sent') sent++;
    } catch { /* best effort per device */ }
  }
  return sent ? 'sent' : 'none';
}

export async function sendBlindPush(config, subscription, type, senderUl = '') {
  if (!pushEnabled(config)) return 'skipped';
  if (!subscription?.endpoint) return 'no-subscription';
  ensureInit(config);
  try {
    // Padded payload: uniform size hides event frequency/content-length from
    // the push service. 3 = msg, 4 = pairing-request (Phase 3 uses 5+).
    const body = JSON.stringify({ t: type, pad: 'x'.repeat(256) });
    await webpush.sendNotification(subscription, body, {
      TTL: config.pushTtlSec,
      headers: { Topic: topicFor(type, senderUl) },
    });
    return 'sent';
  } catch (err) {
    if (err?.statusCode === 404 || err?.statusCode === 410) return 'gone';
    return 'error';
  }
}
