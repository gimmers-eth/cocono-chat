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
const DB_VERSION = 2;
const MESSAGES = 'messages';
const FRIENDS = 'friends';

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
// Resolves once deletion finished (or was attempted); rejects only on error.
export async function deleteAccountData(username) {
  const ul = String(username ?? '').toLowerCase();
  if (!ul) return;
  try {
    localStorage.removeItem(`cocono.reads.${ul}`);
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

// Usernames known ON THIS DEVICE (peers we hold messages with). No server
// contact — this is what the UI surfaces as "local users".
export async function knownPeers() {
  const all = await allMessages();
  return [...new Set(all.map((m) => String(m.peer).toLowerCase()))].sort();
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

export function loadFriends() {
  return withStore('readonly', (s) => s.getAll(), FRIENDS);
}

export async function friendAdd(peer) {
  await withStore('readwrite', (s) => s.put({ peer: String(peer).toLowerCase() }), FRIENDS);
  notifyFriends();
}

export async function friendDel(peer) {
  await withStore('readwrite', (s) => s.delete(String(peer).toLowerCase()), FRIENDS);
  notifyFriends();
}

/** Replace the whole local mirror with the authoritative server list. */
export async function setFriends(list) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(FRIENDS, 'readwrite');
    const store = tx.objectStore(FRIENDS);
    store.clear();
    for (const peer of list ?? []) store.put({ peer: String(peer).toLowerCase() });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  notifyFriends();
}

export const FRIENDS_EVENT = 'cocono:friends';
function notifyFriends() {
  window.dispatchEvent(new Event(FRIENDS_EVENT));
}
