// Thin REST client over fetch. Every server interaction goes through here so
// baseUrl, errors and logging are handled in one place.

import { CoconoApiError, CoconoError } from './errors.js';
import { b64uEncode } from './encoding.js';

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

  // Byte-transfer variant: a media download is raw octet-stream, so there is
  // no JSON body to read — but an ERROR response still is, and its machine
  // code is what tells the app 'expired' (blob swept) from 'rate_limited'.
  async #requestBytes(path, { token, method = 'GET' } = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    this.logger.debug(`${method} ${path}`, '(bytes)');
    const res = await this.fetch(`${this.baseUrl}${path}`, { method, headers });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new CoconoApiError(res.status, data?.error, data?.message);
    }
    return new Uint8Array(await res.arrayBuffer());
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

  // who added me, not yet surfaced by any device (the blind-push wake reads
  // this over the authenticated wire; the username NEVER crosses the push
  pendingAdds(token) {
    return this.#request('/api/me/pending-adds', { token });
  }

  ackPendingAdd(by, token = undefined) {
    return this.#request('/api/me/pending-adds/ack', { method: 'POST', body: { by }, token });
  }

  submitIdDoc(token, { contentType, data }) {
    return this.#request('/api/me/verify-id', { method: 'POST', body: { contentType, data }, token });
  }

  // --- friends (one-way trust list; server = source of truth) ---
  listFriends(token) {
    return this.#request('/api/me/friends', { token });
  }

  muteUser(token, ul) {
    return this.#request(`/api/me/friends/${encodeURIComponent(ul)}/mute`, { method: 'PUT', token });
  }
  unmuteUser(token, ul) {
    return this.#request(`/api/me/friends/${encodeURIComponent(ul)}/mute`, { method: 'DELETE', token });
  }

  blockUser(token, ul, reason) {
    return this.#request(`/api/me/friends/${encodeURIComponent(ul)}/block`, { method: 'PUT', body: { r: reason }, token });
  }
  reportUser(token, payload) {
    return this.#request('/api/me/report', { method: 'POST', body: payload, token });
  }
  unblockUser(token, ul) {
    return this.#request(`/api/me/friends/${encodeURIComponent(ul)}/block`, { method: 'DELETE', token });
  }
  // whole tag SET for one peer (server replaces atomically; empty = none)
  setPeerTags(token, ul, tags) {
    return this.#request(`/api/me/friends/${encodeURIComponent(ul)}/tags`, { method: 'PUT', body: { tags }, token });
  }
  relationships(token) {
    return this.#request('/api/me/relationships', { token });
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

  // own verify/trust stage budgets (limits in force + spend this window)
  stageLimits(token) {
    return this.#request('/api/me/stage-limits', { token });
  }

  // badge poll: held list + unseen `new` awards (the read acks them)
  badges(token) {
    return this.#request('/api/me/badges', { token });
  }

  ackBadges(token, gids) {
    return this.#request('/api/me/badges/ack', { method: 'POST', body: { gids }, token });
  }

  appInfo() {
    return this.#request('/api/app-info');
  }

  // --- share links (attribution metadata; see be/src/lib/shares.js) ---
  // 'I opened <owner>'s /?chat= link and I already have an account.'
  shareHit(token, owner) {
    return this.#request('/api/share/hit', { method: 'POST', body: { o: owner }, token });
  }

  // own share-link path + what it has produced (counts only)
  myShareLink(token) {
    return this.#request('/api/me/share-link', { token });
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

  approveDevice(token, code, name) {
    return this.#request('/api/devices/approve', { method: 'POST', body: name ? { code, name } : { code }, token });
  }

  setDeviceName(token, deviceId, name) {
    return this.#request(`/api/devices/${encodeURIComponent(deviceId)}/name`, { method: 'PUT', body: { name }, token });
  }

  removeDevice(token, deviceId) {
    return this.#request(`/api/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE', token });
  }

  setDeviceSelf(token, payload) {
    return this.#request('/api/devices/self', { method: 'PUT', body: payload, token });
  }

  devices(token) {
    return this.#request('/api/devices', { token });
  }

  // --- messaging support ---
  peerKeys(token, username) {
    return this.#request(`/api/users/${encodeURIComponent(username)}/keys`, { token });
  }

  // --- media blobs (milestone 4) ---
  // Bytes move over REST (WS frames are capped at 64 KB); the message that
  // references them still rides the WS. All of these deal in CIPHERTEXT —
  // the key never appears here, it travels inside the recipient's envelope.
  uploadMedia(token, { kind, blob, thumb, sha256 }) {
    return this.#request('/api/media', {
      method: 'POST',
      token,
      body: {
        kind,
        blob: b64uEncode(blob),
        ...(thumb ? { thumb: b64uEncode(thumb) } : {}),
        sha256,
      },
    });
  }

  // part: 'thumb' asks for just the encrypted thumbnail (video posters
  // without pulling the full blob) — and it deliberately does NOT ack.
  downloadMediaRaw(token, id, { part = null } = {}) {
    return this.#requestBytes(
      `/api/media/${encodeURIComponent(id)}${part ? `?part=${encodeURIComponent(part)}` : ''}`,
      { token },
    );
  }

  // Register a blob WITHOUT its bytes, then stream them in with putMediaPart.
  // This is how a 100 MB file is uploaded: base64 would make it a 133 MB JSON
  // body (the server refuses that with `use_stream_upload`), and a raw stream
  // is also the only shape that can report progress and cut an over-cap upload
  // off mid-flight instead of buffering it first.
  createMedia(token, { kind, size, sha256, thumbSize = 0 }) {
    return this.#request('/api/media', {
      method: 'POST', token,
      body: { kind, size, sha256, ...(thumbSize ? { thumbSize } : {}) },
    });
  }

  // One part of a deferred upload (blob | thumb) as raw bytes.
  //
  // Progress needs `XMLHttpRequest.upload.onprogress`: fetch() cannot report
  // upload progress in Safari at all, and an upload you cannot show progress
  // for is an upload a phone user will assume is broken.
  putMediaPart(token, id, part, bytes, { onProgress, signal } = {}) {
    const url = `${this.baseUrl}/api/media/${encodeURIComponent(id)}/${part}`;
    return new Promise((resolve, reject) => {
      if (typeof XMLHttpRequest === 'undefined') {
        // non-browser host (Node tests, CLI): fetch has no upload progress,
        // which is irrelevant there
        const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        this.fetch(url, {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${token}` },
          body,
          ...(signal ? { signal } : {}),
        }).then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) { reject(new CoconoApiError(res.status, data?.error, data?.message)); return; }
          resolve(data);
        }, reject);
        return;
      }
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.setRequestHeader('authorization', `Bearer ${token}`);
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded, e.total); };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText || '{}'); } catch { /* non-JSON error body */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new CoconoApiError(xhr.status, data?.error, data?.message));
      };
      xhr.onerror = () => reject(new CoconoError('Upload failed — the connection dropped.', 'upload_failed'));
      xhr.onabort = () => reject(new Error('aborted'));
      if (signal) signal.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(bytes instanceof Uint8Array || bytes instanceof Blob ? bytes : new Uint8Array(bytes));
    });
  }

  // A byte-range read (the resume half of a big download) with counted
  // arrival. `start` is an offset into the CIPHERTEXT.
  async downloadMediaRange(token, id, { part = null, start = 0, onProgress, onChunk } = {}) {
    const qs = part ? `?part=${encodeURIComponent(part)}` : '';
    const headers = { authorization: `Bearer ${token}` };
    if (start > 0) headers.range = `bytes=${start}-`;
    const res = await this.fetch(`${this.baseUrl}/api/media/${encodeURIComponent(id)}${qs}`, { headers });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new CoconoApiError(res.status, data?.error, data?.message);
    }
    const totalHeader = Number(res.headers.get('content-length') ?? 0) + (start > 0 ? start : 0);
    if (!res.body || typeof res.body.getReader !== 'function') {
      const buf = new Uint8Array(await res.arrayBuffer());
      onProgress?.(start + buf.length, totalHeader);
      return buf;
    }
    // Counted as it arrives, so a 100 MB fetch reports real progress AND can
    // be abandoned with what it has so far (that's the resume handle).
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      try { onChunk?.(value, start + got, totalHeader); } catch { /* a bad progress hook must not kill a download */ }
      onProgress?.(start + got, totalHeader);
    }
    const out = new Uint8Array(got);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }

  ackMedia(token, id, downloaded) {
    return this.#request(`/api/media/${encodeURIComponent(id)}/ack`, {
      method: 'POST', body: { downloaded }, token,
    });
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
