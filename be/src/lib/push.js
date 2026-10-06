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

/**
 * Fire a blind push at a device's stored subscription.
 * @returns {'sent'|'gone'|'no-subscription'|'skipped'|'error'}
 *   'gone'  => subscription expired at the push service; caller should clear it.
 */
export async function sendBlindPush(config, subscription, type) {
  if (!pushEnabled(config)) return 'skipped';
  if (!subscription?.endpoint) return 'no-subscription';
  ensureInit(config);
  try {
    // Padded payload: uniform size hides event frequency/content-length from
    // the push service. 3 = msg, 4 = pairing-request (Phase 3 uses 5+).
    const body = JSON.stringify({ t: type, pad: 'x'.repeat(256) });
    await webpush.sendNotification(subscription, body);
    return 'sent';
  } catch (err) {
    if (err?.statusCode === 404 || err?.statusCode === 410) return 'gone';
    return 'error';
  }
}
