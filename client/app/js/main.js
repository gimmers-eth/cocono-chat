// App bootstrap: theme → SDK client → auth gate → app shell. No app data is
// fetched or encrypted outside the SDK ('/sdk/index.js' is @cocono/client,
// served by the backend from client/src).

import { CoconoClient, IdbStorage, CoconoApiError } from '/sdk/index.js';
import { $, showView, setStatus } from './ui.js';
import { initTheme } from './theme.js';
import { startSingleTabGuard } from './components/blocked.js';
import { createAuth } from './components/auth.js';
import { createHome } from './components/home.js';
import { createChat } from './components/chat.js';
import { setScope, setFriends } from './store.js';
import { initKeyboardFit } from './keyboard.js';
import { mountDiagnostics } from './diag.js';
import { applyIcons } from './icons.js';
import { initInstallAndNotify } from './install.js';
import { putAppTitle, takePendingChat } from './swkv.js';

// Debug console logging: flip localStorage.setItem('cocono.debug','1') or use
// ?debug=1 before load.
const logging =
  new URL(location.href).searchParams.has('debug') || localStorage.getItem('cocono.debug') === '1';

export const client = new CoconoClient({
  baseUrl: '', // same origin; the SDK derives ws(s):// from it
  storage: new IdbStorage(),
  logging,
});

const chat = createChat({ client, onHomeRefresh: () => home.renderConversationList() });
const home = createHome({ client, chat, onLogout: () => showAuth() });
const auth = createAuth({ client, onLoggedIn: () => enterApp({ gesture: true }) });

