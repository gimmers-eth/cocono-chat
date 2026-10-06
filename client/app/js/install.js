// PWA install hint (auth screen). OS push notifications on iOS require the
// app to be ADDED TO HOME SCREEN, and installs are nicer everywhere (icon,
// standalone window, storage persistence). Browsers that expose a real
// install prompt (Chrome/Edge/Android via beforeinstallprompt) get a one-tap
// Install button; iOS Safari gets the manual recipe; once installed the hint
// never shows (standalone check).

import { $ } from './ui.js';

const DISMISS_KEY = 'cocon…t';
let deferred = null; // captured native prompt event

const isStandalone = () =>
  (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches)
  || navigator.standalone === true;

const iosLike = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) && (navigator.maxTouchPoints ?? 0) > 0;

function hide(remember = false) {
  if (remember) localStorage.setItem(DISMISS_KEY, 'off');
  const el = $('install-hint');
  if (el) el.hidden = true;
}

function render() {
  const el = $('install-hint');
  if (!el) return;
  const eligible = !isStandalone() && localStorage.getItem(DISMISS_KEY) !== 'off';
  const mode = deferred ? 'native' : iosLike() ? 'ios' : null;
  el.hidden = !(eligible && mode);
  if (el.hidden) return;
  el.querySelector('.install-native').hidden = mode !== 'native';
  el.querySelector('.install-ios').hidden = mode !== 'ios';
}

export function initInstallHint() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // keep it for our own button; don't auto-revive
    deferred = e;
    render();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    hide();
    const el = $('install-hint');
    if (el) {
      el.hidden = false;
      el.querySelector('p').textContent = 'Installed — open it from your home screen / apps list from now on.';
    }
  });

  $('btn-install')?.addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    try { await deferred.userChoice; } catch { /* dismissed */ }
    deferred = null;
    hide();
  });
  $('btn-install-dismiss')?.addEventListener('click', () => hide(true));
  render();
}
