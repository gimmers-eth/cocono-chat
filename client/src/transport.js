// Chat WebSocket transport: connect, auto-reconnect (exponential backoff +
// jitter), browser-visibility kick, and event emission. Mirrors the strategy
// in fe/js/ws.js but exposes events instead of callbacks.

import { Emitter } from './emitter.js';

const BASE_MS = 1000;
const MAX_MS = 30000;

export class Transport extends Emitter {
  #ws = null;
  #attempt = 0;
  #timer = null;
  #stopped = false;

  constructor({ getUrl, getToken, logger }) {
    super();
    this.getUrl = getUrl; // () => ws://...  (without token)
    this.getToken = getToken; // () => current JWT
    this.logger = logger;
    // Re-attach listeners to reconnect on network restore / tab focus.
    if (typeof document !== 'undefined') {
      const announcePresence = () => {
        if (this.state !== 'open') return;
        const focused = document.visibilityState === 'visible' && (document.hasFocus?.() ?? true);
        try { this.send({ type: 'presence', online: focused }); } catch { /* transient */ }
      };
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.kick();
        announcePresence();
      });
      if (typeof window !== 'undefined') {
        window.addEventListener('focus', announcePresence);
        window.addEventListener('blur', announcePresence);
        window.addEventListener('online', () => this.kick());
      }
    } else if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.kick());
    }
  }

  get state() {
    if (!this.#ws) return 'closed';
    return ['connecting', 'open', 'closing', 'closed'][this.#ws.readyState];
  }

  connect() {
    if (this.#stopped) return;
    if (this.#ws && (this.#ws.readyState === 0 || this.#ws.readyState === 1)) return;
    if (this.#timer) return; // reconnect already scheduled
    const token = this.getToken();
    if (!token) throw new Error('Cannot connect: no session token — login() first');
    const url = `${this.getUrl()}/ws?token=${encodeURIComponent(token)}`;
    this.logger.debug('ws connecting');
    this.emit('state', 'connecting');
    const ws = new WebSocket(url);
    this.#ws = ws;
    ws.onopen = () => {
      this.#attempt = 0;
      this.logger.debug('ws open');
      this.emit('state', 'open');
    };
    ws.onmessage = (e) => {
      let frame;
      try {
        frame = JSON.parse(e.data);
      } catch {
        return; // ignore malformed frames
      }
      this.emit('frame', frame);
    };
    ws.onclose = () => {
      if (this.#ws === ws) this.#ws = null;
      this.emit('state', 'closed');
      if (!this.#stopped) this.#scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose always follows */
    };
  }

  #scheduleReconnect() {
    if (this.#timer || this.#stopped) return;
    const delay = Math.min(BASE_MS * 2 ** this.#attempt, MAX_MS);
    const jitter = Math.random() * 1000;
    this.#attempt += 1;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.connect();
    }, delay + jitter);
  }

  /** Force an immediate reconnect attempt (e.g. after coming back online). */
  kick() {
    this.#attempt = 0;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (!this.#ws || this.#ws.readyState === 2 || this.#ws.readyState === 3) this.connect();
  }

  send(obj) {
    if (this.#ws?.readyState === 1) {
      this.#ws.send(JSON.stringify(obj));
      return true;
    }
    this.logger.warn('ws frame dropped (socket not open):', obj?.type);
    return false;
  }

  close() {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#ws?.close();
    this.#ws = null;
  }
}
