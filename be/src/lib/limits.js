// ---- Dynamic limit catalog: THE single source of truth for every named
// rate limiter (default values, scope, and admin tunability).
//
// Layering (per call): per-user override > app-wide override > default.
// Overrides live in the settings collection ({_id:'limits'}) and are written
// ONLY by the admin routes; every write invalidates this process's cache and
// the cache TTL (10 s) covers the other node(s) — limits tuning is not
// latency-sensitive.
//
// 'daily'/'weekly' below is NOT the fixed-window mechanism's job: the fvday/
// fvweek/ftday/ftweek entries back the per-account verify/trust BUDGETS —
// each is just another fixed-window counter whose window happens to be a
// day/week, so they are tunable exactly like the rest.
//
// To add a limiter: register it HERE, use effectiveLimit() at the call site,
// and the admin UI picks it up automatically.

const H = 3600;
const DAY = 24 * H;

// name -> { scope, label, def(config) -> {limit, windowSec}, ip: true }
// `ip` marks IP-scoped limiters whose DEFAULTS the admin panel edits (the
// requirement: "defaults for all IP based limits should be set via the admin
// panel"). Account-scoped ones are settable globally AND per user.
export const LIMIT_CATALOG = {
  signup:         { ip: true,  label: 'Signup (per IP)',            def: (c) => ({ limit: c.signupIpLimit, windowSec: c.signupIpWindowSec }) },
  challenge:      { ip: true,  label: 'Login challenge (per IP)',   def: (c) => ({ limit: c.challengeIpLimit, windowSec: c.challengeIpWindowSec }) },
  verify:         { ip: false, label: 'Login verify (per account)', def: (c) => ({ limit: c.verifyAccountLimit, windowSec: c.verifyAccountWindowSec }) },
  verifyip:       { ip: true,  label: 'Login verify (per IP)',      def: (c) => ({ limit: c.verifyIpLimit, windowSec: c.verifyIpWindowSec }) },
  denroll:        { ip: true,  label: 'Device enroll (per IP)',     def: (c) => ({ limit: c.deviceEnrollIpLimit, windowSec: c.deviceEnrollIpWindowSec }) },
  dapprove:       { ip: false, label: 'Device approve (per acct)',  def: (c) => ({ limit: c.deviceApproveAccountLimit, windowSec: c.deviceApproveAccountWindowSec }) },
  dpending:       { ip: false, label: 'Pending pairing (per acct)', def: (c) => ({ limit: c.deviceApproveAccountLimit, windowSec: c.deviceApproveAccountWindowSec }) },
  dremove:        { ip: false, label: 'Device remove (per acct)',   def: (c) => ({ limit: c.deviceRemoveAccountLimit, windowSec: c.deviceRemoveWindowSec }) },
  dself:          { ip: false, label: 'Device self-report (per acct)', def: (c) => ({ limit: c.deviceSelfAccountLimit, windowSec: c.deviceSelfWindowSec }) },
  denrollstatus:  { ip: true,  label: 'Enroll status poll (per IP)', def: (c) => ({ limit: c.enrollStatusIpLimit, windowSec: c.enrollStatusIpWindowSec }) },
  msg:            { ip: false, label: 'Message send (per acct)',    def: (c) => ({ limit: c.msgAccountLimit, windowSec: c.msgAccountWindowSec }) },
  msgip:          { ip: true,  label: 'Message send (per IP)',      def: (c) => ({ limit: c.msgIpLimit, windowSec: c.msgIpWindowSec }) },
  userkeys:       { ip: true,  label: 'Key lookup (per IP)',        def: (c) => ({ limit: c.userKeysIpLimit, windowSec: c.userKeysIpWindowSec }) },
  ustats:         { ip: true,  label: 'User stats (per IP)',        def: (c) => ({ limit: c.userKeysIpLimit, windowSec: c.userKeysIpWindowSec }) },
  friends:        { ip: true,  label: 'Friends read (per IP)',      def: (c) => ({ limit: c.friendsIpLimit, windowSec: c.friendsIpWindowSec }) },
  friendschange:  { ip: true,  label: 'Friends change (per IP)',    def: (c) => ({ limit: c.friendsChangeIpLimit, windowSec: c.friendsIpWindowSec }) },
  fvday:          { ip: false, label: 'Verifications / day (acct)', def: (c) => ({ limit: c.friendVerifyDailyLimit, windowSec: c.friendVerifyDailyWindowSec }) },
  fvweek:         { ip: false, label: 'Verifications / week (acct)', def: (c) => ({ limit: c.friendVerifyWeeklyLimit, windowSec: c.friendVerifyWeeklyWindowSec }) },
  ftday:          { ip: false, label: 'Trusts / day (acct)',        def: (c) => ({ limit: c.friendTrustDailyLimit, windowSec: c.friendTrustDailyWindowSec }) },
  ftweek:         { ip: false, label: 'Trusts / week (acct)',       def: (c) => ({ limit: c.friendTrustWeeklyLimit, windowSec: c.friendTrustWeeklyWindowSec }) },
  diag:           { ip: true,  label: 'Diagnostics upload (per IP)', def: (c) => ({ limit: c.diagIpLimit, windowSec: c.diagIpWindowSec }) },
  diagacct:       { ip: false, label: 'Diagnostics (per account)',  def: (c) => ({ limit: c.diagAccountLimit, windowSec: c.diagAccountWindowSec }) },
  report:         { ip: true,  label: 'Reports upload (per IP)',    def: (c) => ({ limit: c.reportIpLimit, windowSec: c.reportIpWindowSec }) },
  reportacct:     { ip: false, label: 'Reports (per account)',      def: (c) => ({ limit: c.reportAccountLimit, windowSec: c.reportAccountWindowSec }) },
  iddoc:          { ip: false, label: 'ID upload (per account)',    def: (c) => ({ limit: c.idDocAccountLimit, windowSec: c.idDocWindowSec }) },
  iddocip:        { ip: true,  label: 'ID upload (per IP)',         def: (c) => ({ limit: c.idDocIpLimit, windowSec: c.idDocIpWindowSec }) },
  profile:        { ip: false, label: 'Profile edit (per account)', def: (c) => ({ limit: c.profileEditAccountLimit, windowSec: c.profileEditWindowSec }) },
  profileip:      { ip: true,  label: 'Profile view (per IP)',      def: (c) => ({ limit: c.userKeysIpLimit, windowSec: c.userKeysIpWindowSec }) },
  appinfo:        { ip: true,  label: 'App info (per IP)',          def: (c) => ({ limit: c.appInfoIpLimit, windowSec: c.appInfoWindowSec }) },
  // per-DEVICE egress-IP change budget; the subject is 'user:deviceId', so
  // overrides for it are written per device (user panel), app-wide here,
  // and the enforcement lives in the auth hook (app.js)
  ipflap:         { ip: false, device: true, label: 'IP changes (per device)', def: (c) => ({ limit: c.deviceIpFlapLimit, windowSec: c.deviceIpFlapWindowSec }) },
};

