// Small stateless DOM helpers shared by the components.

export const $ = (id) => document.getElementById(id);

const VIEW_NAMES = ['auth', 'app', 'blocked'];

export function showView(name) {
  const el = $(`view-${name}`);
  if (!el) return;
  for (const key of VIEW_NAMES) {
    const v = $(`view-${key}`);
    if (v) v.hidden = key !== name;
  }
  if (name !== 'app') document.body.classList.remove('chat-open');
  document.body.dataset.view = name; // lets CSS scope per-view chrome (footer)
}

export function setChatOpen(open) {
  document.body.classList.toggle('chat-open', open);
}

export function setStatus(el, message, isError = false) {
  if (!el) return;
  el.textContent = message ?? '';
  el.classList.toggle('error', Boolean(isError));
}

// Transient toast pill (errors & short confirmations) — floats above the
// composer, auto-dismisses. Replaces the old always-present chat status
// line, whose min-height was a permanent gap below the input.
let toastTimer = null;
export function toast(message, kind = '') {
  const el = document.getElementById('toast');
  if (!el) return;
  clearTimeout(toastTimer);
  if (!message) { el.hidden = true; return; } // empty = dismiss, never show
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  toastTimer = setTimeout(() => { el.hidden = true; }, 4500);
}

export function setBusy(busy) {
  for (const btn of document.querySelectorAll('button')) btn.disabled = busy;
}

/**
 * Promise-based confirm dialog: resolves true on confirm, false on cancel /
 * scrim / Escape. Falls back to window.confirm if the markup is missing.
 */
export function confirmModal({ title, body, okLabel = 'Confirm', danger = false, warning = '', subline = '' }) {
  const overlay = $('confirm-overlay');
  const modal = $('confirm-modal');
  if (!modal || !overlay) return Promise.resolve(window.confirm(`${title}\n\n${body}`));
  $('confirm-title').textContent = title;
  $('confirm-body').textContent = body;
  const warnEl = $('confirm-warning');
  if (warnEl) {
    warnEl.textContent = warning;
    warnEl.hidden = !warning;
  }
  const subEl = $('confirm-subline');
  if (subEl) {
    subEl.textContent = subline;
    subEl.hidden = !subline;
  }
  const ok = $('btn-confirm-ok');
  ok.textContent = okLabel;
  ok.classList.toggle('btn-danger', danger);
  return new Promise((resolve) => {
    const done = (value) => {
      overlay.hidden = true;
      modal.hidden = true;
      ok.removeEventListener('click', onOk);
      $('btn-confirm-cancel').removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onKey = (e) => { if (e.key === 'Escape') done(false); };
    ok.addEventListener('click', onOk);
    $('btn-confirm-cancel').addEventListener('click', onCancel);
    overlay.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
    overlay.hidden = false;
    modal.hidden = false;
    ok.focus?.();
  });
}

/** WhatsApp-style conversation time: today → HH:MM, this week → weekday, else date. */
export function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (dayDiff === 0) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (dayDiff > 0 && dayDiff < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Lightbox: click any profile photo (own tab or peer's profile sheet) to
// view it large over a dim scrim; click/Esc closes. data: URLs stay in-DOM
// (top-level data: navigation is blocked by browsers, so no new tab here).
export function openLightbox(src) {
  const overlay = $('lightbox-overlay');
  const img = $('lightbox-img');
  if (!overlay || !img || !src) return;
  img.src = src;
  overlay.hidden = false;
}
export function closeLightbox() {
  const overlay = $('lightbox-overlay');
  const img = $('lightbox-img');
  if (overlay) overlay.hidden = true;
  if (img) img.removeAttribute('src');
}
