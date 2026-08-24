// Identity store. Holds the non-exportable CryptoKey handles plus public
// material. Clearing this storage loses access to the account (by design).

const DB_NAME = 'cocono';
const STORE = 'identity';
const KEY = 'me';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// record: { username, deviceId, priv, pubRaw, aesRaw, aesEnc, aesMac }
export function saveIdentity(record) {
  return withStore('readwrite', (store) => store.put(record, KEY));
}

export function getIdentity() {
  return withStore('readonly', (store) => store.get(KEY));
}

export function clearIdentity() {
  return withStore('readwrite', (store) => store.delete(KEY));
}
