// CoconoClient — the whole public surface of the SDK. Everything the old FE
// did is available here: register, login, device pairing, messaging. Receiving
// is event-driven: 'message', 'ack', 'delivered', 'state', 'ready', 'error'.

import { Api } from './api.js';
import { Transport } from './transport.js';
import { Emitter } from './emitter.js';
import { CoconoError } from './errors.js';
import { MemoryStorage } from './storage.js';
import { createLogger } from './logger.js';
import { canonical, nowEpoch } from './encoding.js';
import { localSeal, localUnseal } from './localseal.js';
import * as c from './crypto.js';

// iOS/iPadOS WebKit: storing CryptoKey HANDLES in IndexedDB is broken (the
// record deserializes empty after reload), so passkey-PRF sealing is
// mandatory there — a silent fallback there creates accounts that die on
// refresh, which is the bug this guards against.
const iosLike = () =>
  typeof navigator !== 'undefined' &&
  /iPhone|iPad|iPod/.test(navigator.userAgent) &&
  (navigator.maxTouchPoints ?? 0) > 0;

export class CoconoClient extends Emitter {
  #identity = null; // loaded lazily from storage
  #transport = null;
  #peerCache = new Map(); // ul -> { u, devices: [{d,p,x}] }
  #convKeyCache = new Map(); // `${ul}:${dv}` -> CryptoKey
  #cidToLocal = new Map(); // outgoing cid -> localId
  #pendingPairing = null; // { username, deviceId, keyPair, xPair, aesRaw, pubRaw, xPubRaw, enrollId, expiresAt }

  /**
   * @param {object} options
   * @param {string} [options.baseUrl]        Server origin, e.g. 'http://127.0.0.1:3000'. '' = same-origin (browser).
   * @param {boolean|function} [options.logging=false]  true = console, or a custom (level, ...args) sink.
   * @param {object} [options.storage]        Identity persistence: MemoryStorage (default), IdbStorage, or your own
   *                                          {loadIdentity, saveIdentity, clearIdentity} adapter.
   * @param {function} [options.fetchImpl]    Custom fetch (rarely needed).
   */
  constructor({ baseUrl = '', logging = false, storage = new MemoryStorage(), fetchImpl } = {}) {
    super();
    this.logger = createLogger(logging);
    this.storage = storage;
    this.api = new Api({ baseUrl, fetchImpl, logger: this.logger });
    this.token = null;
  }

  get username() {
    return this.#identity?.username ?? null;
  }

  get deviceId() {
    return this.#identity?.deviceId ?? null;
  }

  // --- identity helpers ---

