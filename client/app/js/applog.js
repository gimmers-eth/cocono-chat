// THE CLIENT-SIDE ERROR JOURNAL — how a phone tells us what happened.
//
// This is the channel, and it is deliberately boring and universal: every
// failure path in the app should end up here (not in a `catch { /* ignore */ }`
// that only a developer with a cable can see), because the only way we learn
// anything from a device we cannot inspect is the report the USER chooses to
// send — Settings or the icon by the version number → preview → confirm.
//
// Design notes that matter to whoever adds a line:
//  * PERSISTED in localStorage, not memory: the flow we care about is
//    "the video failed, the app was closed, they found the button five
//    minutes later". A ring that dies with the tab reports nothing.
//  * SHORT LINES ONLY. The report is displayed in a modal and uploaded as
//    text; a stack trace is noise, a code + one message is the signal.
//  * NEVER put content in here. No message text, no filenames, no peer names,
//    no blob ids beyond what already leaks into the rest of the report: this
//    leaves the device E2EE-free by design, and the user is told that.
//  * Capped and self-trimming; a journal that can grow without bound is a
//    storage leak disguised as logging.
//
// `collectDiagnostics()` (js/diag.js) folds this in beside the service-worker
// ring and the storage snapshot; the server stores it in the `diagnostics`
// collection (30-day TTL) for the admin panel.

const KEY = 'cocono.applog';
const CAP = 40;
const startedAt = Date.now();

const read = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];                              // private mode, quota, or a hand-edit
  }
};

const write = (rows) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(rows.slice(-CAP)));
  } catch { /* logging must never be the thing that breaks a flow */ }
};

/**
 * One journal line. `kind` is a short machine-ish tag ('media', 'send',
 * 'poster', 'uncaught'), `msg` is the human part. Keep both stable: grepping
 * these strings is how a pile of reports becomes a pattern.
 */
export function logEvent(kind, msg) {
  const rows = read();
  rows.push({ t: Date.now(), rel: Math.round((Date.now() - startedAt) / 1000), kind, msg: String(msg ?? '').slice(0, 160) });
  write(rows);
  try { console.warn(`[cocono:${kind}] ${msg}`); } catch { /* no console (worker-ish hosts) */ }
  return rows.length;
}

/** Log a caught error by its CODE first — codes are the part that travels. */
export function logError(where, err) {
  const code = err?.code ?? err?.name ?? (typeof err === 'string' ? err : 'Error');
  const status = err?.status ? ` http ${err.status}` : '';
  const extra = err?.bytes ? ` bytes ${err.bytes}` : '';
  return logEvent(where, `${code}${status}${extra} ${String(err?.message ?? err ?? '').slice(0, 90)}`.trim());
}

/** Newest last, ready to print in the report. */
export function appLogLines(n = 14) {
  const rows = read().slice(-n);
  if (!rows.length) return ['no app errors logged since install'];
  return rows.map((r) => `+${r.rel ?? 0}s ${r.kind}: ${r.msg}`);
}

export function clearAppLog() {
  try { localStorage.removeItem(KEY); } catch { /* nothing to clear */ }
}

/**
 * Install the catch-all handlers, called once at boot (main.js). Without these
 * the journal only contains errors someone remembered to log — and the class of
 * bug we most want reported (a module throwing during a tap) is precisely the
 * one nobody annotates in advance.
 */
export function installErrorCapture() {
  if (typeof window === 'undefined' || window.__coconoErrCaptured) return false;
  window.__coconoErrCaptured = true;
  let lastSeen = '';
  const once = (line) => {
    // a page that is actually broken spams the same error; the ring must not be
    // drowned by it (and a repeated line teaches us nothing new)
    if (line === lastSeen) return;
    lastSeen = line;
    logEvent('uncaught', line);
  };
  window.addEventListener('error', (e) => {
    once(`${e?.message ?? 'script error'} @ ${shorten(e?.filename)}:${e?.lineno ?? '?'}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e?.reason;
    once(`${r?.code ?? r?.name ?? 'rejection'} ${String(r?.message ?? r).slice(0, 100)}`);
  });
  return true;
}

const shorten = (href) => (typeof href === 'string' ? href.replace(/^https?:\/\/[^/]+/, '') : '?');