// ---- tiny TTL cache over the settings doc (per process) ----
const CACHE_MS = 10_000;
let cache = { at: 0, doc: { global: {}, users: {} } };

export function resetLimitsCache() {
  cache = { at: 0, doc: { global: {}, users: {} } };
}

async function limitsDoc(settings) {
  if (Date.now() - cache.at < CACHE_MS) return cache.doc;
  let doc = { global: {}, users: {} };
  try {
    const raw = await settings.findOne({ _id: 'limits' });
    doc = { global: raw?.global ?? {}, users: raw?.users ?? {} };
  } catch { /* settings unavailable: defaults */ }
  cache = { at: Date.now(), doc };
  return doc;
}

/**
 * Effective {limit, windowSec} for a catalog name: per-user override wins
 * over app-wide override, which wins over the config default.
 * @param {string|null} ul  account the limiter applies to (account-scoped
 *                          limiters only — pass null for IP-scoped ones)
 */
export async function effectiveLimit(settings, config, name, ul = null) {
  const entry = LIMIT_CATALOG[name];
  if (!entry) throw new Error(`unknown limiter: ${name}`);
  const base = entry.def(config);
  const doc = await limitsDoc(settings);
  const over = (ul && doc.users?.[ul]?.[name]) || doc.global?.[name] || null;
  if (!over) return base;
  return {
    limit: Number.isInteger(over.limit) && over.limit >= 1 ? over.limit : base.limit,
    windowSec: Number.isInteger(over.windowSec) && over.windowSec >= 1 ? over.windowSec : base.windowSec,
  };
}

// ---- admin-side validation + mutation ----

export function validOverride(raw) {
  // {limit?, windowSec?} integers in sane ranges; null/{} clears the field
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'object' || raw === undefined) return { ok: false, why: 'override must be an object or null' };
  const out = {};
  if (raw.limit !== undefined && raw.limit !== null) {
    if (!Number.isInteger(raw.limit) || raw.limit < 1 || raw.limit > 1_000_000) return { ok: false, why: 'limit must be an integer 1..1,000,000' };
    out.limit = raw.limit;
  }
  if (raw.windowSec !== undefined && raw.windowSec !== null) {
    if (!Number.isInteger(raw.windowSec) || raw.windowSec < 1 || raw.windowSec > 30 * DAY) return { ok: false, why: 'windowSec must be an integer 1s..30d' };
    out.windowSec = raw.windowSec;
  }
  if (!Object.keys(out).length) return { ok: false, why: 'nothing to set (limit/windowSec) — use null to clear' };
  return { ok: true, value: out };
}

/**
 * Apply one admin edit. scope 'global' or { user: '<ul>' }. value null clears
 * the override (falls back to the app-wide/default). Returns nothing; throws
 * on unknown limiter (validate names BEFORE calling).
 */
export async function writeOverride(settings, name, value, scope) {
  const doc = await settings.findOne({ _id: 'limits' });
  const cur = doc?.global ?? {};
  const users = doc?.users ?? {};
  if (scope && scope.user) {
    const ul = scope.user;
    const per = { ...(users[ul] ?? {}) };
    if (value === null) delete per[name];
    else per[name] = { ...(per[name] ?? {}), ...value };
    if (Object.keys(per).length) users[ul] = per;
    else delete users[ul];
  } else {
    if (value === null) delete cur[name];
    else cur[name] = { ...(cur[name] ?? {}), ...value };
  }
  await settings.updateOne(
    { _id: 'limits' },
    { $set: { global: cur, users, updatedAt: new Date() } },
    { upsert: true },
  );
  resetLimitsCache(); // same-process writes apply instantly; TTL covers peers
}

export async function readLimitsDoc(settings) {
  try {
    const raw = await settings.findOne({ _id: 'limits' });
    return { global: raw?.global ?? {}, users: raw?.users ?? {} };
  } catch {
    return { global: {}, users: {} };
  }
}
