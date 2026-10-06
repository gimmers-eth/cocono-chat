// co.co.no service worker — Phase 1: OS notifications from BLIND pushes.
//
// The server only ever sends {t:'msg'|..., pad} — no content, no usernames
// (E2EE contract: push traffic transits Google/Apple/Mozilla). So the
// notification says *something happened*; tapping opens/focuses the app,
// which fetches the real (decrypted) event over its own WS/REST channel.
//
// Registration happens after login (user-gesture context) from main.js.

const FALLBACK_TITLE = 'co.co.no';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

async function appTitle() {
  try {
    const res = await fetch('/api/app-info');
    if (res.ok) {
      const info = await res.json();
      if (info?.name) return info.name;
    }
  } catch { /* offline / no server: fallback below */ }
  return FALLBACK_TITLE;
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* blind or malformed — fine */ }
  const body =
    data.t === 'msg' ? 'You have a new message'
    : data.t === 'pair' ? 'A device is waiting to pair with your account'
    : 'New activity';
  event.waitUntil((async () => {
    // tag: replace any un-dismissed notification instead of stacking one per
    // message; the app shows the full list on open anyway.
    return self.registration.showNotification(await appTitle(), {
      body,
      tag: 'cocono-activity',
      timestamp: Date.now(),
      data: { type: data.t || 'activity' },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) {
        // Tell the app what happened so it can navigate straight to it.
        client.postMessage({ from: 'sw', type: 'notification-click', eventType: event.notification.data?.type });
        return client.focus();
      }
    }
    return self.clients.openWindow ? self.clients.openWindow('/') : null;
  })());
});
