// Keyboard-aware viewport fitting.
//
// Mobile browsers do NOT shrink the layout viewport for the soft keyboard
// consistently (iOS pans the document, Android Chrome depends on the
// interactive-widget mode), which pushed the chat header off-screen while
// typing. Two tools, one philosophy — PREVENT the pan, never fight it:
//
//  1. PRE-FLIGHT: Safari pans only when the focused input would land UNDER
//     the keyboard. A pointer-down on any input happens ~150ms BEFORE the
//     keyboard (and its pan) — we shrink --app-h (and pad --kb-h) then,
//     using the last measured keyboard height (cached across sessions), so
//     the input is already visible when focus lands. No pan starts, so
//     there is nothing to snap back (every snap-back was a visible hop or
//     slide — history proved that).
//  2. MIRROR: on every visualViewport event we re-fit to the TRUTH
//     (vv.height) and re-measure the covered band; the cache learns the
//     real keyboard height for the next pre-flight.

export function initKeyboardFit() {
  const vv = window.visualViewport;
  if (!vv) return; // desktop/old engines: 100dvh fallback is already right
  const root = document.documentElement;
  let raf = 0;

  let cachedKb = 0;
  try { cachedKb = Math.max(0, Math.round(Number(localStorage.getItem('cocono.kb-h')) || 0)); } catch { /* private mode */ }

  function pinBottom() {
    const list = document.getElementById('chat-messages');
    if (!list) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }

  function fit(appH, kbH) {
    root.style.setProperty('--app-h', `${Math.round(appH)}px`);
    root.style.setProperty('--kb-h', `${Math.max(0, Math.round(kbH))}px`);
  }

  function apply() {
    fit(vv.height, Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    const cover = Math.round(window.innerHeight - vv.height - vv.offsetTop);
    if (cover > 80 && Math.abs(cover - cachedKb) > 8) { // the keyboard revealed itself: learn it
      cachedKb = cover;
      try { localStorage.setItem('cocono.kb-h', String(cover)); } catch { /* private mode */ }
    }
    if (document.activeElement?.id === 'chat-input') pinBottom();
  }

  // Pre-flight on touch/mouse down — runs BEFORE focus, BEFORE the pan.
  // (Delegated capture: any INPUT/TEXTAREA anywhere — chat composer, auth,
  // pairing, settings. No per-component wiring.)
  document.addEventListener('pointerdown', (e) => {
    if (!cachedKb) return; // first-ever keyboard: no estimate; mirror path handles it
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && !t.disabled) {
      fit(window.innerHeight - cachedKb, cachedKb);
    }
  }, { capture: true, passive: true });

  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  apply();
}
