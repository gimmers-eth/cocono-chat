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
  // No JS lift needed: keyboard.js keeps the BODY (this toast's containing
  // block — position:fixed + transform) fitted to the visible band above the
  // keyboard, so the CSS bottom offset already sits the pill above any keys.
  el.hidden = false;
  toastTimer = setTimeout(() => { el.hidden = true; }, 4500);
}

/**
 * Animate a sheet + its scrim OUT, then flip `hidden` when the exit lands.
 * Logic stays synchronous (callers flip their own open-flags immediately);
 * only the hide is deferred. reopenCheck() lets a fast re-open cancel the
 * hide (the sheet was never display-toggled during the exit).
 */
export function animateSheetClose(sheet, overlay, { ms = 260, reopenCheck = () => false } = {}) {
  const done = () => {
    sheet.classList.remove('closing');
    if (overlay) overlay.classList.remove('closing');
    if (reopenCheck()) return;
    sheet.hidden = true;
    if (overlay) overlay.hidden = true;
  };
  if (sheet.hidden || !window.matchMedia?.('(prefers-reduced-motion: no-preference)').matches) { done(); return; }
  let settled = false;
  const once = () => { if (!settled) { settled = true; done(); } };
  sheet.addEventListener('animationend', once, { once: true });
  setTimeout(once, ms); // failsafe (backgrounded tabs can stall animations)
  if (overlay) overlay.classList.add('closing');
  sheet.classList.add('closing');
}

export function setBusy(busy) {
  for (const btn of document.querySelectorAll('button')) btn.disabled = busy;
}

/**
 * Promise-based confirm dialog: resolves true on confirm, false on cancel /
 * scrim / Escape. Falls back to window.confirm if the markup is missing.
 */
// bodyEl: pass a NODE instead of plain text (rendered inside confirm-body)
// for interactive payloads like the block-reason choice list.
// validate: gate OK on a live predicate (e.g. "a reason is selected") —
// while false, OK stays disabled; the owner keeps the modal open until truth.
let validateCleanup = null;
const clearValidateHook = () => { validateCleanup?.(); validateCleanup = null; };

export function confirmModal({ title, body, bodyEl, footerEl = null, okLabel = 'Confirm', danger = false, warning = '', subline = '', validate = null }) {
  const overlay = $('confirm-overlay');
  const modal = $('confirm-modal');
  if (!modal || !overlay) return Promise.resolve(window.confirm(`${title}\n\n${body}`));
  $('confirm-title').textContent = title;
  const bodyTarget = $('confirm-body');
  if (bodyEl) {
    bodyTarget.textContent = '';
    bodyTarget.append(bodyEl);
  } else {
    bodyTarget.textContent = body;
  }
  const warnEl = $('confirm-warning');
  if (warnEl) {
    warnEl.textContent = warning;
    warnEl.hidden = !warning;
  }
  // footerEl: content BELOW the action row (the trust modal's warning box
  // belongs under the button — it's a consequence statement, not a prompt)
  const footEl = $('confirm-footer');
  if (footEl) {
    footEl.replaceChildren(footerEl ?? '');
    footEl.hidden = !footerEl;
  }
  const subEl = $('confirm-subline');
  if (subEl) {
    subEl.textContent = subline;
    subEl.hidden = !subline;
  }
  const ok = $('btn-confirm-ok');
  ok.textContent = okLabel;
  ok.classList.toggle('btn-danger', danger);
  // EVERY modal opens from a clean OK state: a previous validated modal
  // (block reason) may have left the button disabled — the flag belongs to
  // the CURRENT modal only. validate() below re-disables instantly if this
  // modal's own predicate says so.
  ok.disabled = false;
  if (validate) {
    // drop any PREVIOUS validate wiring before hooking: stale listeners on
    // the persistent #confirm-body would fire against an old modal's state
    // and fight over the OK button of the next one
    clearValidateHook?.();
    const sync = () => { ok.disabled = !validate(); };
    bodyTarget.addEventListener('change', sync);
    validateCleanup = () => bodyTarget.removeEventListener('change', sync);
    sync();
  } else {
    clearValidateHook?.();
  }
  return new Promise((resolve) => {
    const done = (value) => {
      overlay.hidden = true;
      modal.hidden = true;
      // leave NO residue for the next modal: drop the change-listener and
      // hand the disabled flag back neutral
      clearValidateHook();
      ok.disabled = false;
      if (footEl) { footEl.replaceChildren(); footEl.hidden = true; }
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
// `round` is the frame, not a preference: the lightbox was born as an AVATAR
// zoom (square-cropped photo → circle looks intentional), but an expanded
// chat photo is any aspect ratio and a 50% radius would carve its corners off —
// i.e. hide part of the picture. Media passes { round: false }.
export function openLightbox(src, { round = true } = {}) {
  const overlay = $('lightbox-overlay');
  const img = $('lightbox-img');
  if (!overlay || !img || !src) return;
  img.classList?.toggle('is-round', round);
  img.src = src;
  img.hidden = false;   // the <img> ships hidden — un-hide it or the zoom is invisible
  overlay.hidden = false;
}
export function closeLightbox() {
  const overlay = $('lightbox-overlay');
  const img = $('lightbox-img');
  if (overlay) overlay.hidden = true;
  if (img) { img.hidden = true; img.removeAttribute('src'); }
}
