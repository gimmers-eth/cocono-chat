// Storage diagnostics: "Send diagnostics" buttons (auth card footer, the
// version row in the sidebar, and the Settings drawer) open a modal previewing
// WHAT THE BROWSER ACTUALLY KEPT (databases, identity records, quota) and
// EVERY ERROR THE APP JOURNALLED (js/applog.js — uncaught exceptions, rejections,
// media/send/poster/retention failures). The report is uploaded ONLY when the
// user confirms in the modal, so phones without a web inspector can still report
// their condition, visibly and on purpose.
//
// THIS IS THE CLIENT-DATA CHANNEL. Server logs show what the server saw; this is
// the only way to learn what happened ON A DEVICE. Consequences for anyone
// adding code:
//   * a `catch` that swallows an error should logError()/logEvent() it first —
//     if it is unreachable from a phone, it is unfalsifiable;
//   * new failure kinds get a SHORT STABLE TAG ('media', 'poster', 'send'),
//     because grepping reports is how a pile of them becomes a pattern;
//   * nothing conversational or identifying goes in: the report leaves the
//     device unencrypted by design and the user is told that, so the same
//     discipline as the push payload applies (see docs/PROJECT_STATUS.md,
//     "Diagnostics", and the cocono-ops skill).
// Server side: POST /api/diagnostics → `diagnostics` collection, 30-day TTL,
// visible in the admin panel (Diagnostics page).

import { $ } from './ui.js';
import { iconEl } from './icons.js';
import { readSwLog } from './swkv.js';
import { keyboardLogLines } from './keyboard.js';
import { appLogLines } from './applog.js';

const idb = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });

const kb = (n) => `${Math.round((n ?? 0) / 1024)}kB`;
const mb = (n) => `${Math.round((n ?? 0) / 1048576)}MB`;
const trunc = (s, n = 90) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));

async function identityStoreLines() {
  const SDK_DB = 'cocono-client-sdk';
  if (!indexedDB.databases) return 'identity store: indexedDB.databases() unsupported here';
  const dbs = await indexedDB.databases();
  if (!dbs.find((d) => d.name === SDK_DB)) return `identity store: '${SDK_DB}' database NOT PRESENT`;
  const db = await idb(indexedDB.open(SDK_DB));
  try {
    if (!db.objectStoreNames.contains('identity')) return `identity store: '${SDK_DB}' has no 'identity' store`;
    const store = db.transaction('identity', 'readonly').objectStore('identity');
    const keys = await idb(store.getAllKeys());
    if (!keys.length) return `identity store: '${SDK_DB}' present but EMPTY (no identity, no pointer)`;
    const parts = [];
    for (const key of keys) {
      const val = await idb(store.get(key));
      if (key === 'current') parts.push(`current=${val ?? 'null'}`);
      else if (key === 'me') parts.push('legacy "me" record present');
      else if (val && val.username) parts.push(`${key} → ${val.username}/${val.deviceId}`);
      else parts.push(`${key} → (unreadable value!)`);
    }
    return `identity store: ${parts.join(', ')}`;
  } finally {
    db.close();
  }
}

export async function collectDiagnostics() {
  const lines = [];
  const attempt = async (label, fn) => {
    try {
      lines.push(`${label}: ${await fn()}`);
    } catch (err) {
      lines.push(`${label}: FAILED (${err?.name ?? 'Error'}: ${err?.message ?? err})`);
    }
  };

  lines.push(`--- ${new Date().toISOString()} ---`);
  lines.push(`origin: ${location.origin}`);
  lines.push(`ua: ${trunc(navigator.userAgent)}`);
  await attempt('indexeddb', async () => {
    const dbs = indexedDB.databases ? await indexedDB.databases() : [];
    return dbs.length
      ? dbs.map((d) => `${d.name}@${d.version} (${kb(d.size)})`).join(', ')
      : 'none present';
  });
  await attempt('identities', identityStoreLines);
  await attempt('localStorage', () => {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith('cocono'));
    return keys.length ? keys.join(', ') : 'no cocono keys';
  });
  await attempt('version', async () => {
    const cached = localStorage.getItem('cocono.appversion') ?? 'never-loaded';
    let live = '?';
    try {
      const r = await fetch('/api/app-info');
      if (r.ok) live = (await r.json()).version ?? '?';
    } catch { /* offline */ }
    return `page ${cached} / server ${live}${cached === live ? '' : '  <-- MISMATCH (stale bundle?)'}`;
  });
  await attempt('sw-log', async () => {
    const arr = await readSwLog(8);
    if (!arr.length) return 'no service-worker events logged';
    return '\n' + arr
      .map((e) => `${new Date(e.at).toISOString().slice(11, 19)} ${e.kind}: ${e.msg}`)
      .join('\n');
  });
  await attempt('keyboard-fit', async () => `cachedKb=${localStorage.getItem('cocono.kb-h') ?? '-'}\n${keyboardLogLines().join('\n')}`);
  // the app's own error journal — the part that turns "video doesn't work" into
  // a line with a code on it
  await attempt('app-errors', async () => appLogLines(16).join('\n'));
  await attempt('storage', async () => {
    const est = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : 'n/a';
    return `usage ${kb(est.usage)} / quota ${mb(est.quota)}, persistent=${persisted}`;
  });
  return lines.join('\n');
}

