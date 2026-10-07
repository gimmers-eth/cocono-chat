// Page-side access to the service worker's shared IndexedDB ('cocono-sw').
// Workers have no localStorage, so this is where the SW parks its diagnostics
// ring (store 'log') and the cached app title (store 'kv', written by the
// page on boot and by the worker after any app-info fetch).
// MUST stay in sync with the schema in sw-lib.js.

function openSwDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('cocono-sw', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('log')) db.createObjectStore('log', { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putAppTitle(name) {
  try {
    const db = await openSwDb();
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(String(name), 'apptitle');
    await new Promise((res) => { tx.oncomplete = res; tx.onerror = res; });
    db.close();
  } catch { /* diagnostics convenience only */ }
}

/** Newest-first-cap-free: returns up to the LAST n entries, oldest first. */
export async function readSwLog(n = 8) {
  try {
    const db = await openSwDb();
    if (!db.objectStoreNames.contains('log')) { db.close(); return []; }
    const rows = await new Promise((res, rej) => {
      const r = db.transaction('log', 'readonly').objectStore('log').getAll();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    db.close();
    return rows.slice(-n);
  } catch { return []; }
}

/**
 * Consume the 'pendingchat' entry (a notification click that cold-booted
 * the app — the SW parks the peer there, see sw.js notificationclick).
 * Returns the username AT MOST ONCE (delete-on-read), or null.
 */
export async function takePendingChat() {
  try {
    const db = await openSwDb();
    const value = await new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      const store = tx.objectStore('kv');
      const get = store.get('pendingchat');
      get.onsuccess = () => { if (get.result != null) store.delete('pendingchat'); };
      tx.oncomplete = () => res(get.result ?? null);
      tx.onerror = () => rej(tx.error);
    });
    db.close();
    return typeof value === 'string' && value ? value : null;
  } catch { return null; }
}
