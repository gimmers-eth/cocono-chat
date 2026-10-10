// A tiny in-memory IndexedDB stand-in, good enough for the APP STORE's own
// surface (open + upgrade, single-store transactions, get / put / delete /
// index.getAll(range) / count / clear) so the app-side media pipeline — the
// code that decides what auto-downloads, what gets acked, what ages out — can
// run under `node --test` against the REAL backend instead of only in a
// browser.
//
// It is deliberately NOT a general IndexedDB: no cursors, no composite keys,
// no versionchange transactions, no structured-clone fidelity (Blobs survive
// here by reference, which is exactly what the media rows hold). When a test
// needs more than this, it belongs in a browser (the plan's devbox smoke).

const databases = new Map();

class Request {
  constructor() {
    this.result = undefined;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
    this.onupgradeneeded = null;
  }

  #fire(kind) {
    setTimeout(() => {
      const h = kind === 'error' ? this.onerror : this.onsuccess;
      h?.({ target: this });
    }, 0);
  }

  settle(result) { this.result = result; this.#fire('ok'); return this; }
  fail(error) { this.error = error; this.#fire('error'); return this; }
}

class Index {
  constructor(name, field, store) {
    this.name = name;
    this.field = field;
    this.owner = store;
  }

  getAll(range) {
    return this.owner.match(range ? { field: this.field, value: range.only } : null);
  }
}

class Store {
  constructor(name, keyPath) {
    this.name = name;
    this.keyPath = keyPath;
    this.records = new Map();
    this.indexes = new Map();
  }

  createIndex(name, field) {
    this.indexes.set(name, new Index(name, field, this));
    return this.indexes.get(name);
  }

  index(name) {
    const idx = this.indexes.get(name);
    if (!idx) throw new Error(`no such index: ${name}`);
    return idx;
  }

  // a Range in this shim is always "one field equals one value" (IDBKeyRange
  // .only), which is all the app store asks for
  match({ field, value } = {}) {
    const all = [...this.records.values()];
    const rows = field ? all.filter((r) => r[field] === value) : all;
    return new Request().settle(rows);
  }

  put(value) {
    // structured clone ≈ a deep copy, minus the things we WANT to keep by
    // reference: a media row's Blob must survive as the same object
    const copy = { ...value };
    this.records.set(copy[this.keyPath], copy);
    return new Request().settle(copy[this.keyPath]);
  }

  getAll(range) {
    // a bare getAll() is the whole store; with a range it is the KEY path
    // (an index query goes through Index.getAll, which knows its field)
    if (!range) return new Request().settle([...this.records.values()]);
    return this.match({ field: this.keyPath, value: range.only });
  }

  get(key) { return new Request().settle(this.records.get(key)); }

  delete(key) { this.records.delete(key); return new Request().settle(undefined); }

  clear() { this.records.clear(); return new Request().settle(undefined); }

  count() { return new Request().settle(this.records.size); }
}

class Transaction {
  constructor(db, names) {
    this.db = db;
    this.names = Array.isArray(names) ? names : [names];
    this.oncomplete = null;
    this.onerror = null;
    this._failed = false;
    // every request here mutates synchronously, so a transaction that is never
    // awaited is already done: complete it on the next tick (store.js's
    // clearMessages-style callers set oncomplete in the same tick they delete)
    setTimeout(() => { if (!this._failed) this.oncomplete?.(); }, 0);
  }

  objectStore(name) {
    if (!this.db.stores.has(name)) throw new Error(`no such store: ${name}`);
    return this.db.stores.get(name);
  }
}

class Db {
  constructor(name) {
    this.name = name;
    this.stores = new Map();
    this.objectStoreNames = { contains: (n) => this.stores.has(n) };
  }

  createObjectStore(name, { keyPath }) {
    const store = new Store(name, keyPath);
    this.stores.set(name, store);
    return store;
  }

  transaction(names) { return new Transaction(this, names); }

  close() { /* nothing to release */ }
}

export const storedDatabases = databases;

/** Install the globals the app store expects. Call BEFORE importing store.js. */
export function installIdbShim() {
  globalThis.indexedDB = {
    open(name, version) {
      const req = new Request();
      const fresh = !databases.has(name);
      const db = databases.get(name) ?? new Db(name);
      req.result = db;
      setTimeout(() => {
        if (fresh) {
          req.oldVersion = 0;
          req.onupgradeneeded?.({ target: req, newVersion: version });
          db.version = version;
          databases.set(name, db);
        }
        req.onsuccess?.({ target: req });
      }, 0);
      return req;
    },
    deleteDatabase(name) {
      databases.delete(name);
      return new Request().settle(undefined);
    },
  };
  globalThis.IDBKeyRange = { only: (value) => ({ only: value }) };

  // store.js keeps read markers + the account-owner guard in localStorage, and
  // fires FRIENDS_EVENT/AVATARS_EVENT on window — both inert here
  const mem = new Map();
  globalThis.localStorage ??= {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
  };
  globalThis.window ??= {
    dispatchEvent() {}, addEventListener() {}, removeEventListener() {},
  };
  globalThis.Event ??= class { constructor(type) { this.type = type; } };
  globalThis.CustomEvent ??= class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };

  return { reset: () => databases.clear() };
}
