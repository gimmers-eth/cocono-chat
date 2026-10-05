// App-side message store (IndexedDB). The SDK owns identity + crypto; this
// owns the decrypted transcript so history survives reloads.
//
// record: { id, peer, dir: 'in'|'out', text, ts, state?, fromDeviceId? }
//   id:    outgoing = 'out:'+localId (one per logical send)
//          incoming = 'in:'+server mid (one per device copy)

const DB_NAME = 'cocono-app';
const DB_VERSION = 1;
const MESSAGES = 'messages';

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(MESSAGES)) {
          const store = db.createObjectStore(MESSAGES, { keyPath: 'id' });
          store.createIndex('byPeer', 'peer');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MESSAGES, mode);
    const req = fn(tx.objectStore(MESSAGES));
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

export function allMessages() {
  return withStore('readonly', (s) => s.getAll());
}

// --- read markers (lightweight, localStorage) ---

const READ_KEY = 'cocono.reads';

const reads = () => {
  try {
    return JSON.parse(localStorage.getItem(READ_KEY) ?? '{}');
  } catch {
    return {};
  }
};

export function markRead(peer, ts = Date.now()) {
  const r = reads();
  r[peer.toLowerCase()] = ts;
  localStorage.setItem(READ_KEY, JSON.stringify(r));
}

export const isUnread = (peer, ts) => (ts ?? 0) > (reads()[String(peer).toLowerCase()] ?? 0);
