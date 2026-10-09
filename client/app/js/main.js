// App bootstrap: theme → SDK client → auth gate → app shell. No app data is
// fetched or encrypted outside the SDK ('/sdk/index.js' is @cocono/client,
// served by the backend from client/src).

import { CoconoClient, IdbStorage, CoconoApiError } from '/sdk/index.js';
import { $, showView, setStatus, closeLightbox, openLightbox } from './ui.js';
import { initTheme } from './theme.js';
import { startSingleTabGuard } from './components/blocked.js';
import { createAuth } from './components/auth.js';
import { createHome } from './components/home.js';
import { createChat } from './components/chat.js';
import { setScope, setFriends, loadFriends } from './store.js';
import { initKeyboardFit } from './keyboard.js';
import { mountDiagnostics } from './diag.js';
import { applyIcons } from './icons.js';
import { initInstallAndNotify } from './install.js';
import { initBadgeNotify } from './notify.js';
import { putAppTitle, takePendingChat } from './swkv.js';

// Debug console logging: flip localStorage.setItem('cocono.debug','1') or use
// ?debug=1 before load.
const logging =
  new URL(location.href).searchParams.has('debug') || localStorage.getItem('cocono.debug') === '1';

// Mobile zoom is OFF (viewport meta above). iOS Safari has ignored
// user-scalable/no since iOS 10, so the only reliable kill switch for pinch
// zoom is cancelling Safari's gesture events. Desktop browsers are
// unaffected (gesturestart is an iOS-only API); browser page zoom stays.
for (const t of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(t, (e) => e.preventDefault());
}

// ---- my-chat deep link: /?chat=<username> (share button) ----
// A logged-out opener must NOT lose the link: capture it at boot into
// localStorage, strip the URL, and let enterApp consume it — which happens
// right after login/signup, so the conversation with the RIGHT user opens.
const SHARED_CHAT_KEY = 'cocono.shared.chat';
function captureSharedChat() {
  const url = new URL(location.href);
  const peer = String(url.searchParams.get('chat') ?? '').trim().toLowerCase();
  if (!peer) return;
  try { localStorage.setItem(SHARED_CHAT_KEY, peer); } catch { /* private mode */ }
  url.searchParams.delete('chat');
  history.replaceState(null, '', url);
}
function takeSharedChat() {
  let peer = null;
  try {
    peer = localStorage.getItem(SHARED_CHAT_KEY);
    if (peer) localStorage.removeItem(SHARED_CHAT_KEY);
  } catch { /* private mode */ }
  return peer;
}
captureSharedChat();

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

// Re-pull the SERVER friends list (the source of truth) into the local
// mirror — and detect vanishings on the way: an entry that was in our
// mirror but is NOT in the fresh list means the account behind it was
// DELETED (the deletion purges holders' lists and sends the 'gone' nudge)
// — or we removed them from another device while this one slept. The
// former must be surfaced as deleted (chat.handleGonePeer); if the account
// actually still exists, a later live contact clears the flag (openChat
// marks not-gone), so the rare false positive self-heals.
async function reconcileFriends() {
  let before = [];
  try { before = await loadFriends(); } catch { /* no mirror yet */ }
  const list = await client.listFriends();
  await setFriends(list);
  const now = new Set((list ?? []).map((e) => String(typeof e === 'string' ? e : e.u ?? e.peer ?? '').toLowerCase()));
  for (const ent of before) {
    const ul = String(ent.peer ?? '').toLowerCase();
    if (ul && !now.has(ul)) chat.handleGonePeer?.(ul).catch(() => {});
  }
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
  if (!offline) client.connect(); // offline mode: browse the local store only
  if (!offline) badgeNotify.poll(); // badges the queue awarded since last seen
  await home.renderConversationList();

  // Friends mirror: the SERVER list is the source of truth — reconcile on
  // every entry (catches events missed while offline, including accounts
  // that were deleted and purged from our list; new devices get the full
  // list here). Live changes arrive via control nudges (client.on('notice')).
  if (!offline) {
    reconcileFriends().catch(() => { /* stays on the local mirror */ });
  }

  // A notification click that cold-booted the app parked the peer in the
  // SW's IDB kv (delete-on-read): open exactly that conversation.
  takePendingChat().then((peer) => {
    if (peer) chat.openChat(peer).catch(() => {});
  }).catch(() => {});

  // Shared chat link (?chat=<username>): consumed here so it survives the
  // auth screen — whoever lands logged in or signs up mid-session gets
  // exactly that conversation opened once there is an account to open it as.
  const sharedChat = takeSharedChat();
  if (sharedChat) chat.openChat(sharedChat).catch(() => {});

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
// photo zoom: capture-phase delegation at boot, so it works regardless of
// what any component's wire() does or drops (profile sheet + settings tab)
document.addEventListener('click', (e) => {
  const el = e.target;
  if (el && el.tagName === 'IMG' && el.src && !el.hidden
    && el.closest('#profile-modal, #tabpanel-profile')) {
    openLightbox(el.src);
  }
}, true);
// lightbox dismissal: click scrim or Escape
$('lightbox-overlay')?.addEventListener('click', closeLightbox);
$('lightbox-img')?.addEventListener('click', closeLightbox);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('lightbox-overlay')?.hidden) closeLightbox(); });
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
// CONTROL NUDGES (be/src/lib/notify.js): the server says a slice of
// authoritative state THIS account caches moved because of someone else.
// Frames are content-free on purpose — the response is ALWAYS "re-read my
// own data", never "trust this payload". Each 'what' maps to one re-pull;
// the events those re-pulls fire (FRIENDS_EVENT / AVATARS_EVENT / store
// updates) do the actual repaints, so nudges share the refresh path of
// normal use instead of inventing one.
// Badge poll: login + every 60s while signed in. The server's /api/me/badges
// doubles as the dispatch queue — `new` carries awards this account has not
// seen in a modal yet (the read acks them); chat.js turns each into a queued
// badge modal.
const badgeNotify = initBadgeNotify({ client }); // poll loop + modal dispatch + OS-notification dedup in js/notify.js

client.on('notice', ({ what }) => {
  if (!client.token) return;
  if (what === 'friends' || what === 'gone') {
    // add / remove / un-add-revoke ('friends') and account-deletion purge
    // ('gone'): re-pull the list; reconcileFriends() turns vanished entries
    // into the proper deleted-icon + timeline warning (chat.handleGonePeer),
    // and setFriends fires FRIENDS_EVENT which repaints sidebar, trust
    // strip and the verification gate.
    reconcileFriends().catch(() => { /* next entry reconciles */ });
  } else if (what === 'identity') {
    // admin reviewed my account: re-read /api/me (badge, Profile-tab gate)
    home.refreshIdentity?.().catch?.(() => {});
  } else if (what === 'profile') {
    // someone I follow edited their bio/photo: re-prime the peer caches
    home.refreshPeerProfiles?.();
  } else if (what === 'badges') {
    // admin awarded/revoked a badge on MY account: skip the 60s wait —
    // poll now (dispatches any unseen-grant modal on whichever device wins
    // the ack race) and resync the picker/chip
    badgeNotify.onNotice(what); // one module owns poll + dedup + resync
  } else {
    client.logger.debug('notice: unhandled what', JSON.stringify(what));
  }
});
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
        ? 'Stored keys are not recognised for that account. Either the URL changed '
          + '(localhost vs 127.0.0.1 vs LAN IP keeps separate identities — use the '
          + 'original URL), or this device has been REMOVED from the account (by its '
          + 'owner or an admin). If you still have another device, add this one again '
          + 'with a pairing code; otherwise "Forget this device" and sign up fresh.'
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
