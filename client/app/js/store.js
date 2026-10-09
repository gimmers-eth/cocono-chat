// App-side message store (IndexedDB). The SDK owns identity + crypto; this
// owns the decrypted transcript so history survives reloads.
//
// The store is SCOPED PER ACCOUNT: the database name (and the localStorage
// read-marker key) includes the current username, so creating or logging in
// as a different user in the same browser never shows the previous
// account's conversations.
//
// record: { id, peer, dir: 'in'|'out', text, ts, state?, fromDeviceId? }
//   id:    outgoing = 'out:'+localId (one per logical send)
//          incoming = 'in:'+server mid (one per device copy)
// friends: { peer } — one-way trust list, mirrored from the server (source
//   of truth) and kept live via E2EE system messages; independent of the
//   message store on purpose: clearing a chat never unfriends anyone.

const DB_PREFIX = 'cocono-app';
const DB_VERSION = 5;
const MESSAGES = 'messages';
const FRIENDS = 'friends';
const PINS = 'pins';
const PEERS = 'peers'; // lightweight facts seen via peerKeys (identity-verified badge)
const AVATARS = 'peeravatars'; // {peer, avatar(base64|null), ts} — server only EVER
                              // returns an avatar on mutual add, so the cache
                              // can't leak one that wasn't earned

let scope = 'anon';
let dbPromise = null;

// Called from main.js before any rendering: everything below is per-username.
export function setScope(username) {
  const next = String(username ?? 'anon').toLowerCase();
  if (next === scope && dbPromise) return;
  scope = next;
  if (dbPromise) dbPromise.then((db) => db.close()).catch(() => {});
  dbPromise = null;
}

// Hard-remove one account's local app data: message DB + read markers.
// Used by 'Forget this device' so no decrypted transcript survives the keys.
const ownerKey = (ul) => `cocono.owner.${ul}`;

/**
 * THE encapsulation guard: every piece of per-account browser state is
 * keyed by USERNAME (the app DB, read marks, owner record) — so a name that
 * is deleted and re-registered (or re-paired after 'forget') must never
 * inherit the previous identity's data. The owner record remembers which
 * DEVICE identity created this browser's copy; entering as any other
 * identity purges the account store first.
 *
 *   fresh   — signup/pairing: a brand-new identity. Purge unconditionally:
 *             anything stored under this name belongs to someone else (or
 *             a previous owner of the name). A genuinely clean browser
 *             pays an idempotent no-op.
 *   resume  — same deviceId as recorded: keep everything. A different
 *             deviceId (forget+re-pair, stolen-name scenarios): purge.
 *
 * deviceId is random per keypair/registration and never reused, which is
 * exactly the identity signal we need. Called from enterApp BEFORE setScope.
 */
export async function ensureScoped(username, deviceId, { fresh = false } = {}) {
  const ul = String(username ?? '').toLowerCase();
  if (!ul) return;
  let prev = null;
  try { prev = localStorage.getItem(ownerKey(ul)); } catch { /* private mode */ }
  if (fresh || (prev && deviceId && prev !== deviceId)) {
    await deleteAccountData(ul).catch(() => {});
  }
  try { if (deviceId) localStorage.setItem(ownerKey(ul), String(deviceId)); } catch { /* private mode */ }
}

