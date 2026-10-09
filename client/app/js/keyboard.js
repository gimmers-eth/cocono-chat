// Keyboard-aware viewport fitting.
//
// Mobile browsers do NOT shrink the layout viewport for the soft keyboard
// consistently (iOS pans the document/visual viewport, Android Chrome
// depends on the interactive-widget mode), which pushed the chat header
// off-screen while typing. Three tools, one philosophy — the HEADER NEVER
// MOVES; only the space between header and composer changes:
//
//  1. PRE-FLIGHT (iOS, BROWSER TABS ONLY): tab-mode Safari pans when the
//     focused input would land UNDER the keyboard — the installed PWA's
//     webview RESIZES instead, so standalone skips pre-flight entirely (see
//     IS_STANDALONE) and gets a deferred shove in the mirror pass. In tab
//     mode the shrink must NOT happen on pointerdown: iOS
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
//  3. SQUASH + DEBOUNCED RIDE: iOS still likes to start a reveal scroll
//     computed from the PRE-shrink geometry even though pre-flight already
//     made the field visible — and cancels it ~16ms later, animating the
//     restore itself. Document scroll (scrollY) is SQUASHED per frame
//     (scrollTo(0,0), capped); a visual-viewport pan (offsetTop) is ridden
//     via translateY(var(--vv-top)) on body.kb-fit ONLY if it PERSISTS
//     (>120ms) — riding the transient ones snapped the body down and back
//     (the reported "instant down, slow up" dip).
//     The whole module is TOUCH-ONLY (pointer: coarse adds body.kb-fit):
//     on desktop a pinch-zoom looks exactly like a keyboard to the old
//     math (vv.height < innerHeight), the ride dragged the sidebar around
//     on focus changes, and the body transform re-anchored the fixed
//     settings drawer. Desktop now keeps pristine viewport-anchored
//     fixed layers and the 100dvh fallback.

// Ring buffer of keyboard-fit samples for the Diagnostics report — iOS
// keyboard behaviour cannot be reproduced off-device, so the phone itself
// has to tell us what Safari did: every sample is one event with the raw
// viewport numbers and what we set in response.
const LOG_MAX = 60;
const log = [];
let t0 = 0;

/** Formatted keyboard-fit trace for collectDiagnostics() (newest last). */
export function keyboardLogLines() {
  if (!log.length) return ['no visualViewport events recorded (desktop, or module never ran)'];
  return log.slice();
}

// iOS soft keyboards don't resize the layout viewport — only they pan it.
// Android Chrome resizes (interactive-widget=resizes-content in the meta),
// desktop never has a soft keyboard: pre-flight must not fire there or it
// would shrink a perfectly good desktop window on every input click.
const IS_IOS =
  /iP(hone|od|ad)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// Installed PWA (Add to Home Screen). CRITICAL behavioural fork proven by
// the device traces: the standalone WKWebView RESIZES itself for the
// keyboard (innerHeight 894→481 in one near-instant native step, zero
// visual-viewport pan) while tab-mode Safari PANS instead. Two standalone
// facts the rounds since have nailed down: (1) viewport units (dvh) are
// FROZEN through that resize — the shell must be JS-fitted in px; (2) in
// the focus→resize gap WKWebView natively scroll-to-reveals the first
// responder and animates the undo — scroll events fire with scrollY
// already restored, so the squash cannot catch it; only the pre-flight
// (shell already fitted before the resize lands) removes its reason to
// move. Hence standalone runs the SAME pre-flight + px mirror as tab
// mode; what it does NOT need is the pan ride (vvT is always 0 there).
const IS_STANDALONE =
  !!window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;

// iPhone portrait letter keyboard ≈ 291px + QuickType ≈ 55px; emoji panels
// run taller. Used only for the FIRST-EVER open (no measurement yet); the
// localStorage cache takes over after one real keyboard.
const DEFAULT_KB = 340;
// Slack added to the keyboard estimate at pre-flight — but ONLY for the
// first-ever open (DEFAULT_KB is a guess). A LEARNED cache is device truth:
// overshooting it left a visible two-step (trace: appH 421 → 481, a 60px
// gap under the composer that closed a beat later). Under-estimating (e.g.
// QuickType bar reappearing) is now cheap: the per-frame squash in apply()
// absorbs the reveal scroll iOS would animate.
const PRE_MARGIN = 60;
// Never pre-shrink the shell below this — a landscape phone minus a 400px
// estimate would otherwise leave a useless sliver (and the mirror fixes
// the height a beat later anyway).
const MIN_APP_H = 220;

