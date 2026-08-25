// Identity + message stores. The identity holds the non-exportable CryptoKey
// handles plus public material; clearing it loses access to the account (by
// design). Pulled messages live only here (server deletes them on pull).

const DB_NAME = 'cocono';
const DB_VERSION = 2;
const IDENTITY = 'identity';
const MESSAGES = 'messages';
const KEY = 'me';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDENTITY)) db.createObjectStore(IDENTITY);
      if (!db.objectStoreNames.contains(MESSAGES)) {
        const store = db.createObjectStore(MESSAGES, { keyPath: 'id' });
        store.createIndex('byPeer', 'peer');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// --- identity ---

// record: { username, deviceId, priv, pubRaw, xPriv, xPubRaw, aesEnc, aesMac }
// (M3 fix: raw AES bytes are deliberately NOT stored — only the
// non-exportable CryptoKey handles survive the initial import.)
export function saveIdentity(record) {
  return withStore(IDENTITY, 'readwrite', (store) => store.put(record, KEY));
}

export function getIdentity() {
  return withStore(IDENTITY, 'readonly', (store) => store.get(KEY));
}

export function clearIdentity() {
  return withStore(IDENTITY, 'readwrite', (store) => store.delete(KEY));
}

// --- messages (milestone 3) ---
// record: { id, peer, dir: 'in'|'out', text, ts, state }
//   id:    outgoing = client cid; incoming = server mid
//   state: 'sending' | 'sent' | 'delivered' | 'failed' (outgoing only)

export function saveMessage(msg) {
  return withStore(MESSAGES, 'readwrite', (store) => store.put(msg));
}

export function getMessage(id) {
  return withStore(MESSAGES, 'readonly', (store) => store.get(id));
}

export async function updateMessage(id, patch) {
  const existing = await getMessage(id);
  if (!existing) return null;
  return withStore(MESSAGES, 'readwrite', (store) => store.put({ ...existing, ...patch }));
}

export function messagesWith(peer) {
  return withStore(MESSAGES, 'readonly', (store) =>
    store.index('byPeer').getAll(IDBKeyRange.only(peer)),
  );
}

export async function allMessages() {
  return withStore(MESSAGES, 'readonly', (store) => store.getAll());
}
