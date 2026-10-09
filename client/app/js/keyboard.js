// Keyboard-aware viewport fitting.
//
// Mobile browsers do NOT shrink the layout viewport for the soft keyboard
// consistently (iOS pans the document/visual viewport, Android Chrome
// depends on the interactive-widget mode), which pushed the chat header
// off-screen while typing. Three tools, one philosophy — the HEADER NEVER
// MOVES; only the space between header and composer changes:
//
//  1. PRE-FLIGHT (iOS): Safari pans only when the focused input would land
//     UNDER the keyboard. A pointer-down happens ~150ms BEFORE the
//     keyboard — we shrink --app-h then, using the last measured
//     keyboard height PLUS a margin for context variance (QuickType
//     suggestions bar ≈55px, emoji panels taller; a first-ever open uses a
//     generic portrait estimate). Over-estimating is safe: the shell is a
//     little short for a moment and no pan ever starts. Under-estimating
//     is what re-ignited the pan-jump this module exists to kill.
//  2. MIRROR: on every visualViewport event we re-fit to the TRUTH —
//     --app-h = vv.height (exact), --kb-h = the covered band, and
//     --vv-top = vv.offsetTop. The cache learns the real keyboard height
//     for the next pre-flight.
//  3. RIDE: if Safari did pan (offsetTop > 0), the body's
//     translateY(var(--vv-top)) shifts the WHOLE fixed layer cake down by
//     exactly the pan amount on the same frame we learn it — net effect on
//     screen: nothing moves, the header stays glued to the top edge.
//     Desktop/Android: offsetTop is always 0 → the ride is a no-op.

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
    fit(vv.height, cover, vv.offsetTop);
    if (cover > 80 && Math.abs(cover - cachedKb) > 8) { // the keyboard revealed itself: learn it
      cachedKb = cover;
      try { localStorage.setItem('cocono.kb-h', String(cover)); } catch { /* private mode */ }
    }
    if (document.activeElement?.id === 'chat-input') pinBottom();
  }

  // Pre-flight shrink — runs BEFORE focus, BEFORE any pan can start.
  let revertTimer = 0;
  function preflight() {
    if (!IS_IOS) return;            // Android resizes itself; desktop has no soft keyboard
    if (lastCover > 80) return;     // keyboard already up: nothing to pre-fit
    const est = cachedKb || DEFAULT_KB;
    fit(Math.max(MIN_APP_H, window.innerHeight - est - PRE_MARGIN), est + PRE_MARGIN, 0);
    // Speculative shrink: if no keyboard actually arrives (tap swallowed,
    // focus stolen), restore the true fit instead of leaving the shell
    // stranded mid-screen.
    clearTimeout(revertTimer);
    revertTimer = setTimeout(() => { if (lastCover <= 80) apply(); }, 600);
  }

  // Delegated capture: any INPUT/TEXTAREA anywhere — chat composer, auth,
  // pairing, settings. No per-component wiring. POINTERDOWN only, never
  // focusin: chat.js programmatically re-focuses the composer (open chat,
  // after send) and on iOS that fires focusin WITHOUT a keyboard following
  // — a pre-flight there shrank the shell with nothing to restore it
  // (composer stranded mid-page). A soft keyboard on iOS always needs a
  // real tap, and pointerdown catches every one of those.
  document.addEventListener('pointerdown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && !t.disabled) preflight();
  }, { capture: true, passive: true });

  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  apply();
}
