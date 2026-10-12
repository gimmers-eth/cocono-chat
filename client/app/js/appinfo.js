// /api/app-info — the PAGE's single source. The endpoint answers the same
// question for four different callers (boot branding, the update notice,
// push enablement, diagnostics), and each used to fetch for itself: one
// refresh cost 3-4 hits, a chatty tab could trip the server's per-IP
// limiter, and a 429 then blanked the version footer. getAppInfo() makes
// the whole page ONE caller:
//
//   * IN-FLIGHT DEDUP — concurrent callers share one request;
//   * a 30-second TTL — exactly the server's own git-cache window, so a
//     re-read inside 30 s provably cannot say anything newer;
//   * failures are NOT cached — the next caller tries the wire again
//     (the update notice's fast-retry relies on that).
//
// The SERVICE WORKER does not use this module (classic script, separate
// world): the page hands it what it learns via swkv, and sw.js reads that
// cache first.

let cached = null;
let cachedAt = 0;
let inflight = null;

export function getAppInfo({ fresh = false, ttlMs = 30_000 } = {}) {
  if (!fresh && cached && Date.now() - cachedAt < ttlMs) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = fetch('/api/app-info')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((info) => {
      if (info) { cached = info; cachedAt = Date.now(); }
      inflight = null;
      return info;
    });
  return inflight;
}

// Test seam / logout hygiene: forget everything.
export function resetAppInfo() {
  cached = null;
  cachedAt = 0;
  inflight = null;
}
