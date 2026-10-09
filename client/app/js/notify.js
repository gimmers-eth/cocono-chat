// OS notifications for the page: service-worker notifications first (clicking
// one focuses an open window or launches the app — the SW's notificationclick
// owns that), falling back to a page-created Notification with an explicit
// focus handler. Page-created notifications do NOTHING on click by default,
// which once made badge notices feel like dead buttons.
//
// `text` must be generic (no peer names, no counts beyond "a contact"): the
// notification may render on the lock screen, and the OS/notification service
// is not E2EE. The app itself carries the detail once opened.
// `peer` (optional): tapping the notice opens the chat with that user. It
// rides only LOCAL plumbing — the SW's notification.data and the page
// fallback's click handler — never a push service; the name is already on
// screen in the notice body anyway.
export function osNotify(text, tag = 'cocono-activity', peer = '') {
  if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') return Promise.resolve();
  const focusSelf = () => {
    window.focus();
    if (peer) window.dispatchEvent(new CustomEvent('cocono:open-chat', { detail: peer }));
  };
  const page = () => {
    try {
      const n = new Notification(text, { tag });
      n.onclick = focusSelf;
    } catch { /* engine refused */ }
  };
  return (navigator.serviceWorker?.getRegistration?.() ?? Promise.resolve(null))
    .then((reg) => {
      if (!reg) { page(); return; }
      try { reg.showNotification(text, { tag, data: { type: 'app', peer: peer || undefined } }); }
      catch { page(); }
    })
    .catch(page);
}

// Badge notifications, in ONE place: the poll loop (login + every 60s), the
// 'badges' control-nudge handling, modal dispatch, and the OS Notification
// decision. Everything else (message push, the service worker's own blind
// notification) is unchanged — this module only owns what happens INSIDE the
// page when a badge award lands.
//
// The dedup rule that fixes the double-fire: a queued web push replays into
// Chrome when the browser starts, the modal shows when the app opens, AND the
// old in-app code raised its own Notification — three overlapping channels.
// Policy now: when the app is VISIBLE, the modal is the experience and no OS
// Notification is raised (a queued push may still appear from the OS — the
// SW's replace-by-tag keeps it to one); Notifications are for backgrounded
// tabs only, where the modal would otherwise go unseen.

const POLL_MS = 60_000;

export function initBadgeNotify({ client }) {
  // Boot race that caused the double-fire: clicking a push opens a window
  // that is technically HIDDEN for its first frames; the boot poll then
  // "correctly" raised an OS Notification for a user who cannot see the
  // page yet — seconds before the modal does. So: notifications only ever
  // fire once this window has actually been visible at least once (booted);
  // before that, the modal queue is the whole experience.
  let booted = false;
  const markBooted = () => {
    if (document.visibilityState === 'visible') booted = true;
  };
  document.addEventListener('visibilitychange', markBooted);
  requestAnimationFrame(markBooted);

  function announce(list) {
    window.dispatchEvent(new CustomEvent('cocono:newbadges', { detail: list }));
    // ACK AFTER DISPATCH: the server stops reporting these grants as new
    // only once this client has actually queued the modal. If we die in
    // between, the next poll re-presents them — a badge modal is never
    // silently consumed by a response that never rendered.
    client.ackBadges(list.map((b) => b.gid)).catch(() => {});
    if (!booted) return; // booting / push-click open: modal covers it
    if (document.visibilityState === 'visible') return; // user is looking at the modal
    for (const b of list) raiseBadgeNotice();
  }

  // Clicking a badge notification must OPEN the app. Page-created
  // Notifications do NOT focus/launch anything on click by themselves — and
  // the browser dismisses them when the creating tab is closing — so we go
  // through the service worker (its notificationclick already focuses an
  // existing window or opens a fresh one, same as push), falling back to a
  // page Notification with an explicit focus handler.
  function raiseBadgeNotice() {
    return osNotify('You have a new badge', 'cocono-badge');
  }

  async function poll() {
    if (!client.token) return;
    try {
      const res = await client.pollBadges();
      if (res.new?.length) announce(res.new);
    } catch { /* offline: the next tick retries */ }
  }

  // entry for the control-notice router (main.js): an admin just
  // awarded/revoked something — skip the 60s wait
  function onNotice(what) {
    if (what !== 'badges') return;
    poll().then(() => {
      // resync chips/picker even when nothing new dispatched (revokes too)
      if (typeof document !== 'undefined') window.dispatchEvent(new Event('cocono:badges-changed'));
    }).catch(() => {});
  }

  setInterval(poll, POLL_MS).unref?.();
  return { poll, onNotice };
}