  async #loadIdentity() {
    if (!this.#identity) {
      const stored = await this.storage.loadIdentity();
      // Normalise identities persisted before lowercase normalisation.
      if (stored?.username) stored.username = stored.username.toLowerCase();
      this.#identity = stored ?? null;
    }
    return this.#identity;
  }

  async #requireIdentity() {
    const identity = await this.#loadIdentity();
    if (!identity) throw new CoconoError('No identity on this device — register(), login() or pair() first.', 'no_identity');
    return identity;
  }

  #requireToken() {
    if (!this.token) throw new CoconoError('Not logged in — call login() first.', 'not_authenticated');
    return this.token;
  }

  /**
   * Build a fully new device identity (keys + transport AES) and produce the
   * signed payload shared by signup and enroll.
   */
  async #generateDevicePayload(username, { extractable = false } = {}) {
    // Usernames are normalised to lowercase: the signed payload, the stored
    // identity and everything displayed downstream agree on the lowercase form.
    username = username.toLowerCase();
    const keyPair = await c.generateIdentityKeyPair(extractable);
    const pubRaw = await c.exportRawPublicKey(keyPair.publicKey);
    const xPair = await c.generateX25519KeyPair(extractable);
    const xPubRaw = await c.exportRawX25519(xPair.publicKey);
    const aesKey = await c.generateAesKey();
    const aesRaw = await c.exportRawAesKey(aesKey);
    const deviceId = c.newDeviceId();
    const t = nowEpoch();
    // The server checks the signature over canonical({ a, d, p, t, u, x }).
    const s = await c.sign(keyPair.privateKey, canonical({ a: aesRaw, d: deviceId, p: pubRaw, t, u: username, x: xPubRaw }));
    return { username, deviceId, keyPair, pubRaw, xPair, xPubRaw, aesRaw, payload: { u: username, p: pubRaw, x: xPubRaw, a: aesRaw, d: deviceId, t, s } };
  }

  // `sealed` (see localseal.js): { bundle:{format:4,...}, runtime:{handles} }
  //   format 4 — local-wrapped bytes (iOS: plain bytes persist where CryptoKey
  //              handles rot)
  //   null     — legacy CryptoKey handle record (fine on engines that persist
  //              handles; v3 passkey records, if ever seen, are read via
  //              listIdentities but no longer creatable)
  async #persistIdentity(device, tokenLogin = true, sealed = null) {
    const runtime = sealed
      ? sealed.runtime
      : { ...(await c.importAesKeys(device.aesRaw)), priv: device.keyPair.privateKey, xPriv: device.xPair.privateKey };
    const identity = {
      username: device.username,
      deviceId: device.deviceId,
      pubRaw: device.pubRaw,
      xPubRaw: device.xPubRaw,
      ...runtime,
    };
    const stored = sealed
      ? {
          ...sealed.bundle,
          username: identity.username,
          deviceId: identity.deviceId,
          pubRaw: identity.pubRaw,
          xPubRaw: identity.xPubRaw,
        }
      : identity;
    await this.storage.saveIdentity(stored);
    this.#identity = identity;
    this.logger.info(`identity stored for @${identity.username} device ${identity.deviceId} (${sealed ? 'local-sealed' : 'key handles'})`);
    if (tokenLogin) this.token = await this.#challengeVerify(identity);
    return identity;
  }

  // Seal strategy: WebKit (iOS) corrupts persisted CryptoKey HANDLES, so it
  // gets local-wrap bytes (v4, durable, silent unlock). Engines that persist
  // handles keep the legacy v2 record. Passkey-PRF sealing (v3) was retired
  // as dead weight: where PRF is unsupported it littered the OS vault with
  // never-used credentials, and where the device already authenticates (Face
  // ID unlocking the app's sandbox) it added little on top. The v3 record
  // shape remains readable for anything created while it existed.
  async #sealStrategy(device) {
    if (iosLike()) {
      try {
        return await localSeal(device.username, device);
      } catch (err) {
        throw new CoconoError(
          `Cannot store keys safely on this device: ${err?.message ?? err}. ` +
          'No account was created.',
          'key_storage_unavailable',
        );
      }
    }
    return null;
  }

  async #challengeVerify(identity) {
    const { n } = await this.api.challenge({ u: identity.username, d: identity.deviceId });
    const s = await c.sign(identity.priv, n);
    const { token } = await this.api.verify({ u: identity.username, d: identity.deviceId, n, s });
    this.token = token;
    this.emit('ready', { username: identity.username, deviceId: identity.deviceId });
    this.logger.info(`session opened for @${identity.username}`);
    return token;
  }

  // ==================== public API ====================

  /**
   * Register a new account (this device becomes the main one) and log in.
   * @returns {Promise<{username: string, deviceId: string, token: string}>}
   */
  async register(username) {
    if (this.#identity) throw new CoconoError('This device already holds an identity — log out or use a fresh client.', 'identity_exists');
    const canSeal = iosLike();
    const device = await this.#generateDevicePayload(username, { extractable: canSeal });
    // Seal BEFORE touching the server: a failure here must not leave a
    // half-created account we cannot safely key.
    const sealed = await this.#sealStrategy(device);
    await this.api.signup(device.payload);
    const identity = await this.#persistIdentity(device, true, sealed);
    return { username: identity.username, deviceId: identity.deviceId, token: this.token };
  }

  /** Log in with the identity stored on this device. @returns {Promise<string>} token */
  async login() {
    const identity = await this.#requireIdentity();
    // v4 (local-wrap) records keep only bytes; unseal silently before use.
    if (identity.format === 4 && !identity.priv) Object.assign(identity, await localUnseal(identity));
    return this.#challengeVerify(identity);
  }

  /** Accounts whose identity is stored on THIS device: [{username, deviceId, current}]. */
  async storedAccounts() {
    if (this.storage.listAccounts) return this.storage.listAccounts();
    const rec = await this.storage.loadIdentity();
    return rec ? [{ username: String(rec.username).toLowerCase(), deviceId: rec.deviceId, current: true }] : [];
  }

  /**
   * Make a stored account the active one (the login screen's "use"). Clears
   * the in-memory identity so the next login() loads the newly selected one.
   */
  async useStoredAccount(username) {
    if (!this.storage.useAccount) throw new CoconoError('This storage adapter cannot switch accounts.', 'unsupported');
    await this.storage.useAccount(username);
    this.#identity = null;
    this.logout();
  }

  /**
   * Forget ONE account on this device: removes its stored identity (and
   * re-points the active account if it was the one). Returns the username so
   * callers can also wipe that account's message data.
   */
  async removeStoredAccount(username) {
    const ul = String(username).toLowerCase();
    if (this.storage.removeAccount) await this.storage.removeAccount(ul);
    else {
      const cur = await this.storage.loadIdentity();
      if (cur && String(cur.username).toLowerCase() === ul) await this.forget();
      else return ul;
    }
    if (this.#identity && String(this.#identity.username).toLowerCase() === ul) {
      this.#identity = null;
      this.logout();
    } else if (this.storage.loadIdentity) {
      // Active account changed under us (pointer re-point): reload lazily.
      this.#identity = null;
    }
    return ul;
  }

  /**
   * Detach THIS device from its account on the server (queues swept; the
   * account survives on its other devices — removing the last one leaves it
   * ORPHANED: username reserved, no device can access it). The JWT stops
   * working immediately server-side; call order matters: detach FIRST, then
   * forget locally. Requires a live session (login() first).
   * @returns {Promise<{removed: string, devices: number, accountDeleted?: boolean}>}
   */
  async detachCurrentDevice() {
    const identity = await this.#requireIdentity();
    this.#requireToken();
    const res = await this.api.removeDevice(this.token, identity.deviceId);
    this.logout();
    this.logger.info(`device ${identity.deviceId} detached from @${identity.username} (accountDeleted=${res.accountDeleted === true})`);
    return res;
  }

  /** Forget the session (token only). Identity keys stay in storage. */
  logout() {
    this.token = null;
    this.disconnect();
  }

  /** Wipe the on-device identity (keys) and session. Account access from this device is gone. */
  async forget() {
    this.logout();
    await this.storage.clearIdentity();
    this.#identity = null;
    this.#convKeyCache.clear();
    this.#cidToLocal.clear();
  }

  /**
   * Enable OS notifications for this device (Web Push, Phase 1 = blind
   * 'activity' pings — content never crosses the push service). Ask from a
   * user-gesture context (login/signup button); `prompt:false` re-registers
   * an already-granted subscription silently.
   * @returns {Promise<{state: 'enabled'|'denied'|'needs-prompt'|'unsupported'|'unconfigured', permission?: string}>}
   */
  async enablePush({ prompt = true } = {}) {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)
      || typeof PushManager === 'undefined' || typeof Notification === 'undefined') {
      return { state: 'unsupported' };
    }
    let permission = Notification.permission;
    if (permission === 'default') {
      if (!prompt) return { state: 'needs-prompt' };
      permission = await Notification.requestPermission();
    }
    if (permission !== 'granted') return { state: 'denied', permission };
    const info = await this.api.appInfo();
    if (!info?.vapidPublicKey) return { state: 'unconfigured', permission };
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: info.vapidPublicKey,
      });
    }
    const j = sub.toJSON();
    await this.api.setPushSubscription(this.#requireToken(), { endpoint: j.endpoint, keys: j.keys });
    this.logger.info('push subscription registered');
    return { state: 'enabled', permission };
  }

  /** Unsubscribe this device from push (OS subscription + server record). */
  async disablePush() {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
    } catch { /* best effort */ }
    try { await this.api.deletePushSubscription(this.#requireToken()); } catch { /* best effort */ }
    this.logger.info('push subscription removed');
    return { state: 'disabled' };
  }

  /**
   * Upload a plain-text diagnostics report (see the app's Storage
   * diagnostics panel). Works before login too; attaches the token when
   * logged in so the report can be linked to the account.
   */
  async sendDiagnostics(report) {
    return this.api.sendDiagnostics(report, this.token ?? undefined);
  }

  /** Current account info (GET /api/me). */
  async me() {
    return this.api.me(this.#requireToken());
  }

  /** List devices on the current account (GET /api/devices). */
  async devices() {
    return this.api.devices(this.#requireToken());
  }

  /**
   * Detach ONE device from the current account (DELETE /api/devices/:id).
   * Any signed-in device may remove any other; removing your own logs you
   * out (the JWT dies with the device entry). Detaching the last device deletes
   * the account outright (username released).
   */
  async removeDevice(deviceId) {
    const res = await this.api.removeDevice(this.#requireToken(), deviceId);
    const identity = this.#identity;
    if (identity && deviceId === identity.deviceId) {
      this.logout();
      await this.storage.clearIdentity();
      this.#identity = null;
    }
    return res;
  }

  /** Public key material for a peer (GET /api/users/:username/keys). */
  async peerKeys(username, { refresh = false } = {}) {
    const ul = username.toLowerCase();
    if (refresh || !this.#peerCache.has(ul)) {
      this.#peerCache.set(ul, await this.api.peerKeys(this.#requireToken(), username));
    }
    return this.#peerCache.get(ul);
  }

  /** Drop cached key material for a peer (e.g. after they add a device). */
  forgetPeer(username) {
    this.#peerCache.delete(username.toLowerCase());
  }

  /**
   * Pairing, NEW-device side step 1: request to join an existing account.
   * Returns the 6-digit code to show the user; an already-paired device must
   * approve it via approvePairing(code).
   * @returns {Promise<{code: string, enrollId: string, expiresInSec: number, deviceId: string}>}
   */
  async beginPairing(username) {
    if (this.#identity || this.#pendingPairing) {
      throw new CoconoError('This device already holds or is pairing an identity.', 'identity_exists');
    }
    const canSeal = iosLike();
    const device = await this.#generateDevicePayload(username, { extractable: canSeal });
    const sealed = await this.#sealStrategy(device);
    const { code, enrollId, expiresInSec } = await this.api.enrollDevice(device.payload);
    this.#pendingPairing = { ...device, sealed, enrollId, expiresAt: Date.now() + expiresInSec * 1000 };
    this.logger.info(`pairing requested for @${username}, code ${code}`);
    return { code, enrollId, expiresInSec, deviceId: device.deviceId };
  }

  /**
   * Pairing, NEW-device side step 2: poll until the code is approved, then
   * store the identity and log in.
   */
  async completePairing({ pollIntervalMs = 2000 } = {}) {
    const pending = this.#pendingPairing;
    if (!pending) throw new CoconoError('Call beginPairing() first.', 'no_pending_pairing');
    for (;;) {
      if (!this.#pendingPairing) {
        throw new CoconoError('Pairing cancelled.', 'pairing_cancelled');
      }
      if (Date.now() > pending.expiresAt) {
        this.#pendingPairing = null;
        throw new CoconoError('Pairing code expired — start again with beginPairing().', 'pairing_expired');
      }
      let status;
      try {
        status = await this.api.enrollStatus(pending.enrollId);
      } catch (err) {
        if (err.status === 410) {
          this.#pendingPairing = null;
          throw new CoconoError('Pairing code expired or unknown.', 'pairing_expired');
        }
        throw err;
      }
      if (status.approved) break;
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    const identity = await this.#persistIdentity(pending, true, pending.sealed);
    this.#pendingPairing = null;
    return { username: identity.username, deviceId: identity.deviceId, token: this.token };
  }

  /**
   * Pairing, NEW-device side: abandon a pending pairing request (the code
   * simply expires server-side).
   */
  cancelPairing() {
    this.#pendingPairing = null;
  }

  /**
   * Pairing, APPROVING-device side: inspect a code before approving (shows
   * the requesting device id). Requires a logged-in device.
   */
  async pendingPairing(code) {
    return this.api.pendingEnrollment(this.#requireToken(), code);
  }

  /** Pairing, APPROVING-device side: approve a 6-digit pairing code. */
  async approvePairing(code) {
    return this.api.approveDevice(this.#requireToken(), code);
  }

  /**
   * Open the messaging WebSocket. Incoming frames turn into events:
   * 'message', 'ack', 'delivered', 'state'. Safe to call repeatedly.
   */
  connect() {
    this.#requireToken();
    if (this.#transport) {
      this.#transport.kick();
      return this.#transport;
    }
    const transport = new Transport({
      getUrl: () => this.api.wsUrl(),
      getToken: () => this.token,
      logger: this.logger,
    });
    transport.on('frame', (frame) => this.#onFrame(frame));
    transport.on('state', (state) => this.emit('state', { state }));
    this.#transport = transport;
    transport.connect();
    return transport;
  }

  disconnect() {
    this.#transport?.close();
    this.#transport = null;
  }

  /**
   * Ask the server to re-deliver this device's already-pulled copies that are
   * still inside the retention window (see MSG_RETENTION_SEC). Useful after a
   * partial storage wipe on a device that kept its identity — the server
   * cannot re-encrypt for a NEW device (E2EE), only replay to the SAME one.
   * Safe to retry: client dedupes by mid. No-op if the socket is not open.
   */
  requestResync() {
    if (!this.#transport || this.#transport.state !== 'open') return false;
    this.#transport.send({ type: 'resync' });
    this.logger.info('resync requested');
    return true;
  }

  get connectionState() {
    return this.#transport?.state ?? 'closed';
  }

  /**
   * E2EE text message to a peer account. Mirrors the FE fan-out: one envelope
   * per recipient device, all sharing one localId. Acks arrive as 'ack'
   * events (one per envelope); 'delivered' fires when a recipient device
   * pulls its copy.
   * @returns {Promise<{localId: string, peer: string, cids: string[]}>}
   */
  async sendMessage(username, text) {
    const identity = await this.#requireIdentity();
    this.#requireToken();
    if (!this.#transport || this.#transport.state !== 'open') {
      throw new CoconoError('Websocket not open — call connect() and wait for the "open" state.', 'not_connected');
    }
    const peer = await this.peerKeys(username);
    const t = nowEpoch();
    const localId = crypto.randomUUID();
    const cids = [];
    for (const dev of peer.devices) {
      if (!dev.x) {
        this.logger.warn(`skipping device ${dev.d} of @${peer.u}: no X25519 key (pre-M3 device)`);
        continue;
      }
      const cid = crypto.randomUUID();
      this.#cidToLocal.set(cid, localId);
      const key = await this.#getConvKey(identity, peer.u.toLowerCase(), dev.d, dev.x);
      const d = await c.encryptForConversation(key, text);
      const m = { d, u: peer.u, dv: dev.d, f: identity.username, fd: identity.deviceId, cid, t };
      const h = await c.hmac(identity.aesMac, canonical(m));
      this.#transport.send({ type: 'msg', msg: { m: { ...m, h } } });
      cids.push(cid);
    }
    if (!cids.length) throw new CoconoError(`No encryptable devices for @${peer.u}`, 'no_peer_devices');
    return { localId, peer: peer.u, cids };
  }

  // --- internals ---

  async #getConvKey(identity, theirUl, theirDv, theirX) {
    const cacheKey = `${theirUl}:${theirDv}`;
    if (!this.#convKeyCache.has(cacheKey)) {
      const info = c.pairInfo(identity.username.toLowerCase(), identity.deviceId, theirUl, theirDv);
      this.#convKeyCache.set(cacheKey, await c.deriveConversationKey(identity.xPriv, theirX, info));
    }
    return this.#convKeyCache.get(cacheKey);
  }

  #onFrame(frame) {
    switch (frame?.type) {
      case 'msg':
        this.#onIncoming(frame).catch((err) => this.emit('error', { error: err }));
        break;
      case 'ack': {
        const localId = this.#cidToLocal.get(frame.cid);
        this.emit('ack', { cid: frame.cid, localId, ok: frame.ok, error: frame.error });
        if (localId !== undefined && !frame.ok) this.#cidToLocal.delete(frame.cid);
        break;
      }
      case 'delivered': {
        const localId = this.#cidToLocal.get(frame.cid);
        if (!localId) break;
        this.emit('delivered', { cid: frame.cid, localId, to: frame.to });
        break;
      }
      case 'hello':
        break;
      case 'error':
        this.emit('error', { error: new CoconoError(frame.error ?? 'server error', 'server_error') });
        break;
      default:
        this.logger.debug('unhandled frame type', frame?.type);
    }
  }

  async #onIncoming(frame) {
    const m = frame.env?.m;
    if (!m) return;
    const identity = await this.#requireIdentity();
    const myUl = identity.username.toLowerCase();
    const senderUl = (m.f ?? '').toLowerCase();

    // Echo of a message WE sent (self-chat): confirm so the server drops it.
    if (senderUl === myUl && m.fd === identity.deviceId) {
      this.#transport.send({ type: 'pulled', ids: [frame.id] });
      return;
    }

    const peerKeys = await this.peerKeys(senderUl).catch(() => null);
    if (!peerKeys) {
      this.logger.warn(`incoming msg from unknown peer @${m.f}; leaving queued`);
      return;
    }
    const senderDevice = peerKeys.devices.find((dev) => dev.d === m.fd);
    if (!senderDevice?.x) {
      this.logger.warn(`incoming msg from unknown/device-less sender ${m.fd}; leaving queued`);
      return;
    }

    let text;
    try {
      const key = await this.#getConvKey(identity, senderUl, m.fd, senderDevice.x);
      text = await c.decryptFromConversation(key, m.d);
    } catch (err) {
      // Wrong key / tampered ciphertext: do NOT confirm the pull.
      this.emit('error', { error: new CoconoError(`Failed to decrypt message ${frame.id}: ${err.message}`, 'decrypt_failed') });
      return;
    }

    // Confirm the pull: server marks its copy (kept for the retention
    // window) and notifies the sender.
    this.#transport.send({ type: 'pulled', ids: [frame.id] });
    this.emit('message', {
      mid: frame.id,
      peer: m.f,
      from: m.f,
      fromDeviceId: m.fd,
      text,
      ts: frame.ts,
      self: senderUl === myUl,
    });
  }
}
