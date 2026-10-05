// Thin REST client over fetch. Every server interaction goes through here so
// baseUrl, errors and logging are handled in one place.

import { CoconoApiError } from './errors.js';

export class Api {
  constructor({ baseUrl = '', fetchImpl, logger }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetch = (fetchImpl ?? globalThis.fetch).bind(globalThis);
    this.logger = logger;
  }

  async #request(path, { method = 'GET', body, token } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    this.logger.debug(`${method} ${path}`, body ? '(payload omitted)' : '');
    const res = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new CoconoApiError(res.status, data?.error, data?.message);
    return data;
  }

  // --- accounts / auth ---
  signup(payload) {
    return this.#request('/api/signup', { method: 'POST', body: payload });
  }

  challenge(payload) {
    return this.#request('/api/auth/challenge', { method: 'POST', body: payload });
  }

  verify(payload) {
    return this.#request('/api/auth/verify', { method: 'POST', body: payload });
  }

  me(token) {
    return this.#request('/api/me', { token });
  }

  // --- devices / pairing ---
  enrollDevice(payload) {
    return this.#request('/api/devices/enroll', { method: 'POST', body: payload });
  }

  enrollStatus(enrollId) {
    return this.#request(`/api/devices/enroll-status/${encodeURIComponent(enrollId)}`);
  }

  pendingEnrollment(token, code) {
    return this.#request('/api/devices/pending', { method: 'POST', body: { code }, token });
  }

  approveDevice(token, code) {
    return this.#request('/api/devices/approve', { method: 'POST', body: { code }, token });
  }

  devices(token) {
    return this.#request('/api/devices', { token });
  }

  // --- messaging support ---
  peerKeys(token, username) {
    return this.#request(`/api/users/${encodeURIComponent(username)}/keys`, { token });
  }

  // --- transport URL (not a REST call, but baseUrl-relative by definition) ---
  wsUrl() {
    const abs = /^https?:\/\//.test(this.baseUrl)
      ? this.baseUrl
      : globalThis.location?.origin;
    if (!abs) throw new Error('Cannot derive WebSocket URL: pass an absolute baseUrl (e.g. http://127.0.0.1:3000) in non-browser environments');
    return abs.replace(/^http/, 'ws');
  }
}
