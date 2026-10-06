// co.co.no service worker — two jobs:
//
// 1) RICH PUSH NOTIFICATIONS. A push arrives blind (the server never puts
//    content or usernames in the payload — E2EE contract). We show a
//    generic notification IMMEDIATELY (the reliable floor), then race a
//    short budget: silent-resume the SDK inside the worker, open a brief WS
//    session, receive + decrypt queued messages, write them into the same
//    per-account IndexedDB store the page uses, and REPLACE the notification
//    with "sender: snippet". The SDK's normal pulled-ack marks copies
//    server-side (retained for the resync window), so the page never
//    duplicates them — they simply appear in the store. If anything fails
//    (offline, iOS kills the worker, no identity) the generic notification
//    stands.
//
// 2) OFFLINE APP SHELL. Network-first for navigations and static assets,
//    falling back to cache when offline — the app opens with real (stale-
//    free-when-online) code and shows the locally stored transcript. API
//    traffic and the dynamic manifest are never cached.
//
// Note: this worker runs classic and loads ESM via dynamic import(), which
// keeps a single source of truth for store + SDK on both sides.

const SHELL_CACHE = 'cocono-shell-v2';
const FALLBACK_TITLE = 'co.co.no';
const ENRICH_BUDGET_MS = 8000;
const SETTLE_MS = 1200;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('cocono-shell-') && key !== SHELL_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

// ---------- notifications ----------

async function showNotification(title, body, type) {
  await self.registration.showNotification(title, {
    body,
    tag: 'cocono-activity', // replaces the earlier notification of the same tag
    timestamp: Date.now(),
    data: { type },
  });
}

function title() {
  return (async () => {
    try {
      const res = await fetch('/api/app-info');
      if (res.ok) return (await res.json()).name || FALLBACK_TITLE;
    } catch { /* offline etc. */ }
    return FALLBACK_TITLE;
  })();
}

// Pull + decrypt queued messages briefly; returns { peer, text, extra } for
// the freshest one, or null. Throws on any protocol/crypto failure so the
// caller can fall back.
async function enrichFromServer() {
  let storageMod; let storeMod;
  try {
    [storageMod, storeMod] = await Promise.all([
      import('/sdk/index.js'), import('/js/store.js'),
    ]);
  } catch (err) {
    throw new Error(`import failed: ${err?.name}: ${err?.message}`);
  }
  const storage = new storageMod.IdbStorage();
  if (!(await storage.loadIdentity())) return null; // no account on this device

  const client = new storageMod.CoconoClient({ baseUrl: '', storage, logging: false });
  try {
    await client.login(); // fully silent now (no passkey gesture paths)
  } catch (err) {
    throw new Error(`login failed: ${err?.message ?? err}`);
  }
  storeMod.setScope(client.username);

  const first = { message: null, count: 0 };
  const received = new Promise((resolve) => {
    client.on('message', (m) => {
      first.count += 1;
      first.message ??= m;
      storeMod.saveMessage({
        id: `in:${m.mid}`, peer: m.peer, dir: 'in', text: m.text, ts: m.ts,
        fromDeviceId: m.fromDeviceId,
      }).catch(() => {});
    });
    client.on('state', ({ state }) => {
      if (state === 'open') setTimeout(() => resolve(), SETTLE_MS);
    });
    client.connect();
  });

  await Promise.race([
    received,
    new Promise((_, rej) => setTimeout(() => rej(new Error('ws never opened')), 6000)),
  ]);
  client.disconnect();
  if (!first.message) return null;
  return { ...first.message, extra: first.count - 1 };
}

const withBudget = (promise, ms) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* blind */ }
  const type = data.t || 'activity';

  event.waitUntil((async () => {
    const name = await title();
    // 1. the reliable floor
    await showNotification(
      name,
      type === 'msg' ? 'You have a new message' : 'New activity — open to see',
      type,
    );
    // 2. the upgrade (best effort)
    if (type !== 'msg') return;
    try {
      const rich = await withBudget(enrichFromServer(), ENRICH_BUDGET_MS);
      if (!rich) return; // nothing (yet) — the generic notification stands
      const snippet = (rich.text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      const more = rich.extra > 0 ? ` (+${rich.extra} more)` : '';
      await showNotification(name, `@${rich.peer}: ${snippet || '(message)'}${more}`, 'msg');
    } catch (err) {
      // Surface the failure in place (and server-side): debugging a worker on
      // an iPhone has no other window into this path.
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

// ---------- offline app shell ----------

const SHELL_PREFIXES = ['/css/', '/js/', '/sdk/', '/themes/', '/icons/'];
const isShell = (url) =>
  url.origin === self.location.origin
  && (url.pathname === '/' || SHELL_PREFIXES.some((p) => url.pathname.startsWith(p)));

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

// Best-effort server-side reporting of preview failures (rate-limited by the
// diagnostics endpoint itself; failure to report is itself silent).
function reportSwFailure(why) {
  try {
    fetch('/api/diagnostics', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ report: `[sw-preview-failure] ${why} | ua=${navigator.userAgent.slice(0, 90)}` }),
    }).catch(() => {});
  } catch { /* offline etc. */ }
}

// APNs/FCM rotate subscriptions occasionally (epoch changes) — without this
// handler the device silently stops receiving pushes until a page loads.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const { CoconoClient, IdbStorage } = await import('/sdk/index.js');
      const storage = new IdbStorage();
      if (!(await storage.loadIdentity())) return;
      const client = new CoconoClient({ baseUrl: '', storage, logging: false });
      await client.login();
      const info = await (await fetch('/api/app-info')).json();
      if (!info?.vapidPublicKey) return;
      const old = await self.registration.pushManager.getSubscription();
      const sub = await old?.subscriptionOptions?.() ?? {};
      const fresh = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: sub.applicationServerKey ?? info.vapidPublicKey,
      });
      const j = fresh.toJSON();
      await client.api?.setPushSubscription?.(client.token, { endpoint: j.endpoint, keys: j.keys });
    } catch (err) {
      reportSwFailure(`pushsubscriptionchange failed: ${err?.message ?? err}`);
    }
  })());
});
