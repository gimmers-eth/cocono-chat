// Keyboard-aware viewport fitting.
//
// Mobile browsers do NOT shrink the layout viewport for the soft keyboard
// consistently (iOS pans the document/visual viewport, Android Chrome
// depends on the interactive-widget mode), which pushed the chat header
// off-screen while typing. Three tools, one philosophy — the HEADER NEVER
// MOVES; only the space between header and composer changes:
//
//  1. PRE-FLIGHT (iOS): Safari pans only when the focused input would land
//     UNDER the keyboard. The shrink must NOT happen on pointerdown: iOS
//     dispatches the synthetic mousedown/focus only AFTER touchend,
//     hit-tested against the by-then-moved layout — relocating the input
//     400px away from the finger means focus never lands and the keyboard
//     never opens. Instead we record the tap and shrink on FOCUSIN of that
//     same input: focus is already granted (it can't be lost), and the
//     synchronous re-fit still lands before the keyboard animation starts,
//     so the input is already visible when Safari decides whether to pan —
//     no pan starts, nothing to snap back. The estimate is the last
//     measured keyboard height PLUS a margin for context variance
//     (QuickType suggestions bar ≈55px, emoji panels taller; a first-ever
//     open uses a generic portrait estimate). Over-estimating is safe: the
//     shell is a little short for a moment and the mirror re-fits it.
//     Under-estimating is what re-ignites the pan-jump.
//  2. MIRROR: on every visualViewport event we re-fit to the TRUTH —
//     --app-h = vv.height (exact), --kb-h = the covered band, and
//     --vv-top = vv.offsetTop. The cache learns the real keyboard height
//     for the next pre-flight.
//  3. RIDE: if Safari did pan/scroll anyway (pre-focused fields — the
//     composer and forward search are focused programmatically, so a tap
//     fires no focusin; drawer/modal fields the shell shrink doesn't move),
//     the body's translateY(var(--vv-top)) shifts the WHOLE fixed layer cake
//     down by exactly the displacement, on the same frame we learn it —
//     net effect on screen: nothing moves, the header stays glued to the
//     top edge. iOS displaces fixed layers through TWO channels and the
//     ride must sum both (the canonical pin formula is
//     pageYOffset + vv.offsetTop): vv.offsetTop (visual-viewport pan) AND
//     window.scrollY — iOS phantom-scrolls the DOCUMENT to reveal focused
//     inputs even with html overflow:hidden + a fixed body, and that scroll
//     carries fixed elements off-screen with it.
//     Desktop/Android: both are always 0 → the ride is a no-op.

// iOS soft keyboards don't resize the layout viewport — only they pan it.
// Android Chrome resizes (interactive-widget=resizes-content in the meta),
// desktop never has a soft keyboard: pre-flight must not fire there or it
// would shrink a perfectly good desktop window on every input click.
const IS_IOS =
  /iP(hone|od|ad)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// iPhone portrait letter keyboard ≈ 291px + QuickType ≈ 55px; emoji panels
// run taller. Used only for the FIRST-EVER open (no measurement yet); the
// localStorage cache takes over after one real keyboard.
const DEFAULT_KB = 340;
// Slack added to the cached height at pre-flight: the QuickType bar appears
// and disappears per field/context, and a stale-low cache is exactly what
// lets Safari start a pan. The mirror step re-fits to the exact height once
// the keyboard settles, so the overshoot is a brief, header-stable resize.
const PRE_MARGIN = 60;
// Never pre-shrink the shell below this — a landscape phone minus a 400px
// estimate would otherwise leave a useless sliver (and the mirror fixes
// the height a beat later anyway).
const MIN_APP_H = 220;

export function initKeyboardFit() {
  const vv = window.visualViewport;
  if (!vv) return; // desktop/old engines: 100dvh fallback is already right
  const root = document.documentElement;
  let raf = 0;

  let cachedKb = 0;
  try { cachedKb = Math.max(0, Math.round(Number(localStorage.getItem('cocono.kb-h')) || 0)); } catch { /* private mode */ }

  // How much keyboard is covering the layout viewport right now (from the
  // last mirror pass) — pre-flight skips while the keyboard is already up,
  // so re-tapping a field mid-conversation can't cause a second shrink.
  let lastCover = 0;

  function pinBottom() {
    const list = document.getElementById('chat-messages');
    if (!list) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }

  function fit(appH, kbH, vvTop) {
    root.style.setProperty('--app-h', `${Math.round(appH)}px`);
    root.style.setProperty('--kb-h', `${Math.max(0, Math.round(kbH))}px`);
    root.style.setProperty('--vv-top', `${Math.max(0, Math.round(vvTop))}px`);
  }

  function apply() {
    const cover = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    lastCover = cover;
    // Keyboard closed but iOS left a phantom document scroll behind: reset
    // it (nothing can legitimately scroll — html is overflow:hidden, body
    // fixed). While the keyboard is UP we never fight the scroll — we RIDE
    // it (below); yanking it mid-animation is the old snap-back hop.
    if (cover <= 80 && window.scrollY !== 0) window.scrollTo(0, 0);
    fit(vv.height, cover, vv.offsetTop + Math.max(0, window.scrollY));
    if (cover > 80 && Math.abs(cover - cachedKb) > 8) { // the keyboard revealed itself: learn it
      cachedKb = cover;
      try { localStorage.setItem('cocono.kb-h', String(cover)); } catch { /* private mode */ }
    }
    if (document.activeElement?.id === 'chat-input') pinBottom();
  }

  // Pre-flight shrink — runs AFTER focus is granted, BEFORE the keyboard
  // (and its pan decision) arrives.
  let revertTimer = 0;
  function preflight() {
    if (!IS_IOS) return;            // Android resizes itself; desktop has no soft keyboard
    if (lastCover > 80) return;     // keyboard already up: nothing to pre-fit
    const est = cachedKb || DEFAULT_KB;
    fit(Math.max(MIN_APP_H, window.innerHeight - est - PRE_MARGIN), est + PRE_MARGIN, 0);
    // Speculative shrink: if no keyboard actually arrives (focus stolen,
    // programmatic focus that iOS declines to honour), restore the true fit
    // instead of leaving the shell stranded mid-screen.
    clearTimeout(revertTimer);
    revertTimer = setTimeout(() => { if (lastCover <= 80) apply(); }, 600);
  }

  // Tap bookkeeping: a pointerdown on an INPUT/TEXTAREA anywhere (delegated
  // capture — composer, auth, pairing, settings, forward dialog) marks that
  // element as genuinely tapped. focusin pre-flights ONLY for a tap-earned
  // focus of the SAME element within the tap window — programmatic focuses
  // (chat.js re-focuses the composer on open/after send, the forward dialog
  // autofocuses its search) must never shrink the shell: no user tap means
  // iOS may not raise a keyboard at all, and the shell would be stranded.
  let tapTarget = null;
  let tapAt = 0;
  document.addEventListener('pointerdown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && !t.disabled) {
      tapTarget = t;
      tapAt = performance.now();
    }
  }, { capture: true, passive: true });
  document.addEventListener('focusin', (e) => {
    if (e.target === tapTarget && performance.now() - tapAt < 700) preflight();
    tapTarget = null;
  });

  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  // iOS's phantom DOCUMENT scroll (the scrollY ride channel) fires window
  // scroll events that the visualViewport listeners never see.
  window.addEventListener('scroll', apply, { passive: true });
  apply();
}