// Resolves once deletion finished (or was attempted); rejects only on error.
export async function deleteAccountData(username) {
  const ul = String(username ?? '').toLowerCase();
  if (!ul) return;
  try {
    localStorage.removeItem(`cocono.reads.${ul}`);
    localStorage.removeItem(ownerKey(ul));
  } catch { /* storage unavailable — nothing to clean */ }
  if (scope === ul) {
    if (dbPromise) await dbPromise.then((db) => db.close()).catch(() => {});
    dbPromise = null;
  }
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(`${DB_PREFIX}:${ul}`);
    req.onsuccess = () => resolve();
    // onblocked: another tab holds the DB; deletion proceeds once it closes.
    req.onblocked = () => console.warn(`[store] deleteDatabase blocked: close other tabs of ${ul}`);
    req.onerror = () => reject(req.error ?? new Error('deleteDatabase failed'));
  });
}

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(`${DB_PREFIX}:${scope}`, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(MESSAGES)) {
          const store = db.createObjectStore(MESSAGES, { keyPath: 'id' });
          store.createIndex('byPeer', 'peer');
        }
        if (!db.objectStoreNames.contains(FRIENDS)) {
          db.createObjectStore(FRIENDS, { keyPath: 'peer' });
        }
        if (!db.objectStoreNames.contains(PINS)) {
          db.createObjectStore(PINS, { keyPath: 'peer' });
        }
        if (!db.objectStoreNames.contains(PEERS)) {
          db.createObjectStore(PEERS, { keyPath: 'peer' });
        }
        if (!db.objectStoreNames.contains(AVATARS)) {
          db.createObjectStore(AVATARS, { keyPath: 'peer' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function withStore(mode, fn, store = MESSAGES) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function saveMessage(msg) {
  return withStore('readwrite', (s) => s.put(msg));
}

export function getMessage(id) {
  return withStore('readonly', (s) => s.get(id));
}

export async function updateMessage(id, patch) {
  const existing = await getMessage(id);
  if (!existing) return null;
  return saveMessage({ ...existing, ...patch });
}

export function messagesWith(peer) {
  return withStore('readonly', (s) => s.index('byPeer').getAll(IDBKeyRange.only(peer)));
}

// Local-only delete (this device): peers and the user's other devices keep
// their copies by design.
export function deleteMessage(id) {
  return withStore('readwrite', (s) => s.delete(id));
}

// Clear a whole conversation locally. IMPORTANT: 'peer' is a SECONDARY
// index — the primary key is the message id — so store.delete(range on
// peer) silently matches nothing (the bug this comment documents). Delete
// exactly the ids messagesWith returned instead: clearing can never differ
// from what the user sees on screen, and it returns the deleted count.
export async function clearMessages(peer) {
  const msgs = await messagesWith(peer);
  if (!msgs.length) return 0;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MESSAGES, 'readwrite');
    const store = tx.objectStore(MESSAGES);
    for (const m of msgs) store.delete(m.id);
    tx.oncomplete = () => resolve(msgs.length);
    tx.onerror = () => reject(tx.error);
  });
}

// Wipe the ENTIRE local transcript (settings → Clear all messages). Same
// contract as clearMessages: device-local only — other devices, the peer's
// copies and the friends list are untouched. Returns the deleted count.
export function clearAllMessages() {
  return withStore('readwrite', (s) => {
    const count = s.count();
    s.clear();
    return count;
  });
}

// Usernames known ON THIS DEVICE: peers we hold messages with, PLUS added
// friends (a friend with zero messages is still a person you can reach —
// drives the sidebar new-chat and forward suggestion lists). No server
// contact — this is what the UI surfaces as "local users".
export async function knownPeers() {
  const [all, friends] = await Promise.all([allMessages(), loadFriends()]);
  const set = new Set([
    ...all.map((m) => String(m.peer).toLowerCase()),
    ...friends.map((f) => String(f.peer).toLowerCase()),
  ]);
  set.delete('');
  return [...set].sort();
}

export function allMessages() {
  return withStore('readonly', (s) => s.getAll());
}

// --- read markers (lightweight, localStorage; scoped like the message DB) ---

const readsKey = () => `cocono.reads.${scope}`;

const reads = () => {
  try {
    return JSON.parse(localStorage.getItem(readsKey()) ?? '{}');
  } catch {
    return {};
  }
};

export function markRead(peer, ts = Date.now()) {
  const r = reads();
  r[peer.toLowerCase()] = ts;
  localStorage.setItem(readsKey(), JSON.stringify(r));
}

export const isUnread = (peer, ts) => (ts ?? 0) > (reads()[String(peer).toLowerCase()] ?? 0);

// --- friends (local mirror of the server list; see header comment) ---
// record: { peer, pub, gone, changed, trusted, verified, trust, addedBack,
// at } — pub is the identity-key binding the SERVER recorded; trusted only
// when it matches the live account. Legacy/unbound entries are NOT trusted
// (strict policy). addedBack = they added US too: verification only works
// (and only MEANS something) on a mutual add. `at` = last friend-STATE
// activity on this device (add / verify / trust / gone transitions):
// device-local only, never synced — the sidebar floats freshly-acted-upon
// peers up even when there are zero messages.

export function loadFriends() {
  return withStore('readonly', (s) => s.getAll(), FRIENDS);
}

export async function friendAdd(peer, pub = '', extra = {}) {
  await withStore('readwrite', (s) => s.put({
    peer: String(peer).toLowerCase(), pub,
    gone: false, changed: false, trusted: !!pub, verified: false, trust: false,
    addedBack: false,
    at: Date.now(),
    ...extra,
  }), FRIENDS);
  notifyFriends();
}

/** Live-update the mirror from a friend-v / friend-t sys message. */
export async function friendMarkFlags(peer, patch) {
  const ul = String(peer).toLowerCase();
  const cur = (await withStore('readonly', (s) => s.get(ul), FRIENDS))
    ?? { peer: ul, pub: '', gone: false, changed: false, trusted: false };
  const next = { ...cur, ...patch };
  // stamp ONLY a genuine state transition — re-writing the same value (or
  // a no-op revoke) must not bump the peer up the sidebar
  const touched = ['verified', 'trust', 'trusted', 'gone', 'changed'].some(
    (k) => k in patch && !!next[k] !== !!cur[k],
  );
  if (touched) next.at = Date.now();
  await withStore('readwrite', (s) => s.put(next), FRIENDS);
  notifyFriends();
}

