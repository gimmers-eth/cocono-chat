// Pluggable identity storage. An identity record holds non-extractable
// CryptoKey handles (priv, xPriv, aesEnc, aesMac) plus public material —
// losing it means losing access to the account (by design).
//
//   {
//     username, deviceId,
//     pubRaw   // b64u Ed25519 public key
//     xPubRaw  // b64u X25519 public key
//     priv, xPriv, aesEnc, aesMac   // CryptoKey handles
//   }

export class MemoryStorage {
  #identity = null;

  async loadIdentity() {
    return this.#identity;
  }

  async saveIdentity(record) {
    this.#identity = record;
  }

  async clearIdentity() {
    this.#identity = null;
  }
}

// Browser adapter: IndexedDB, structured-clone (CryptoKey-safe). Mirrors the
// 'identity' store in fe/js/db.js.
export class IdbStorage {
  #dbPromise = null;

  constructor(dbName = 'cocono-client-sdk', version = 1) {
    this.dbName = dbName;
    this.version = version;
  }

  #open() {
    if (!this.#dbPromise) {
      this.#dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(this.dbName, this.version);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains('identity')) req.result.createObjectStore('identity');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this.#dbPromise;
  }

  async #withStore(mode, fn) {
    const db = await this.#open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('identity', mode);
      const req = fn(tx.objectStore('identity'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async loadIdentity() {
    return this.#withStore('readonly', (s) => s.get('me'));
  }

  async saveIdentity(record) {
    return this.#withStore('readwrite', (s) => s.put(record, 'me'));
  }

  async clearIdentity() {
    return this.#withStore('readwrite', (s) => s.delete('me'));
  }
}
