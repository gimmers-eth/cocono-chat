// Install nudge + app/notifications settings — one small module.
//
// The install hint is DEFAULT UI (visible on the auth card, not hidden in a
// menu) whenever the browser can act on it:
//   • Chrome/Edge/Android: real beforeinstallprompt  -> [Install] button
//   • iOS Safari: manual recipe (Share → Add to Home Screen), because
//     installed-to-home-screen is a hard requirement for iOS web push
//   • already running installed (standalone)         -> hint hidden
// Dismissal is remembered but never silent-shown again on a fresh browser.

import { $ } from './ui.js';

const DISMISS_KEY = 'cocon…t';
export const PASSKEY_PREF_KEY = 'cocono…ref';
let deferred = null; // captured native prompt event, if the browser offers one
let clientRef = null;

const isStandalone = () =>
  (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches)
  || navigator.standalone === true;

const iosLike = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) && (navigator.maxTouchPoints ?? 0) > 0;

// 'native' | 'ios' | 'soft' | null  (null = don't show anything)
export function installMode() {
  if (isStandalone()) return null;
  if (deferred) return 'native';
  if (iosLike()) return 'ios';
  // Firefox/Linux/etc.: install exists via browser UI — gentle line only.
  return 'soft';
}

function renderHint() {
  const el = $('install-hint');
  if (!el) return;
  const mode = installMode();
  const dismissed = localStorage.getItem(DISMISS_KEY) === 'off';
  const show = mode && !(dismissed && mode !== 'native'); // a live prompt can re-offer once
  el.hidden = !show;
  if (!show) return;
  el.querySelector('.install-native').hidden = mode !== 'native';
  el.querySelector('.install-ios').hidden = mode !== 'ios';
  el.querySelector('.install-soft').hidden = mode !== 'soft';
  $('btn-install').hidden = mode !== 'native';
}

function renderDrawer({ open = false } = {}) {
  const state = $('install-state');
  const btn = $('btn-install-drawer');
  if (state) {
    const mode = installMode();
    state.textContent = mode === null ? 'Installed ✓'
      : mode === 'native' ? 'Not installed yet'
      : mode === 'ios' ? 'iPhone: Share → Add to Home Screen'
      : 'Use your browser menu to install';
  }
  if (btn) btn.hidden = installMode() !== 'native' || !open;
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
      : iosLike() && !isStandalone() ? 'On iPhone, install the app (Share → Add to Home Screen) first — iOS only allows notifications there.'
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
    renderHint();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    localStorage.removeItem(DISMISS_KEY);
    renderHint();
    renderDrawer();
    renderNotify(client);
  });

  $('btn-install')?.addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    try { await deferred.userChoice; } catch { /* dismissed */ }
    deferred = null;
    $('install-hint').hidden = true;
  });
  $('btn-install-dismiss')?.addEventListener('click', () => {
    localStorage.setItem(DISMISS_KEY, 'off');
    $('install-hint').hidden = true;
  });
  $('btn-install-drawer')?.addEventListener('click', () => deferred?.prompt?.());

  $('notify-toggle')?.addEventListener('change', async (e) => {
    e.target.disabled = true;
    try { await toggleNotify(client, e.target.checked); } finally {
      e.target.disabled = false;
      await renderNotify(client);
    }
  });

  renderHint();
  renderDrawer();
  renderNotify(client).catch(() => {});
}

/** Refresh drawer state each time the Settings drawer opens (called by home.js). */
export function refreshSettingsUI() {
  renderDrawer({ open: true });
  if (clientRef) renderNotify(clientRef).catch(() => {});
}
