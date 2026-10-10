// Share-link attribution on the client — the other half of
// be/src/lib/shares.js.
//
// The app hands out `/?chat=<my-username>` deep links (home.js share
// button). Whoever opens one lands here, and TWO facts are worth telling the
// server:
//
//   1. an account that ALREADY EXISTS opened the link  -> POST /api/share/hit
//      (reported once the session is up; that is the graph's "seen" edge)
//   2. a visitor with NO account signed up afterwards  -> signup carries `r`
//      (the account's parent; that is the graph's "created" edge)
//
// Both need the link to survive what happens between the click and the
// session: the URL is rewritten at boot (main.js captureSharedChat) and a
// signup can happen minutes or days later, so the pending link is parked in
// localStorage — the same trick the chat-open deep link already uses.
//
// Nothing here is trusted by the server (attribution is unsigned metadata
// that buys no reward), and nothing here can break a boot: every read is
// wrapped, every write is best-effort, and private-mode browsers that throw
// on localStorage simply get no attribution.

const PENDING_KEY = 'cocono.shared.link';

// How long a clicked link stays attributable. A signup three weeks after the
// click is still that link's doing; one six months later is a stretch (and
// the browser may have handed the localStorage entry to a different person
// on a shared device anyway).
const ATTRIBUTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } };
const drop = (key) => { try { localStorage.removeItem(key); } catch { /* private mode */ } };

/** The parked link: `{ o, at }` (owner username + click epoch ms), or null. */
export function pendingShare() {
  const raw = read(PENDING_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const o = String(parsed?.o ?? '').trim().toLowerCase();
    const at = Number(parsed?.at) || 0;
    if (!o) return null;
    return { o, at };
  } catch {
    // Legacy shape: a bare username string (pre-JSON). Still attributable.
    const o = String(raw).trim().toLowerCase();
    return o ? { o, at: 0 } : null;
  }
}

/**
 * Park a just-clicked share link for later attribution. Call at boot with the
 * `?chat=` peer (main.js does this next to parking the chat to open).
 * The NEWEST click wins: if someone opens two links before signing up, the
 * account belongs to the last one that brought them here.
 */
export function noteShareLink(peer) {
  const o = String(peer ?? '').trim().toLowerCase();
  if (!o) return null;
  const rec = { o, at: Date.now() };
  write(PENDING_KEY, JSON.stringify(rec));
  return rec;
}

/**
 * The referrer to send with a signup, or null when the pending link is
 * missing, stale, or points at the name being registered (self-referral).
 * @param {string} [asUsername] the username being created
 */
export function referrerForSignup(asUsername = null) {
  const p = pendingShare();
  if (!p) return null;
  if (p.at && Date.now() - p.at > ATTRIBUTION_WINDOW_MS) return null;
  const me = String(asUsername ?? '').trim().toLowerCase();
  if (me && p.o === me) return null;
  return p.o;
}

/** Forget the parked link (after it has been reported or used at signup). */
export function clearPendingShare() {
  drop(PENDING_KEY);
}

/**
 * Tell the server about the parked link once a session exists.
 *
 * `fresh` (a signup that just happened) means the CREATED edge was already
 * written by /api/signup's `r` — reporting a "seen" click on top of it would
 * only muddy the pair record, so the link is consumed silently.
 *
 * Best-effort and non-throwing: an offline boot or a deleted link owner must
 * not disturb enterApp(). Returns what happened, for logging/tests.
 * @param {import('/sdk/index.js').CoconoClient} client
 * @returns {Promise<{reported: boolean, reason?: string}>}
 */
export async function reportShareHit(client, { fresh = false } = {}) {
  const p = pendingShare();
  if (!p) return { reported: false, reason: 'none' };
  const me = String(client?.username ?? '').trim().toLowerCase();
  if (me && p.o === me) { clearPendingShare(); return { reported: false, reason: 'self', o: p.o }; }
  if (fresh) { clearPendingShare(); return { reported: false, reason: 'created', o: p.o }; }
  if (!me || !client?.token) return { reported: false, reason: 'no-session', o: p.o }; // keep parked for the next entry
  const res = await client.reportShareHit(p.o).catch(() => ({ ok: false }));
  if (res?.ok) clearPendingShare();
  return { reported: res?.ok === true, o: p.o, reason: res?.ok ? undefined : (res?.error ?? 'failed') };
}
