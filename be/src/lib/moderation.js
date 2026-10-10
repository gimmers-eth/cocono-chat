// Staff MODERATION states on the account doc — TIMEOUT and BAN.
//
// timeoutUntil: Date | null — the "identified as malicious" timeout. While
//   timeoutUntil lies in the future the account behaves EXACTLY like an
//   unverified one: App trust withdrawn (effectiveVerified false → device
//   policy, voucher counting and the bigger verify budget all fall back to
//   unverified), the worn badge chip hides, the profile photo goes (it was
//   shown under a trust state just withdrawn), every client shows the
//   DANGER mark in place of any trust icon + a staff warning on the
//   profile, the account's CoCo carries a flat -cocoTimeoutPenalty, and the
//   COLD-SEND GATE closes: a timed-out account may only message people who
//   ADDED it — no prior-contact reply-back door (ws-routes/handlers.js).
//   Expiry is DERIVED (stored timeoutUntil vs now) at every read — there is
//   no cleanup job to forget and no window where a lapsed timeout still
//   bites or a live one silently early-expires. A 100-year timeout is just
//   a very far date; no special "permanent" state.
//
// banned: boolean (+ bannedAt) — platform USE is refused (login, every
//   authenticated API call, the WS) while the account doc and every byte
//   of its data (messages, friends, photos, badges) stay intact; lifting
//   the ban returns the account exactly as it was. Other users see a
//   warning icon and a staff-ban notice on the profile. The BAN is a hard
//   state (no clock): only an admin lifts it.
//
// THE ONE READING SURFACE: every route that cares about either state goes
// through these helpers — never inline `doc.banned` / `doc.timeoutUntil`
// comparisons, or expiry semantics drift per endpoint.

export const DAY_MS = 24 * 60 * 60 * 1000;

// The admin panel's timeout presets (day counts). 36500d ≈ 100 years.
export const TIMEOUT_DAY_PRESETS = [1, 7, 30, 36500];

export function timeoutActive(doc, now = Date.now()) {
  const t = doc?.timeoutUntil;
  return !!t && new Date(t).getTime() > now;
}

export function isBanned(doc) {
  return doc?.banned === true;
}

/** The verified flag AS THE WORLD SEES IT while a timeout runs: false. */
export function effectiveVerified(doc, now = Date.now()) {
  return doc?.verified === true && !timeoutActive(doc, now);
}

/** Flat CoCo penalty a timed-out account carries while the clock runs. */
export function cocoPenalty(doc, config, now = Date.now()) {
  return timeoutActive(doc, now) ? (Number(config.cocoTimeoutPenalty) || 0) : 0;
}

/** Mongo fragment for "verified AND not timed out" — the voucher-count
    queries in userStats must not weight a timed-out account's vouches
    (it stands behind nothing right now). $lte with a past date covers the
    lapsed timeout; missing/null timeoutUntil covers every normal account. */
export function verifiedVoucherFilter(now = Date.now()) {
  return {
    verified: true,
    $or: [
      { timeoutUntil: { $exists: false } },
      { timeoutUntil: null },
      { timeoutUntil: { $lte: new Date(now) } },
    ],
  };
}

/** The moderation facts a CLIENT read may expose (public-trust metadata,
    same disclosure class as `verified`/`premium`). Deliberately NOT the
    remaining time — that is admin-only (the client of the flagged user or
    of their peers never learns when the timeout lifts). */
export function moderationFlags(doc, now = Date.now()) {
  return { malicious: timeoutActive(doc, now), banned: isBanned(doc) };
}

/** The admin view: flags + the raw clock + seconds remaining (0 when the
    timeout is not running). Only ever serialized on the admin API. */
export function moderationState(doc, now = Date.now()) {
  const active = timeoutActive(doc, now);
  return {
    ...moderationFlags(doc, now),
    timeoutUntil: doc?.timeoutUntil ?? null,
    timeoutRemainingSec: active
      ? Math.max(0, Math.ceil((new Date(doc.timeoutUntil).getTime() - now) / 1000))
      : 0,
    bannedAt: doc?.banned === true ? (doc.bannedAt ?? null) : null,
  };
}

