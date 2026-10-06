// co.co.no service worker — two jobs:
//
// 1) RICH PUSH NOTIFICATIONS. Pushes arrive blind (E2EE contract: no content
//    or usernames ever cross a push service). We show a generic notification
//    IMMEDIATELY, then race a short budget: silent-resume (challenge/verify
//    with the device keys in IndexedDB), open a brief WS session, DECRYPT the
//    queued frames, and replace the notification with "sender: snippet".
//    Crucially the WS only PEEKS — it never sends 'pulled' — so the page
//    still receives the messages normally when opened.
//    WebKit forbids dynamic import()/modules in service workers, so the
//    crypto/login/WS machinery lives in /sw-lib.js, a CLASSIC script loaded
//    lazily via importScripts() inside handlers (never at evaluation time —
//    a failed load must not break the worker itself). Every failure is
//    surfaced three ways: the notification body, a localStorage ring buffer
//    ('cocono.swlog', read by Settings -> Send diagnostics), and a POST to
//    /api/diagnostics tagged [sw-preview-failure].
//
// 2) OFFLINE APP SHELL. Network-first for navigations, static assets and
//    sw-lib.js; cache fallback when offline. API traffic and the dynamic
//    manifest are never cached.

const SHELL_CACHE = 'cocono-shell-v3';
const FALLBACK_TITLE = 'co.co.no';
const ENRICH_BUDGET_MS = 9000;
const SETTLE_MS = 1500;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('cocono-shell-') && key !== SHELL_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

function swLib() {
  if (!self.SwLib) self.importScripts('/sw-lib.js');
  return self.SwLib;
}

async function showNotification(titleText, body, type) {
  await self.registration.showNotification(titleText, {
    body,
    tag: 'cocono-activity', // replaces the earlier notification of the same tag
    timestamp: Date.now(),
    data: { type },
  });
}

async function appTitle() {
  try {
    const res = await fetch('/api/app-info');
    if (res.ok) return (await res.json()).name || FALLBACK_TITLE;
  } catch { /* offline etc. */ }
  return FALLBACK_TITLE;
}

function reportSwFailure(why) {
  try {
    swLib().swLog('push', why);
  } catch { /* lib unavailable — the notification body still reports it */ }
  fetch('/api/diagnostics', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ report: `[sw-preview-failure] ${why} | ua=${navigator.userAgent.slice(0, 90)}` }),
  }).catch(() => {});
}

// Silent login + WS peek + decrypt; returns {peer, text, extra} or null.
async function upgradeContent() {
  const lib = swLib();
  const record = await lib.loadIdentity();
  if (!record) return null;
  const { token, xPriv } = await lib.login(record);
  return lib.peek(token, record, xPriv, SETTLE_MS);
}

const withBudget = (promise, ms) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* blind */ }
  const type = data.t || 'activity';

  event.waitUntil((async () => {
    const name = await appTitle();
    await showNotification(name, type === 'msg' ? 'You have a new message' : 'New activity — open to see', type);
    if (type !== 'msg') return;
    try {
      const rich = await withBudget(upgradeContent(), ENRICH_BUDGET_MS);
      if (!rich) return; // nothing (yet) — the generic notification stands
      const snippet = (rich.text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      const more = rich.extra > 0 ? ` (+${rich.extra} more)` : '';
      await showNotification(name, `@${rich.peer}: ${snippet || '(message)'}${more}`, 'msg');
    } catch (err) {
      const why = String(err?.message ?? err).slice(0, 160);
      console.warn('[sw] enrich failed:', why);
      reportSwFailure(why);
      await showNotification(name, `New message — preview failed: ${why}`, 'msg');
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) {
        client.postMessage({ from: 'sw', type: 'notification-click', eventType: event.notification.data?.type });
        return client.focus();
      }
    }
    return self.clients.openWindow ? self.clients.openWindow('/') : null;
  })());
});

// APNs/FCM rotate subscriptions (push silently dies otherwise): re-subscribe
// with our VAPID key and re-register the endpoint on the server.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const lib = swLib();
      const record = await lib.loadIdentity();
      if (!record) return;
      const { token } = await lib.login(record);
      const info = await (await fetch('/api/app-info')).json();
      if (!info?.vapidPublicKey) return;
      const fresh = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: lib.b64uBytes(info.vapidPublicKey),
      });
      const j = fresh.toJSON();
      await fetch('/api/devices/push-subscription', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys }),
      });
      lib.swLog('pushswap', 'subscription rotated + re-registered');
    } catch (err) {
      reportSwFailure(`pushsubscriptionchange failed: ${err?.message ?? err}`);
    }
  })());
});

// ---------- offline app shell ----------

const SHELL_PATHS = ['/css/', '/js/', '/sdk/', '/themes/', '/icons/'];
const isShell = (url) =>
  url.origin === self.location.origin
  && (url.pathname === '/' || url.pathname === '/sw-lib.js'
    || SHELL_PATHS.some((p) => url.pathname.startsWith(p)));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!isShell(url)) return; // API, manifest, cross-origin: always network
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) {
        const cache = await caches.open(SHELL_CACHE);
        cache.put(req, res.clone());
      }
      return res;
    } catch {
      return (await caches.match(req)) ?? Response.error();
    }
  })());
});