// --- modal + buttons ---

const els = () => ({
  overlay: $('diag-modal-overlay'),
  modal: $('diag-modal'),
  report: $('diag-modal-report'),
  send: $('btn-diag-modal-send'),
  status: $('diag-modal-status'),
  close: $('btn-diag-modal-close'),
});

function closeModal() {
  const { overlay, modal } = els();
  if (overlay) overlay.hidden = true;
  if (modal) modal.hidden = true;
}

function openModal(client) {
  const { overlay, modal, report, status } = els();
  if (!modal) return;
  report.textContent = 'Collecting…';
  status.textContent = '';
  overlay.hidden = false;
  modal.hidden = false;
  collectDiagnostics().then((text) => {
    // Ignore the result if the modal was closed meanwhile.
    if (!modal.hidden) report.textContent = text;
  });
}

/** Mount the page-footer button and wire both entry points + the modal. */
export function mountDiagnostics({ client }) {
  // The version row in the sidebar: an icon to the RIGHT of the build number.
  // That row is where a user looks when something is wrong (it is the line that
  // says which build they are running), so it is where the button belongs — and
  // it opens the SAME modal, which still requires an explicit Send: an icon in
  // the chrome must not be able to upload a snapshot of the device on a stray
  // tap. Hidden on the login screen, where the page footer already has one.
  const versionEl = $('client-version');
  if (versionEl && versionEl.parentElement && !$('btn-diag-version')) {
    const btn = document.createElement('button');
    btn.id = 'btn-diag-version';
    btn.type = 'button';
    btn.className = 'icon-btn diag-version-btn';
    btn.title = 'Send diagnostics — what happened on this device';
    btn.append(iconEl('tabDiagnostics'));
    btn.addEventListener('click', () => openModal(client));
    versionEl.parentElement.insertBefore(btn, $('update-notice') ?? null);
  }

  // Page footer (visible on the login screen): just a button — clicking it
  // previews the report in the modal.
  const footer = $('page-footer');
  if (footer && !$('btn-diag-send')) {
    const row = document.createElement('div');
    row.className = 'diag-row';
    const btn = document.createElement('button');
    btn.id = 'btn-diag-send';
    btn.className = 'btn btn-small';
    btn.textContent = 'Send diagnostics';
    row.append(btn);
    footer.append(row);
  }

  for (const id of ['btn-diag-send', 'btn-diag-send-drawer']) {
    const btn = $(id);
    if (btn && !btn.dataset.wired) {
      btn.dataset.wired = '1';
      btn.addEventListener('click', () => openModal(client));
    }
  }

  const { overlay, send, status, close } = els();
  if (send) {
    send.addEventListener('click', async () => {
      send.disabled = true;
      status.textContent = 'Sending…';
      try {
        await client.sendDiagnostics($('diag-modal-report').textContent);
        status.textContent = 'Sent — thank you.';
        setTimeout(closeModal, 1200);
      } catch (err) {
        status.textContent = `Could not send (${err?.message ?? err}).`;
      } finally {
        send.disabled = false;
      }
    });
  }
  close?.addEventListener('click', closeModal);
  overlay?.addEventListener('click', closeModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els().modal && !els().modal.hidden) closeModal();
  });
}