export function initKeyboardFit() {
  const vv = window.visualViewport;
  if (!vv) return; // ancient engines: 100dvh fallback is already right
  // TOUCH DEVICES ONLY. Desktop never grows a soft keyboard, and the
  // machinery is actively harmful there: a desktop pinch-zoom makes
  // vv.height < innerHeight (cover > 0 — a phantom "keyboard"), the
  // ride translates the body on every zoom-scroll (the whole sidebar
  // visibly shifts when buttons are clicked), and the body transform
  // re-anchors every fixed overlay (settings drawer included) to the
  // body box. Gated out: desktop keeps pristine 100dvh, viewport-
  // anchored fixed layers, zero listeners.
  if (!window.matchMedia || !window.matchMedia('(pointer: coarse)').matches) return;
  const root = document.documentElement;
  // Opt the body into the ride transform — TAB MODE ONLY. Standalone rides
  // nothing: its webview resizes natively, the body is flow-positioned (see
  // the display-mode rule in base.css) and 100dvh tracks the resize per
  // frame; a transform there would only re-anchor the fixed overlays.
  if (!IS_STANDALONE) document.body.classList.add('kb-fit');
  let raf = 0;
  t0 = performance.now();

  let cachedKb = 0;
  try { cachedKb = Math.max(0, Math.round(Number(localStorage.getItem('cocono.kb-h')) || 0)); } catch { /* private mode */ }

  // How much keyboard is covering the layout viewport right now (from the
  // last mirror pass) — pre-flight skips while the keyboard is already up,
  // so re-tapping a field mid-conversation can't cause a second shrink.
  let lastCover = 0;

  // Per-keyboard-session squash budget (see apply): transient reveal
  // scrolls die within a frame or two; if iOS keeps re-scrolling past this,
  // the field is genuinely covered and fighting it would only jitter.
  let squashCount = 0;
  const SQUASH_MAX = 8;

  // Ride debounce: only an offset that PERSISTS this long is worth a
  // visible correction (transient pans self-restore; see apply).
  let rideTimer = 0;
  const RIDE_DELAY = 120;

  // Resting layout-viewport height — the baseline for the keyboard math.
  // iOS lies about window.innerHeight WHILE the keyboard is up: the device
  // trace showed iH shrink from 894 to 796 the moment iOS scrolled the
  // document 98px (and to 481 outright when the layout viewport resized),
  // which poisoned cover = iH - vvH - vvT into learning 217/355 instead of
  // the true 413 keyboard height — and a too-small cache made pre-flight
  // under-shrink, which is exactly what provoked the scroll. Track the
  // at-rest value and measure the keyboard against IT.
  let restH = window.innerHeight;

  function pinBottom() {
    const list = document.getElementById('chat-messages');
    if (!list) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }

  function fit(appH, kbH) {
    // The px mirror runs in EVERY touch mode. Standalone briefly tried
    // 100dvh instead (no JS in the loop) — field-proven dead: iOS FREEZES
    // viewport units through the standalone keyboard resize even though
    // innerHeight changes, so the shell stayed full-height and the
    // composer ended up behind the keys. Standalone's real protection is
    // the FLOW body (base.css display-mode rule): the px-fitted document
    // is exactly viewport-sized at rest, and any native content offset
    // during the resize animation becomes an observable window.scrollY
    // that the squash below resets per frame — with the old fixed body
    // that displacement was JS-invisible (pristine traces, jumping
    // header).
    root.style.setProperty('--app-h', `${Math.round(appH)}px`);
    root.style.setProperty('--kb-h', `${Math.max(0, Math.round(kbH))}px`);
  }

  function setVvTop(px) {
    root.style.setProperty('--vv-top', `${Math.max(0, Math.round(px))}px`);
  }

  function sample(src) {
    const appH = root.style.getPropertyValue('--app-h') || '(unset)';
    const vvTop = root.style.getPropertyValue('--vv-top') || '(unset)';
    log.push(
      `+${Math.round(performance.now() - t0)}ms ${src}: iH=${window.innerHeight} vvH=${Math.round(vv.height)}` +
      ` vvT=${Math.round(vv.offsetTop)} sY=${Math.round(window.scrollY)} sc=${vv.scale}` +
      ` ae=${document.activeElement?.id || document.activeElement?.tagName || '-'}` +
      ` restH=${Math.round(restH)} cache=${cachedKb}` +
      ` → appH=${appH} vvTop=${vvTop}`,
    );
    if (log.length > LOG_MAX) log.shift();
  }

  // Deferred shove (standalone's replacement for the pre-flight one): the
  // first mirror pass of a keyboard session — i.e. right after the native
  // webview resize landed — reveals the focused field inside its own
  // scroller (settings drawer, auth view, modals) synchronously, so iOS
  // finds it visible and has no reveal scroll left to animate.
  let shovedThisSession = false;

  function apply(src = 'vv') {
    const cover = Math.max(0, restH - vv.height);
    const keyboardUp = cover > 80;
    lastCover = cover;
    // SQUASH iOS's reveal scroll on EVERY event — including while the
    // keyboard is up. With pre-flight in place the focused field is already
    // above the keys before iOS moves, so any document scroll iOS still
    // starts was computed from the PRE-shrink geometry and gets animated
    // back once it re-checks. Resetting per frame means neither animation
    // accumulates visibly (with the fixed body this is an instant no-op
    // snap, not the old scrollable-document tug-of-war).
    const sy = Math.max(0, Math.round(window.scrollY));
    if (cover <= 80) squashCount = 0; // keyboard closed: fresh session next time
    if (sy !== 0) {
      if (squashCount < SQUASH_MAX) {
        window.scrollTo(0, 0);
        squashCount++;
      } else if (squashCount === SQUASH_MAX) {
        // iOS insists (field genuinely covered — estimate came up short):
        // stop fighting or the per-frame reset becomes a visible jitter.
        // One loud trace line so the diagnostics say why we gave up.
        sample('squash-giveup');
        squashCount++;
      }
    }
    // At genuine rest (no keyboard, no scroll, no pan): relearn the
    // baseline so toolbar show/hide doesn't leave a stale restH.
    if (cover <= 80 && sy === 0 && vv.offsetTop === 0) restH = window.innerHeight;
    fit(vv.height, cover);
    // Standalone: keep the 2px scroll room alive while the keyboard is up
    // (the hammer window may have ended); drop it at rest so the document
    // is exactly viewport-sized again.
    if (IS_STANDALONE && !suppressActive) setScrollRoom(cover > 80 ? 2 : 0);
    // Deferred shove: once per keyboard session, when the fit first lands.
    if (keyboardUp && !shovedThisSession) {
      shovedThisSession = true;
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
        ae.scrollIntoView({ block: 'nearest' });
      }
    }
    if (!keyboardUp) shovedThisSession = false;
    // RIDE — DEBOUNCED. Device traces showed the remaining offsetTop pans
    // are TRANSIENT overshoots: iOS pans (98/201px) computed from the
    // pre-shrink geometry and cancels ~16ms later, animating the restore
    // itself. Riding those instantly yanked the body DOWN (the reported
    // "instant down, slow up" dip) — a second jerk stacked on iOS's own
    // smooth animation. So: offset gone → drop the ride NOW; offset
    // present → wait RIDE_DELAY; only a PERSISTENT pan (the original
    // header-off-page bug) gets corrected, once, after the churn settles.
    const t = Math.round(vv.offsetTop);
    if (t <= 0) {
      clearTimeout(rideTimer);
      setVvTop(0);
    } else {
      clearTimeout(rideTimer);
      rideTimer = setTimeout(() => {
        const held = Math.round(vv.offsetTop);
        if (held > 0) {
          setVvTop(held);
          sample(`ride:${held}`);
        }
      }, RIDE_DELAY);
    }
    // Learn the TALLEST keyboard seen, never a shorter one: the numeric
    // pad (386) overwriting the letter keyboard (413) made the next
    // pre-flight under-shrink — which is exactly what provoked iOS's
    // reveal pan. Over-estimating is the safe direction: a brief gap that
    // the mirror closes, header stable.
    if (cover > 80 && cover > cachedKb) {
      cachedKb = cover;
      try { localStorage.setItem('cocono.kb-h', String(cover)); } catch { /* private mode */ }
    }
    if (document.activeElement?.id === 'chat-input') pinBottom();
    sample(src);
  }

  // Pre-flight shrink — runs AFTER focus is granted, BEFORE the keyboard
  // (and its pan decision) arrives. `el` is the focused field: once the
  // shell fits the future keyboard, WE reveal the field inside its own
  // scroller (the settings drawer, the auth view) synchronously — iOS only
  // starts its animated reveal scroll (the shove that drags the header)
  // when the field is still covered at its check; finding it already in
  // view, it has nothing to animate. 'nearest' keeps the nudge minimal and
  // can never scroll the window (the document has nothing to scroll).
  // Native-slide suppression (STANDALONE): at focus, WKWebView animates
  // its OWN contentOffset to "reveal" the first responder — a compositor-
  // level motion that no JS channel observes (device traces: pristine
  // sY/vvT throughout, win-scroll events arriving only AFTER the offset
  // self-restored, yet the header visibly slides). It is triggered from
  // the geometry at the focus instant — before any focusin handler can
  // re-fit — so it cannot be prevented, only interrupted: setting
  // window.scrollTo(0,0) EVERY FRAME through the animation window
  // overrides the native offset as it animates (the community remedy for
  // the standalone keyboard slide; a single call loses to the animation).
  // Bounded windows around focus/blur only — no idle rAF cost.
  let suppressRaf = 0;
  let suppressActive = false;
  function suppressNativeSlide(ms) {
    if (!IS_STANDALONE) return;
    // Give the document a 2px scroll range FIRST: px-fitted to exactly the
    // viewport, it has zero scrollability — window.scrollTo(0,0) is then a
    // no-op and the native displacement never surfaces in scrollY (eight
    // rounds of pristine traces with a visibly sliding header). With room
    // to scroll, the offset becomes observable AND resettable — including
    // the negative bounce (band at the top) the field report described.
    setScrollRoom(2);
    suppressActive = true;
    const until = performance.now() + ms;
    cancelAnimationFrame(suppressRaf);
    const tick = () => {
      const sy = window.scrollY;
      if (sy !== 0) sample(`hammer:sY=${Math.round(sy)}`); // the displacement, caught on camera at last
      window.scrollTo(0, 0);
      if (performance.now() < until) suppressRaf = requestAnimationFrame(tick);
      else {
        suppressActive = false;
        setScrollRoom(lastCover > 80 ? 2 : 0);
      }
    };
    suppressRaf = requestAnimationFrame(tick);
  }

  function setScrollRoom(px) {
    root.style.setProperty('--kb-room', `${px}px`);
  }

  // Pre-flight shrink — runs AFTER focus is granted, BEFORE the keyboard
  // (and its pan decision) arrives. `el` is the focused field: once the
  // shell fits the future keyboard, WE reveal the field inside its own
  // scroller (the settings drawer, the auth view) synchronously — iOS
  // finding it already in view has no reveal scroll left to animate.
  let revertTimer = 0;
  function preflight(el) {
    if (!IS_IOS) return;            // Android resizes itself; desktop has no soft keyboard
    // STANDALONE NEEDS THIS TOO — the 12:08 trace proved it: without a
    // pre-fit there is an ~80ms window (focus → resize event) where the
    // 894px document sits in a shrinking webview, WKWebView natively
    // scrolls to reveal the first responder and animates the undo — win-
    // scroll events with sY already restored to 0, i.e. a displacement
    // that self-heals BEFORE the squash can observe it. Its restore
    // animation is the header motion every 'pristine' trace still showed.
    // Pre-fitting closes the window: content already fits when the resize
    // lands, so the native reveal scroll has nothing to do. (The earlier
    // standalone skip dated from when the FIXED body made native motion
    // invisible — with the flow body both protections now stack.)
    if (lastCover > 80) return;     // keyboard already up: nothing to pre-fit
    const est = cachedKb || DEFAULT_KB;
    const margin = cachedKb ? 0 : PRE_MARGIN; // learned cache = device truth, no slack
    fit(Math.max(MIN_APP_H, restH - est - margin), est + margin);
    setVvTop(0);
    el?.scrollIntoView?.({ block: 'nearest' });
    // Speculative shrink: if no keyboard actually arrives (focus stolen,
    // programmatic focus that iOS declines to honour), restore the true fit
    // instead of leaving the shell stranded mid-screen.
    clearTimeout(revertTimer);
    revertTimer = setTimeout(() => { if (lastCover <= 80) apply('revert'); }, 600);
    sample(`preflight${el ? `:${el.id || el.tagName}` : ''}`);
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
      sample(`tap:${t.id || t.tagName}`);
    }
  }, { capture: true, passive: true });
  document.addEventListener('focusin', (e) => {
    sample(`focusin:${e.target?.id || e.target?.tagName}${e.target === tapTarget ? '' : ' (no-tap)'}`);
    const isField = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
    if (isField) suppressNativeSlide(700); // covers the native reveal animation window
    if (isField && e.target === tapTarget && performance.now() - tapAt < 700) preflight(e.target);
    tapTarget = null;
  });

  document.addEventListener('focusout', (e) => {
    sample(`focusout:${e.target?.id || e.target?.tagName}`);
    // The keyboard-close side of the native slide: WKWebView animates the
    // offset restore too — suppress through that window as well.
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      suppressNativeSlide(600);
    }
    // Classic standalone-PWA hygiene: the WKWebView can keep a residual
    // content offset after the keyboard closes that JS scroll values never
    // report (blank band / stuck-shifted view). One delayed settle pass
    // re-squashes and re-fits once the close animation is done.
    setTimeout(() => {
      window.scrollTo(0, 0);
      apply('focusout-settle');
    }, 150);
  });

  vv.addEventListener('resize', () => apply('vv-resize'));
  vv.addEventListener('scroll', () => apply('vv-scroll'));
  // iOS's phantom DOCUMENT scroll fires window scroll events that the
  // visualViewport listeners may not see — feed them through apply so the
  // close-cleanup and the log catch them.
  window.addEventListener('scroll', () => apply('win-scroll'), { passive: true });
  apply('init');
  sample(`mode:${matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser'} scrollH=${document.scrollingElement?.scrollHeight}`);
}
