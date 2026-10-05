// Minimal dependency-free event emitter (works in browsers and Node alike;
// node:events would break bundler-free browser use).

export class Emitter {
  #handlers = new Map(); // type -> Set<fn>

  on(type, fn) {
    if (!this.#handlers.has(type)) this.#handlers.set(type, new Set());
    this.#handlers.get(type).add(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) {
    this.#handlers.get(type)?.delete(fn);
  }

  once(type, fn) {
    const off = this.on(type, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  emit(type, payload) {
    const set = this.#handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch {
        // A misbehaving listener must never break the client loop.
      }
    }
  }

  removeAllListeners(type) {
    if (type) this.#handlers.delete(type);
    else this.#handlers.clear();
  }
}
