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
  #records = new Map(); // username (lowercase) -> identity record
  #current = null;      // active username

  async saveIdentity(record) {
    const ul = String(record.username).toLowerCase();
    this.#records.set(ul, record);
    this.#current = ul;
  }

  async loadIdentity() {
    return this.#current === null ? null : this.#records.get(this.#current) ?? null;
  }

  async clearIdentity() {
    if (this.#current !== null) this.#records.delete(this.#current);
    this.#current = null;
  }

  /** All identities held on this device (any account). */
  async listIdentities() {
    return [...this.#records.values()];
  }

  /** Stored accounts: {username, deviceId, current} per record. */
  async listAccounts() {
    return [...this.#records.entries()].map(([ul, rec]) => ({
      username: ul,
      deviceId: rec.deviceId,
      current: ul === this.#current,
    }));
  }

  /** Make a stored account the active one (no key material touched). */
  async useAccount(username) {
    const ul = String(username).toLowerCase();
    if (!this.#records.has(ul)) throw new Error(`no stored account "${ul}"`);
    this.#current = ul;
  }

  /** Delete one account's stored identity; re-points 'current' if needed. */
  async removeAccount(username) {
    const ul = String(username).toLowerCase();
    const removed = this.#records.delete(ul);
    if (this.#current === ul) this.#current = this.#records.keys().next().value ?? null;
    return removed;
  }
}

// Browser adapter: IndexedDB, structured-clone (CryptoKey-safe). Identity
// records are keyed PER USERNAME ('identity:<ul>') with a 'current' pointer
// for the active account — the groundwork for multi-account support and the
// reason no data can bleed between accounts.
export class IdbStorage {
  static CURRENT = 'current';
  static keyFor(username) {
    return `identity:${String(username).toLowerCase()}`;
  }

  #dbPromise = null;

  constructor(dbName = 'cocono-client-sdk', version = 2) {
    this.dbName = dbName;
    this.version = version;
  }

  #open() {
    if (!this.#dbPromise) {
      this.#dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(this.dbName, this.version);
        req.onupgradeneeded = (ev) => {
          const db = req.result;
          if (!db.objectStoreNames.contains('identity')) db.createObjectStore('identity');
          // v1 kept a single device-wide identity under 'me' — migrate it to
          // a username-scoped record with a 'current' pointer.
          if (ev.oldVersion >= 1) {
            const store = req.transaction.objectStore('identity');
            const get = store.get('me');
            get.onsuccess = () => {
              const rec = get.result;
              if (rec?.username) {
                store.put(rec, IdbStorage.keyFor(rec.username));
                store.put(String(rec.username).toLowerCase(), IdbStorage.CURRENT);
              }
              store.delete('me');
            };
          }
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
    const ul = await this.#withStore('readonly', (s) => s.get(IdbStorage.CURRENT));
    if (!ul) return undefined;
    return this.#withStore('readonly', (s) => s.get(IdbStorage.keyFor(ul)));
  }

  async saveIdentity(record) {
    const ul = String(record.username).toLowerCase();
    await this.#withStore('readwrite', (s) => s.put(record, IdbStorage.keyFor(ul)));
    await this.#withStore('readwrite', (s) => s.put(ul, IdbStorage.CURRENT));
  }

  // Wipe the ACTIVE account's identity (keys). App-side data is cleared by
  // the UI's deleteAccountData() when the user forgets a device.
  async clearIdentity() {
    const ul = await this.#withStore('readonly', (s) => s.get(IdbStorage.CURRENT));
    if (ul) await this.#withStore('readwrite', (s) => s.delete(IdbStorage.keyFor(ul)));
    await this.#withStore('readwrite', (s) => s.delete(IdbStorage.CURRENT));
  }

  /** All identities held on this device (any account). */
  async listIdentities() {
    const recs = await this.#withStore('readonly', (s) => s.getAll());
    return recs.filter((r) => r && typeof r === 'object' && r.username);
  }

  /** Stored accounts: {username, deviceId, current} per record. */
  async listAccounts() {
    const [recs, current] = await Promise.all([
      this.listIdentities(),
      this.#withStore('readonly', (s) => s.get(IdbStorage.CURRENT)),
    ]);
    return recs.map((r) => ({
      username: String(r.username).toLowerCase(),
      deviceId: r.deviceId,
      current: String(r.username).toLowerCase() === current,
    }));
  }

  /** Make a stored account the active one. */
  async useAccount(username) {
    const ul = String(username).toLowerCase();
    const rec = await this.#withStore('readonly', (s) => s.get(IdbStorage.keyFor(ul)));
    if (!rec) throw new Error(`no stored account "${ul}"`);
    await this.#withStore('readwrite', (s) => s.put(ul, IdbStorage.CURRENT));
  }

  /** Delete one account's stored identity; re-points 'current' if needed. */
  async removeAccount(username) {
    const ul = String(username).toLowerCase();
    await this.#withStore('readwrite', (s) => s.delete(IdbStorage.keyFor(ul)));
    const current = await this.#withStore('readonly', (s) => s.get(IdbStorage.CURRENT));
    if (current === ul) {
      const rest = await this.listAccounts();
      await this.#withStore('readwrite', (s) =>
        rest.length ? s.put(rest[0].username, IdbStorage.CURRENT) : s.delete(IdbStorage.CURRENT));
    }
    return true;
  }
}
