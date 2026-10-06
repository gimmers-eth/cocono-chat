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
//    via importScripts() at evaluation time (the only legal place), guarded.
//    Every failure is surfaced three ways: the notification body, an
//    IndexedDB ring buffer (workers have NO localStorage — that ReferenceError
//    once silently ate every notification), and a POST to /api/diagnostics
//    tagged [sw-preview-failure]. Settings -> Send diagnostics ships the ring.
//
// 2) OFFLINE APP SHELL. Network-first for navigations, static assets and
//    sw-lib.js; cache fallback when offline. API traffic and the dynamic
//    manifest are never cached.

const SHELL_CACHE = 'cocono-shell-v3';
const FALLBACK_TITLE = 'co.co.no';
const SETTLE_MS = 800;

self.addEventListener('install', () => self.skipWaiting());

// importScripts is only legal during script evaluation / the install event —
// NOT lazily from handlers ("past installing state"). Load the classic lib
// up front, guarded: a failure must never stop the worker itself installing.
try {
  self.importScripts('/sw-lib.js');
} catch (err) {
  console.warn('[sw] sw-lib.js unavailable at evaluation:', err?.message ?? err);
}

function swLib() {
  if (!self.SwLib) throw new Error('sw-lib not loaded (offline worker start?)');
  return self.SwLib;
}

// any uncaught worker error -> diagnostics ring via the classic lib (IDB:
// workers have NO localStorage — that ReferenceError once ate every push)
self.addEventListener('error', (e) => {
  try {
    swLib().swLog('workererror', `${e.message} @${e.filename ?? '?'}:${e.lineno ?? 0}`);
  } catch { /* lib not loaded — nothing available to log with */ }
});

// In-memory title cache (zero-await requirement for the generic
// notification); refreshed from IndexedDB in the background, and the page
// writes the fresh value there on every boot.
let cachedTitle = FALLBACK_TITLE;
try {
  swLib().kvGet('apptitle').then((t) => { if (t) cachedTitle = t; }).catch(() => {});
} catch { /* lib absent: notifications fall back to FALLBACK_TITLE */ }

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('cocono-shell-') && key !== SHELL_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

let pendingPeerTag = null; // peer associated with the next shown notification

async function showNotification(titleText, body, type) {
  // Replace-in-place MUST be manual: Safari/WebKit does not honour tag
  // replacement in service workers, so the generic and the upgraded notice
  // would otherwise stack as two notifications. Close-then-show is the
  // portable pattern (no-op when nothing is showing).
  try {
    const open = await self.registration.getNotifications({ tag: 'cocono-activity' });
    for (const n of open) { try { n.close(); } catch { /* racing close */ } }
  } catch { /* getNotifications unsupported — fall through to plain show */ }
  await self.registration.showNotification(titleText, {
    body,
    tag: 'cocono-activity', // still dedupes on engines that honour it
    timestamp: Date.now(),
    data: { type, peer: pendingPeerTag },
  });
}

async function appTitle() {
  try {
    const res = await fetch('/api/app-info');
    if (res.ok) {
      const name = (await res.json()).name || FALLBACK_TITLE;
      swLib().kvSet('apptitle', name);
      return name;
    }
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

// Exactly ONE banner per push EVENT: the rich path is shown when it wins;
// the generic only ever appears as the failure/timeout/empty branch, and a
// shown-latch makes a second banner for the same event structurally
// impossible (that timer-vs-settle race is what kept producing two on
// iOS). Every path ends with >=1 notification, so Chrome's "upgraded in
// the background" consolation toast can never trigger either.
const UP_BUDGET_MS = 8000;
// Chrome replays the pushes queued while the browser/app was closed as a
// burst of near-simultaneous events. Collapse the burst: wait briefly, then
// do ONE silent login + ONE peek (its '+N more' counts the rest) and show
// ONE notification — instead of N of each.
const MSG_COALESCE_MS = 2000;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

let msgBatch = null; // in-flight burst task (promise), or null

async function showMsgNotification() {
  let shown = false;
  const showOnce = async (titleText, body) => {
    if (shown) return;
    shown = true;
    await showNotification(titleText, body, 'msg');
  };
  const generic = () => showOnce(cachedTitle, 'You have new messages');

  const upgrade = (async () => {
    const rich = await upgradeContent();
    if (!rich) { await generic(); return; } // queue raced empty: cover it
    try { cachedTitle = await appTitle(); } catch { /* keep cache */ }
    const snippet = (rich.text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const more = rich.extra > 0 ? ` (+${rich.extra} more)` : '';
    pendingPeerTag = rich.peer;
    await showOnce(cachedTitle, `@${rich.peer}: ${snippet || '(message)'}${more}`);
  })().catch(async (err) => {
    const why = String(err?.message ?? err).slice(0, 160);
    console.warn('[sw] enrich failed:', why);
    reportSwFailure(why);
    await generic();
  });

  // budget: if the peek stalls (no network, suspended radio), the generic
  // covers; a rich result arriving after that is SUPPRESSED by the latch —
  // one banner, always.
  await Promise.race([upgrade, sleep(UP_BUDGET_MS).then(generic)]);
  await upgrade.catch(() => {});
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* blind */ }
  const type = data.t || 'activity';

  if (type !== 'msg') {
    event.waitUntil(showNotification(cachedTitle, 'New activity — open to see', type));
    return;
  }

  // All events of the burst await the SAME task (joiner's waitUntil is
  // satisfied by the leader's notification); later pushes get a new batch.
  if (!msgBatch) {
    msgBatch = (async () => {
      await sleep(MSG_COALESCE_MS); // absorb the replayed burst
      await showMsgNotification();
    })().finally(() => { msgBatch = null; });
  }
  event.waitUntil(msgBatch);
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) {
        client.postMessage({ from: 'sw', type: 'notification-click', eventType: event.notification.data?.type, peer: event.notification.data?.peer });
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
