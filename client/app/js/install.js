// Install + app/notifications settings — one small module.
//
// Install messaging is DEFAULT UI in two places: the auth card and the
// sidebar foot inside the app. Rules:
//   • shown on EVERY device that can act on it — native prompt available,
//     or the iOS manual recipe (Share → Add to Home Screen, a hard
//     requirement for iOS web push), or a browser-menu install line
//   • NO dismissal: the banners stay until the app actually IS installed
//     (standalone display-mode), at which point they — and the Settings
//     row — disappear entirely
//   • Chrome/Edge/Android with a live beforeinstallprompt get an [Install]
//     button right in the banner
// Both banner copies share the classes .install-hint / .btn-install and
// switch variant text via .install-native / .install-ios / .install-ios-safari
// / .install-soft — Safari on iPhone gets its own wording (Share lives in
// the BOTTOM bar there), every other iPhone browser defaults to the
// top-right copy.

import { $ } from './ui.js';

export const PASSKEY_PREF_KEY = 'cocono…ref';
let deferred = null; // captured native prompt event, if the browser offers one
let clientRef = null;

const isStandalone = () =>
  (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches)
  || navigator.standalone === true;

const iosLike = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) && (navigator.maxTouchPoints ?? 0) > 0;

// Safari vs the other iOS browsers — the install steps live in different
// places (Safari: Share in the BOTTOM bar; Chrome etc.: top right). Rules:
//   • CriOS/FxiOS/EdgiOS/OPiOS always self-report (WebKit rewrappers must)
//     -> those get the default Chrome-style copy
//   • everything else on iPhone/iPad/iPod — or a "Mac" that touches the
//     screen (iPadOS desktop-mode Safari) — with a Safari/ token is Safari
//   • unknown browsers fall through to the Chrome-style copy (default, per
//     the confirmed-correct wording on iPhone Chrome)
const iosSafari = () =>
  /CriOS|FxiOS|EdgiOS|OPiOS|Electron/.test(navigator.userAgent)
    ? false
    : (/iPhone|iPad|iPod/.test(navigator.userAgent)
        || (/Macintosh/.test(navigator.userAgent) && (navigator.maxTouchPoints ?? 0) > 1))
      && /Safari\//.test(navigator.userAgent);

// 'native' | 'ios' | 'ios-safari' | 'soft' | null  (null = don't show anything)
export function installMode() {
  if (isStandalone()) return null;
  if (deferred) return 'native';
  if (iosLike() && !iosSafari()) return 'ios'; // iPhone Chrome & co: top-right copy
  if (iosSafari()) return 'ios-safari';       // Safari: bottom-bar copy
  // Firefox/Linux/etc.: install exists via browser UI — gentle line only.
  return 'soft';
}

function renderHint() {
  const mode = installMode();
  for (const el of document.querySelectorAll('.install-hint')) {
    el.hidden = !mode; // visible until installed — nothing can dismiss it
    if (!mode) continue;
    for (const v of ['install-native', 'install-ios', 'install-ios-safari', 'install-soft']) {
      const span = el.querySelector('.' + v);
      if (span) span.hidden = v !== `install-${mode}`;
    }
    const btn = el.querySelector('.btn-install');
    if (btn) btn.hidden = mode !== 'native';
  }
}

function renderAll(opts = {}) {
  renderHint();
  renderDrawer(opts);
}

function renderDrawer({ open = false } = {}) {
  const group = $('app-install-group');
  const state = $('install-state');
  const btn = $('btn-install-drawer');
  const mode = installMode();
  // installed = nothing to show at all (not even 'Installed ✓')
  if (group) group.hidden = mode === null;
  if (state) {
    state.textContent =
      mode === 'native' ? 'Not installed yet — one tap.'
      : mode === 'ios'
        ? 'iPhone: tap Share (top right), then View more, then Add to Home Screen. Installing also turns on message notifications — iPhone only delivers them to the installed app.'
        : mode === 'ios-safari'
          ? 'iPhone Safari: tap the … icon (bottom right), Share, View more, then Add to Home Screen. Installing also turns on message notifications — iPhone only delivers them to the installed app.'
          : mode === 'soft'
            ? 'Not installed yet — choose “Install” in your browser menu.'
            : '';
  }
  if (btn) btn.hidden = mode !== 'native' || !deferred || !open;
}

// --- notifications toggle (Settings drawer) ---

async function notifyState(client) {
  if (typeof Notification === 'undefined' || !('serviceWorker' in navigator)) return 'unsupported';
  const permission = Notification.permission;
  if (permission !== 'granted') return permission; // 'default' | 'denied'
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager?.getSubscription?.();
  return sub ? 'on' : 'granted-unsubscribed';
}

async function renderNotify(client) {
  const box = $('notify-toggle');
  const hint = $('notify-hint');
  if (!box) return;
  const state = await notifyState(client);
  box.disabled = state === 'unsupported' || (iosLike() && !isStandalone() && state === 'default');
  box.checked = state === 'on';
  if (hint) {
    hint.textContent =
      state === 'unsupported' ? 'This browser cannot show web notifications.'
      : iosLike() && !isStandalone() ? 'On iPhone, install the app (Share → View more → Add to Home Screen) first — iOS only allows notifications there.'
      : state === 'denied' ? 'Notifications are blocked in browser settings — unblock them to turn this on.'
      : state === 'granted-unsubscribed' ? 'Almost — this device still needs to register its push key.'
      : state === 'on' ? 'You will be notified when messages arrive while the app is closed.'
      : '';
  }
}

async function toggleNotify(client, wantOn) {
  if (!wantOn) {
    await client.disablePush();
    return;
  }
  const res = await client.enablePush({ prompt: true });
  if (res.state === 'needs-prompt') {
    // Shouldn't happen from a click, but stay honest if it does.
    $('notify-hint').textContent = 'Tap the switch again to allow notifications.';
  }
}

// --- public init ---

export function initInstallAndNotify({ client }) {
  clientRef = client;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    renderAll({ open: document.getElementById('settings-drawer')?.hidden === false });
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    renderAll();
    renderNotify(client);
  });

  for (const btn of document.querySelectorAll('.btn-install')) {
    btn.addEventListener('click', async () => {
      if (!deferred) return;
      deferred.prompt();
      try { await deferred.userChoice; } catch { /* dismissed — banners stay */ }
      deferred = null;
      renderAll({ open: document.getElementById('settings-drawer')?.hidden === false });
    });
  }
  $('btn-install-drawer')?.addEventListener('click', () => document.querySelector('.btn-install')?.click());

  $('notify-toggle')?.addEventListener('change', async (e) => {
    e.target.disabled = true;
    try { await toggleNotify(client, e.target.checked); } finally {
      e.target.disabled = false;
      await renderNotify(client);
    }
  });

  renderAll();
  renderNotify(client).catch(() => {});
}

/** Refresh drawer state each time the Settings drawer opens (called by home.js). */
export function refreshSettingsUI() {
  renderAll({ open: true });
  if (clientRef) renderNotify(clientRef).catch(() => {});
}