// Phase 1 push: service worker (registered eagerly; permission is only asked
// for after a login click). iOS additionally requires the app to be added to
// the Home Screen before push notifications can arrive at all.
// Offline affordance: banner + immediate WS retry / SW refresh when back.
function paintOnline() {
  const b = $('offline-banner');
  if (b) b.hidden = navigator.onLine !== false;
  if (navigator.onLine === false) return;
  navigator.serviceWorker?.getRegistration?.()?.then?.((r) => r?.update?.());
  if (client.token) {
    client.connect(); // Transport.kick semantics: safe while open
    return;
  }
  // Back online after an offline-mode boot: promote to a real session.
  client.storage.loadIdentity().then((id) => {
    if (!id) return;
    client.login().then(() => enterApp()).catch(() => {});
  }).catch(() => {});
}
window.addEventListener('online', paintOnline);
window.addEventListener('offline', () => {
  const b = $('offline-banner');
  if (b) b.hidden = false;
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(
    // iOS may serve a day-old worker; nudge it to re-check bytes on every
    // page load so instrumented/fixed workers land promptly.
    (r) => r.update?.().catch(() => {}),
    () => {},
  );
  navigator.serviceWorker.addEventListener('message', (e) => {
    // Tapping a notification: refresh the conversation list when the app is
    // open and signed in (content itself arrives via the normal channels).
    if (e.data?.from === 'sw' && e.data.type === 'notification-click' && client.token) {
      if (e.data.peer) chat.openChat(e.data.peer).catch(() => {});
      home.renderConversationList().catch(() => {});
    }
  });
}

async function enterApp({ gesture = false, offline = false } = {}) {
  // Durability: ask the browser to keep our IndexedDB (identity + message
  // store) out of eviction under storage pressure. Best-effort: Chrome/
  // Android honours it (reported as persistent=true in Storage
  // diagnostics); iOS Safari has no persist() and this is a silent no-op.
  navigator.storage?.persist?.().then(
    (granted) => client.logger.debug(`storage.persist(): ${granted ? 'granted' : 'not granted'}`),
    () => {},
  );

  // Decrypt-history store and read markers are per-account: scope them to
  // the logged-in username before anything reads or writes them.
  setScope(client.username);
  showView('app');
  home.paintMe(client.username);
  home.paintConnection(offline ? 'closed' : client.connectionState);
  if (!offline) client.connect(); // offline mode: browse the local store only
  await home.renderConversationList();

  // Friends mirror: the SERVER list is the source of truth — reconcile it on
  // every entry (catches events missed while offline; new devices get the
  // full list here). Live changes arrive via E2EE system messages.
  if (!offline) {
    client.listFriends().then((list) => setFriends(list)).then(() => {
      home.renderConversationList().catch(() => {});
    }).catch(() => { /* stays on the local mirror */ });
  }

  // A notification click that cold-booted the app parked the peer in the
  // SW's IDB kv (delete-on-read): open exactly that conversation.
  takePendingChat().then((peer) => {
    if (peer) chat.openChat(peer).catch(() => {});
  }).catch(() => {});

  // OS notifications: from a gesture (login/signup button) this may prompt
  // for permission; on silent boot-resume it only re-registers a
  // subscription if permission was already granted. Both are best-effort.
  if (offline) return;
  client.enablePush({ prompt: gesture }).then((r) => {
    if (r.state !== 'enabled' && r.state !== 'needs-prompt' && r.state !== 'unsupported') {
      client.logger.debug(`push not enabled: ${r.state} (${r.permission ?? 'n/a'})`);
    }
  }).catch(() => {});
}

async function showAuth() {
  showView('auth');
  let identity = null;
  let loadError = null;
  try {
    identity = await client.storage.loadIdentity();
  } catch (err) {
    // e.g. IndexedDB present but the record unreadable (dropped CryptoKeys).
    loadError = err;
  }
  auth.applyIdentity(identity);
  if (!identity) auth.showMode('signup');
  if (loadError) {
    setStatus(
      $('auth-status'),
      `Saved identity could not be read (${loadError.name}: ${loadError.message}). `
        + 'The browser may have dropped its stored keys or database.',
      true,
    );
  }
}

// Boot — wire every component exactly once, then route.
startSingleTabGuard();
applyIcons(); // data-icon placeholders -> Font Awesome (js/icons.js config)
initKeyboardFit(); // pin the app shell to the visible viewport (soft keyboard)
await initTheme(); // dark fallback already linked in index.html
mountDiagnostics({ client });
initInstallAndNotify({ client });
paintOnline();

// Branding: the admin-configurable app name (see /api/app-info) fills every
// [data-app-name] slot and the document title. The baked-in defaults keep
// the page correct even if this fetch never lands.
fetch('/api/app-info')
  .then((r) => (r.ok ? r.json() : null))
  .then((info) => {
    if (!info?.name) return;
    document.title = info.name;
    putAppTitle(info.name); // feeds the service worker's zero-await notifications (IDB, not localStorage)
    for (const el of document.querySelectorAll('[data-app-name]')) el.textContent = info.name;
    if (info.version) {
      localStorage.setItem('cocono.appversion', info.version); // what THIS page was served by
      const v = $('client-version');
      if (v) v.textContent = `v${info.version}`;
    }
  })
  .catch(() => {});
chat.wire();
chat.connectEvents();
home.wire();
auth.wire();
client.on('state', ({ state }) => home.paintConnection(state));
// Permanent WS rejection (detached device / deleted account): surface it —
// without this the open app looks alive but deaf.
client.on('authFailed', ({ error }) => {
  setStatus($('auth-status'), error.message, true);
  showAuth();
});

try {
  let identity = await client.storage.loadIdentity();
  if (!identity && client.storage.listIdentities) {
    // Self-heal: the 'current' pointer was lost but a stored identity
    // survived (browser glitch / partial eviction) — re-point to it.
    const all = await client.storage.listIdentities();
    if (all.length === 1) {
      await client.storage.saveIdentity(all[0]);
      identity = all[0];
      setStatus($('auth-status'), 'Recovered the stored identity after a lost pointer.');
    }
  }
  if (identity) {
    try {
      // Silent resume: challenge/response with the stored (non-extractable) keys.
      await client.login();
      await enterApp();
    } catch (err) {
      if (err instanceof CoconoApiError) throw err; // account issue -> auth view
      // Network was unreachable: the shell cache worked, so come in anyway
      // and browse the local transcript read-only until connection returns.
      await enterApp({ offline: true });
    }
  } else {
    await showAuth();
  }
} catch (err) {
  await showAuth();
  if (err instanceof CoconoApiError) {
    setStatus(
      $('auth-status'),
      err.code === 'bad_signature'
        ? 'Stored keys are not recognised for that account — usually a URL change '
          + '(localhost vs 127.0.0.1 vs LAN IP keeps separate identities). Use the '
          + 'original URL, or "Forget this device" and pair again.'
        : err.message,
      true,
    );
  } else if (err) {
    setStatus(
      $('auth-status'),
      `Could not resume the session: ${err.message ?? String(err)} — use "Log in" to retry.`,
      true,
    );
  }
}
