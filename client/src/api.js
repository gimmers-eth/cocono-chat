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

  myProfile(token) {
    return this.#request('/api/me/profile', { token });
  }

  setProfile(token, patch) {
    return this.#request('/api/me/profile', { method: 'PUT', body: patch, token });
  }

  userProfile(token, ul) {
    return this.#request(`/api/users/${encodeURIComponent(ul)}/profile`, { token });
  }

  userStats(token, ul) {
    return this.#request(`/api/users/${encodeURIComponent(ul)}/stats`, { token });
  }

  submitIdDoc(token, { contentType, data }) {
    return this.#request('/api/me/verify-id', { method: 'POST', body: { contentType, data }, token });
  }

  // --- friends (one-way trust list; server = source of truth) ---
  listFriends(token) {
    return this.#request('/api/me/friends', { token });
  }

  addFriend(token, ul) {
    return this.#request(`/api/me/friends/${encodeURIComponent(ul)}`, { method: 'PUT', token });
  }

  removeFriend(token, ul) {
    return this.#request(`/api/me/friends/${encodeURIComponent(ul)}`, { method: 'DELETE', token });
  }

  verifyFriend(token, ul, verified) {
    return this.#request(`/api/me/friends/${encodeURIComponent(ul)}/verify`, {
      method: 'PUT', body: { verified }, token,
    });
  }

  trustFriend(token, ul, trust) {
    return this.#request(`/api/me/friends/${encodeURIComponent(ul)}/trust`, {
      method: 'PUT', body: { trust }, token,
    });
  }

  appInfo() {
    return this.#request('/api/app-info');
  }

  setPushSubscription(token, subscription) {
    return this.#request('/api/devices/push-subscription', { method: 'PUT', body: subscription, token });
  }

  deletePushSubscription(token) {
    return this.#request('/api/devices/push-subscription', { method: 'DELETE', token });
  }

  sendDiagnostics(report, token) {
    return this.#request('/api/diagnostics', { method: 'POST', body: { report }, token });
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

  removeDevice(token, deviceId) {
    return this.#request(`/api/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE', token });
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
