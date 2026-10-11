// Update notice — the version at the bottom of the settings drawer is the
// build THAT SERVER served when this page booted. The server reports its
// current build at /api/app-info as a plain number (`git rev-list --count`),
// so "an update shipped" is one string comparison away:
//
//   boot:   remember the server's build (network-first SW means this page and
//           this number normally come from the same deploy)
//   poll:   every few minutes (and whenever the tab/app becomes visible) ask
//           the server again; a different number means THIS running page is
//           old — the footer version turns into an "Update — reload" button
//   reload: the click records the target build, then reloads. A fresh page
//           boots at the new build and clears the record. If a reload already
//           ran but the page STILL boots old (some app shells re-serve their
//           cached bundle), the button gives up and says "close and re-open".
//
// Known blind spot: a page booted FROM a stale cache records the NEW server
// build as its boot build, so it cannot tell it is one deploy behind until
// the NEXT deploy. Detecting the served bundle itself would need build-time
// hash injection into the shell; the reload path above covers the practical
// cases (page kept open across a deploy, or woken from background).

import { $ } from './ui.js';

export const BOOT_VERSION_KEY = 'cocono.appversion'; // what served THIS page (git identity)
const TRIED_BUILD_KEY = 'cocono.update.tried'; // server version we already reloaded for once
const DEFAULT_POLL_MS = 5 * 60 * 1000;

// Short label for the footer/banner: the number when the server speaks one,
// else the bare sha out of '<sha> (date)'.
const shortLabel = (info) => (info.build ? `v${info.build}` : `v${String(info.version).split(' ')[0]}`);

function paintVersion(info) {
  const v = $('client-version');
  if (!v) return;
  v.textContent = shortLabel(info);
  v.title = `client build (git commit ${info.version})`;
}

function renderUpdate(info) {
  const box = $('update-notice');
  if (!box) return;
  const boot = localStorage.getItem(BOOT_VERSION_KEY);
  const fresh = !boot || boot === info.version;
  if (fresh) {
    // this page IS the current build (or we only just learned it): nothing
    // to nag about, and any earlier reload attempt is settled
    localStorage.removeItem(TRIED_BUILD_KEY);
    box.hidden = true;
    box.textContent = '';
    return;
  }
  box.hidden = false;
  box.textContent = '';
  if (localStorage.getItem(TRIED_BUILD_KEY) === info.version) {
    // Reloaded for exactly this build and STILL an old page: the shell is
    // serving its cached bundle past reload (classic iOS standalone behaviour).
    const p = document.createElement('span');
    p.className = 'update-manual';
    p.textContent = `${shortLabel(info)} is out — reload did not take. Close the app completely and open it again.`;
    box.append(p);
    return;
  }
  const btn = document.createElement('button');
  btn.className = 'btn btn-small btn-primary btn-update';
  btn.id = 'btn-update-reload';
  btn.textContent = `Update available — ${shortLabel(info)}. Reload`;
  btn.addEventListener('click', () => {
    localStorage.setItem(TRIED_BUILD_KEY, info.version);
    globalThis.location?.reload?.();
  });
  box.append(btn);
}

/**
 * Boot the notice. Options exist for the tests (client/test/update.test.js):
 * `fetchAppInfo` injects the wire, `pollMs: 0` disables the interval.
 * Returns { refresh, stop }.
 */
export function initUpdateNotice({ fetchAppInfo, pollMs = DEFAULT_POLL_MS } = {}) {
  fetchAppInfo ??= async () => {
    try {
      const r = await fetch('/api/app-info');
      return r.ok ? await r.json() : null;
    } catch {
      return null; // offline: keep whatever the footer already says
    }
  };
  const onInfo = (info) => {
    if (!info?.version) return;
    if (!localStorage.getItem(BOOT_VERSION_KEY)) localStorage.setItem(BOOT_VERSION_KEY, info.version);
    paintVersion(info);
    renderUpdate(info);
  };
  const refresh = async () => onInfo(await fetchAppInfo());

  refresh().catch(() => {});
  const timer = pollMs > 0 && setInterval(refresh, pollMs);
  const onVis = () => { if (document.visibilityState === 'visible') refresh(); };
  document.addEventListener?.('visibilitychange', onVis);
  return {
    refresh,
    stop() {
      if (timer) clearInterval(timer);
      document.removeEventListener?.('visibilitychange', onVis);
    },
  };
}
