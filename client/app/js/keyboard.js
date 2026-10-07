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
    // iOS pans the document when focusing an input near the bottom edge:
    // the shell is now short enough that the input is visible anyway —
    // undo the pan so the header stays on screen.
    if (document.activeElement?.tagName === 'INPUT') window.scrollTo(0, 0);
    // Keep the newest messages above the keys while the height animates.
    if (document.activeElement?.id === 'chat-input') pinBottom();
  }

  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  // The shell height eases over ~180ms (css transition); the rAF pin above
  // can land mid-animation, so re-pin once the transition settles too.
  document.querySelector('.app-shell')?.addEventListener('transitionend', (e) => {
    if (e.propertyName === 'height' && document.activeElement?.id === 'chat-input') pinBottom();
  });
  apply();
}
