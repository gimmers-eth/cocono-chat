// Keyboard-aware viewport fitting.
//
// Mobile browsers do NOT shrink the layout viewport for the soft keyboard
// consistently (iOS pans the document, Android Chrome depends on the
// interactive-widget mode), which pushed the chat header off-screen while
// typing. The one trustworthy source is window.visualViewport: mirror its
// height into --app-h (the .app-shell height) so the shell = what the user
// actually sees: header stays at top, the conversation stays readable
// between header and keyboard, composer sits right above the keys.

export function initKeyboardFit() {
  const vv = window.visualViewport;
  if (!vv) return; // desktop/old engines: 100dvh fallback is already right
  const root = document.documentElement;
  let raf = 0;

  function pinBottom() {
    const list = document.getElementById('chat-messages');
    if (!list) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }

  function apply() {
    root.style.setProperty('--app-h', `${Math.round(vv.height)}px`);
    // keyboard height the DOCUMENT can no longer scroll away from (body is
    // fixed): auth forms pad themselves by --kb-h so focused inputs are
    // never under the keys; the chat shell doesn't need it (it resizes).
    const covered = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    root.style.setProperty('--kb-h', `${covered}px`);
    // Safari STILL offsets the visual viewport past a fixed body when an
    // input near the keys takes focus (vv.offsetTop > 0 — exactly the
    // "composer at top, header off page" state). Undo it every event: with
    // the document locked this snaps instantly and cannot animate — the
    // shell already fits the visible area, so there is nothing to reveal.
    if (vv.offsetTop > 0 || window.scrollY > 0) window.scrollTo(0, 0);
    // Keep the newest messages above the keys as the shell resizes.
    if (document.activeElement?.id === 'chat-input') pinBottom();
  }

  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  apply();
}
