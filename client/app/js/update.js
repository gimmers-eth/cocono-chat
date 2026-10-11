// Update notice — can THIS running page tell that a newer build is on the
// server? Two answers, best one first:
//
//   own build (real): the backend bakes the current build number into the
//   served index.html (meta[name=app-build], see be/src/app.js). A page
//   served from a STALE shell cache therefore carries a STALE number, so the
//   comparison `server build !== own build` is a fact about THIS page — not
//   a guess. It catches shells that survived a reload (classic iOS standalone
//   behaviour): the footer then says "close and re-open", because reload is
//   provably not the fix.
//
//   own build (fallback): no marker (old shell, or server without git) — the
//   best proxy is "the server build when THIS page load first talked to the
//   server", recorded FRESH on every page load. Overwriting matters: the
//   localStorage key persists across reloads, and honouring a value left by
//   an earlier session made the notice nag users who already HAD the newest
//   build, forever (the bug this comment documents).
//
// The footer version is a plain number (`v123`); on a mismatch it becomes an
// "Update available — reload" button. The click records its target, reloads,
// and the next boot either clears everything (fresh) or — only when still
// provably stale — switches to the close-and-re-open copy.

import { $ } from './ui.js';

export const BOOT_VERSION_KEY = 'cocono.appversion'; // server version at last page boot (diagnostics read this too)
const TRIED_BUILD_KEY = 'cocono.update.tried'; // server version we already reloaded for
const DEFAULT_POLL_MS = 5 * 60 * 1000;

const isNum = (v) => /^\d+$/.test(String(v ?? ''));

// build baked into THIS page's shell markup; null when there is no marker
// (old shell, unreplaced token, or server that cannot answer git)
export function ownBuild(doc = globalThis.document) {
  const content = doc?.querySelector?.('meta[name="app-build"]')?.content ?? '';
  return isNum(content) ? Number(content) : null;
}

// Short label: the number when the server speaks one, else the bare sha out
// of '<sha> (date)'.
const shortLabel = (info) => (info.build ? `v${info.build}` : `v${String(info.version).split(' ')[0]}`);

/**
 * Boot the notice. Options exist for the tests (client/test/update.test.js):
 * `fetchAppInfo` injects the wire, `getOwnBuild` injects the baked marker,
 * `pollMs: 0` disables the interval. Returns { refresh, stop }.
 */
export function initUpdateNotice({ fetchAppInfo, getOwnBuild = ownBuild, pollMs = DEFAULT_POLL_MS } = {}) {
  fetchAppInfo ??= async () => {
    try {
      const r = await fetch('/api/app-info');
      return r.ok ? await r.json() : null;
    } catch {
      return null; // offline: keep whatever the footer already says
    }
    };
  // THIS page load has not spoken to the server yet; the first answer is
  // what served us (network-first SW) and overwrites any older session's
  // record — a stale carried-over value must never drive the notice.
  let bootRecorded = false;

  const paintVersion = (info) => {
    const v = $('client-version');
    if (!v) return;
    v.textContent = shortLabel(info);
    v.title = `client build (git commit ${info.version})`;
  };

  const isStale = (info) => {
    const own = getOwnBuild();
    if (own !== null && info.build) return info.build !== own;
    return info.version !== localStorage.getItem(BOOT_VERSION_KEY);
  };

  const render = (info) => {
    if (!bootRecorded) {
      localStorage.setItem(BOOT_VERSION_KEY, info.version);
      bootRecorded = true;
    }
    paintVersion(info);
    const box = $('update-notice');
    if (!box) return;
    if (!isStale(info)) {
      localStorage.removeItem(TRIED_BUILD_KEY); // settled: fresh page, or reload took
      box.hidden = true;
      box.textContent = '';
      return;
    }
    box.hidden = false;
    box.textContent = '';
    if (localStorage.getItem(TRIED_BUILD_KEY) === info.version) {
      // we already reloaded FOR THIS EXACT BUILD and the page is still old:
      // the shell cache outlives reload — only a cold restart clears it
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
  };

  const onInfo = (info) => { if (info?.version) render(info); };
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
