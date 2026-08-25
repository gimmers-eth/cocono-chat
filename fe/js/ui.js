// Shared DOM helpers. Stateless — no app data lives here.

export const $ = (id) => document.getElementById(id);

const VIEW_NAMES = ['auth', 'home', 'chat', 'blocked'];

// Elements are looked up lazily: view markup is injected at startup by
// views.js, after modules have loaded, so nothing may be captured at import.
export function show(name) {
  for (const key of VIEW_NAMES) {
    const el = $(`view-${key}`);
    if (el) el.hidden = key !== name;
  }
}

export function setStatus(el, message, isError = false) {
  el.textContent = message ?? '';
  el.classList.toggle('error', isError);
}

export function setBusy(busy) {
  for (const btn of document.querySelectorAll('button')) btn.disabled = busy;
}

export function fmtAgo(v) {
  if (!v) return 'never';
  const sec = Math.max(0, (Date.now() - new Date(v).getTime()) / 1000);
  if (sec < 60) return `${Math.floor(sec)}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}