export async function friendDel(peer) {
  await withStore('readwrite', (s) => s.delete(String(peer).toLowerCase()), FRIENDS);
  notifyFriends();
}

/** Replace the whole local mirror with the authoritative server entries. */
export async function setFriends(entries) {
  const db = await openDb();
  // carry device-local activity stamps across a re-sync; bump one when the
  // server reports a flag this device never saw live (event missed while
  // offline). Brand-new-to-this-device entries start at 0 — no fake "top".
  const prev = new Map((await loadFriends()).map((e) => [e.peer, e]));
  await new Promise((resolve, reject) => {
    const tx = db.transaction(FRIENDS, 'readwrite');
    const store = tx.objectStore(FRIENDS);
    store.clear();
    for (const e of entries ?? []) {
      // tolerate legacy plain-string entries
      const rec = typeof e === 'string' ? { u: e } : e;
      const ul = String(rec.u).toLowerCase();
      const flags = {
        gone: !!rec.gone,
        changed: !!rec.changed,
        trusted: !!rec.trusted,
        verified: !!rec.verified, // server-account-level: propagates to all devices
        trust: !!rec.trust,       // third stage: "I know this person"
        addedBack: !!rec.addedBack, // mutual? verification is impossible one-sided
      };
      const old = prev.get(ul);
      let at = old?.at ?? 0;
      if (old && Object.keys(flags).some((k) => !!old[k] !== flags[k])) at = Date.now();
      store.put({
        peer: ul,
        pub: rec.p || '',
        ...flags,
        at,
      });
    }
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  notifyFriends();
}

export const FRIENDS_EVENT = 'cocono:friends';
function notifyFriends() {
  window.dispatchEvent(new Event(FRIENDS_EVENT));
}

// --- peer facts cache (grey "identity verified" certificate badge) ---
// Filled whenever we resolve a peer's keys (chat open/send); the sidebar
// renders badges from here without per-row network calls.

// Patch-merge: endpoints that only know one fact (peerKeys → verified,
// viewProfile → premium) update the record without clobbering the other.
export async function rememberPeerVerified(peer, verified, premium) {
  const ul = String(peer).toLowerCase();
  const cur = (await withStore('readonly', (s) => s.get(ul), PEERS)) ?? { peer: ul };
  const next = { ...cur };
  if (verified !== undefined) next.verified = !!verified;
  if (premium !== undefined) next.premium = !!premium;
  await withStore('readwrite', (s) => s.put(next), PEERS);
}

// The badge a peer chose to wear next to their name (null = server fallback)
export async function rememberPeerChip(peer, chip) {
  const ul = String(peer).toLowerCase();
  const cur = (await withStore('readonly', (s) => s.get(ul), PEERS)) ?? { peer: ul };
  await withStore('readwrite', (st) => st.put({ ...cur, display: chip ?? null }), PEERS);
}

export async function loadPeerChips() {
  const rows = await withStore('readonly', (s) => s.getAll(), PEERS);
  const map = new Map();
  for (const r of rows ?? []) if (r.display) map.set(r.peer, r.display);
  return map;
}

export async function loadPeerPremiums() {
  const rows = await withStore('readonly', (s) => s.getAll(), PEERS);
  const map = new Map();
  for (const r of rows ?? []) map.set(r.peer, !!r.premium);
  return map;
}

// --- peer avatar cache (sidebar/chat-head photos without per-row fetches) ---
export const AVATARS_EVENT = 'cocono:avatars';

export async function loadPeerAvatars() {
  const rows = await withStore('readonly', (s) => s.getAll(), AVATARS);
  const map = new Map();
  for (const r of rows ?? []) map.set(r.peer, r);
  return map;
}

export async function rememberPeerAvatar(peer, avatar) {
  await withStore('readwrite', (s) => s.put({
    peer: String(peer).toLowerCase(),
    avatar: typeof avatar === 'string' && avatar ? avatar : null,
    ts: Date.now(),
  }), AVATARS);
  window.dispatchEvent(new Event(AVATARS_EVENT));
}

// Blocked peers ride the same PEERS mirror row (peer -> {blocked:true}).
// The server list is the source of truth; saveBlockedSet rebuilds the
// whole local view at login/reconcile so removals (unblocks on any device)
// survive. This mirror only drives BADGES (sidebar pill, chat bar) — every
// real gate is server-side.
export async function rememberPeerBlocked(peer, blocked) {
  const ul = String(peer).toLowerCase();
  const cur = (await withStore('readonly', (s) => s.get(ul), PEERS)) ?? { peer: ul };
  const next = { ...cur, blocked: !!blocked };
  await withStore('readwrite', (s) => s.put(next), PEERS);
}

export async function saveBlockedSet(peers) {
  const keep = new Set((peers ?? []).map((p) => String(p).toLowerCase()));
  const rows = await withStore('readonly', (s) => s.getAll(), PEERS);
  for (const r of rows ?? []) {
    const now = keep.has(r.peer);
    if (!!r.blocked !== now) {
      await withStore('readwrite', (s) => s.put({ ...r, blocked: now }), PEERS);
    }
  }
}

export async function loadPeerBlocked() {
  const rows = await withStore('readonly', (s) => s.getAll(), PEERS);
  const map = new Map();
  for (const r of rows ?? []) map.set(r.peer, !!r.blocked);
  return map;
}

export async function loadPeerVerifications() {
  const rows = await withStore('readonly', (s) => s.getAll(), PEERS);
  const map = new Map();
  for (const r of rows ?? []) map.set(r.peer, !!r.verified);
  return map;
}

// --- identity pins (TOFU + change detection; independent of friendship) ---
// record: { peer, p, firstSeenAt, lastSeenAt, prevP?, changedAt?, verified,
//           verifiedAt? }
// The FIRST key we ever see for a peer is pinned. Any later difference is a
// FACT (not the server's opinion): trust is revoked and stays revoked until
// the human re-verifies the new safety number. verified is bound to the
// exact key that was confirmed — a key change resets it.

export function getPin(peer) {
  return withStore('readonly', (s) => s.get(String(peer).toLowerCase()), PINS);
}

export function loadPins() {
  return withStore('readonly', (s) => s.getAll(), PINS);
}

/**
 * Record that we are now looking at `p` for `peer`.
 * @returns {'new'|'ok'|'changed'} — 'changed' ALSO resets verified state
 * and keeps prevP for the audit trail.
 */
export async function recordPinSeen(peer, p) {
  if (!p) return 'ok'; // nothing to pin (pre-identity accounts)
  const ul = String(peer).toLowerCase();
  const cur = await getPin(ul);
  const now = Date.now();
  if (!cur || !cur.p) {
    // 'new' also covers a record that only exists as a gone-marker (p:''):
    // the account name was re-registered, this device has not seen "the
    // old key" — first contact with the new identity, not a change.
    await withStore('readwrite', (s) => s.put(
      { peer: ul, p, firstSeenAt: now, lastSeenAt: now, verified: false },
    ), PINS);
    return 'new';
  }
  if (cur.p !== p) {
    await withStore('readwrite', (s) => s.put({
      ...cur, peer: ul, prevP: cur.p, changedAt: now, p, // the NEW key is pinned
      firstSeenAt: cur.firstSeenAt ?? now,
      lastSeenAt: now, verified: false, verifiedAt: null,
    }), PINS);
    return 'changed';
  }
  if (now - (cur.lastSeenAt ?? 0) > 60_000) { // avoid write churn
    await withStore('readwrite', (s) => s.put({ ...cur, lastSeenAt: now, gone: false }), PINS);
  }
  return 'ok';
}

/**
 * Remember the deleted-account fact LOCALLY. The server purges dead
 * usernames from friends lists, so no server flag survives to tell the
 * sidebar — we mark it where we actually learn it (chat open 404, send
 * rejection) and clear it when the account demonstrably exists again.
 * Lives on the pins record (same per-device store as the key alarm).
 */
export async function markPeerGone(peer, gone) {
  const ul = String(peer).toLowerCase();
  const cur = await getPin(ul);
  if (cur) {
    if (!!cur.gone === !!gone) return;
    await withStore('readwrite', (s) => s.put({ ...cur, gone: !!gone }), PINS);
  } else if (gone) {
    await withStore('readwrite', (s) => s.put({ peer: ul, p: '', gone: true }), PINS);
  }
  notifyFriends();
}

/**
 * Logout hygiene: wipe the device-local trust state (friends mirror + pins).
 * The friends mirror is a cache — it re-fetchedes from the server on the
 * next entry. PINS are deliberately destroyed too per product decision:
 * the next login gets a FRESH TOFU anchor (honest trade-off: change
 * detection does not survive a logout; full-erase of everything else stays
 * tied to 'remove this device').
 */
export async function clearLocalTrustData() {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction([FRIENDS, PINS], 'readwrite');
    tx.objectStore(FRIENDS).clear();
    tx.objectStore(PINS).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  notifyFriends();
}
