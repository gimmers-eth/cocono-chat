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
    if (!booted) return; // booting / push-click open: modal covers it
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
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
    const viaSw = navigator.serviceWorker?.getRegistration?.()
      .then((reg) => {
        if (!reg) throw new Error('no active SW');
        reg.showNotification('You have a new badge', { tag: 'cocono-badge', data: { type: 'badge' } });
      })
      .catch(() => {
        try {
          const n = new Notification('You have a new badge', { tag: 'cocono-badge' });
          n.onclick = () => { window.focus(); };
        } catch { /* engine refused — the modal queue still holds it */ }
      });
    return viaSw;
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
