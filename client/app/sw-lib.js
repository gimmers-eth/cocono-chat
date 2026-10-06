// sw-lib.js — CLASSIC script (importScripts-able), no modules, no dynamic
// import(): WebKit forbids both inside service workers. Provides the small
// slice of functionality the push-upgrade path needs, mirroring the browser
// SDK's wire formats. If you change pairInfo / HKDF / envelope layouts in
// client/src/crypto.js or client/src/localseal.js, mirror them here — and
// remember: the SW only ever PEEKS (never pulls), so nothing is consumed.

self.SwLib = (function () {
  const CONV_INFO_PREFIX = 'cocono-conv-v1'; // must match crypto.js pairInfo
  const LOCAL_SEAL_PREFIX = 'cocono-local-seal-v1'; // must match localseal.js
  const LOCAL_SEAL_SALT = 'cocono-local-salt-v1';

  function b64uBytes(s) {
    const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesB64u(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  const utf8 = (s) => new TextEncoder().encode(s);

  function swLog(kind, msg) {
    try {
      const arr = JSON.parse(localStorage.getItem('cocono.swlog') || '[]');
      arr.push({ ts: new Date().toISOString(), kind, msg: String(msg).slice(0, 240) });
      while (arr.length > 25) arr.shift();
      localStorage.setItem('cocono.swlog', JSON.stringify(arr));
    } catch { /* storage best-effort */ }
  }
  const lastSwLog = () => localStorage.getItem('cocono.swlog') || '[]';

  // --- identity (mirrors storage.js + client.js silent resume) ---

  function idbGet(dbName, storeName, key) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(dbName);
      open.onerror = () => reject(open.error);
      open.onupgradeneeded = () => open.result.close(); // never create from here
      open.onsuccess = () => {
        const db = open.result;
        try {
          const req = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
          req.onsuccess = () => { resolve(req.result); db.close(); };
          req.onerror = () => { reject(req.error); db.close(); };
        } catch (err) { reject(err); db.close(); }
      };
    });
  }

  async function loadIdentity() {
    const ul = await idbGet('cocono-client-sdk', 'identity', 'current');
    if (!ul) return null;
    return (await idbGet('cocono-client-sdk', 'identity', `identity:${ul}`)) ?? null;
  }

  async function localUnsealV4(record) {
    const ikm = utf8(`${LOCAL_SEAL_PREFIX}|${record.username}|${record.deviceId}|${record.pubRaw}`);
    const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
    const wrapKey = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: utf8(LOCAL_SEAL_SALT), info: utf8('wrap') },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
    );
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64uBytes(record.wrapped.iv) },
      wrapKey, b64uBytes(record.wrapped.ct),
    );
    const { ed, x } = JSON.parse(new TextDecoder().decode(pt));
    const priv = await crypto.subtle.importKey('pkcs8', b64uBytes(ed), { name: 'Ed25519' }, false, ['sign']);
    const xPriv = await crypto.subtle.importKey('pkcs8', b64uBytes(x), { name: 'X25519' }, false, ['deriveBits']);
    return { priv, xPriv };
  }

  async function login(record) {
    let { priv, xPriv } = record;
    if (record.format === 4 && !priv) ({ priv, xPriv } = await localUnsealV4(record));
    if (!priv) throw new Error('identity has no usable key material');
    const post = async (path, body, token) => {
      const res = await fetch(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${path} -> ${res.status}`);
      return res.json();
    };
    const id = { u: record.username, d: record.deviceId };
    const { n } = await post('/api/auth/challenge', id);
    const sig = await crypto.subtle.sign({ name: 'Ed25519' }, priv, utf8(n));
    const { token } = await post('/api/auth/verify', { ...id, n, s: bytesB64u(new Uint8Array(sig)) });
    return { token, priv, xPriv };
  }
  // --- WS peek + decrypt (NEVER sends 'pulled' — the page still receives) ---

  function peek(token, record, xPriv, settleMs = 1500, hardMs = 5000) {
    const url = `${location.origin.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`;
    const peerKeyCache = new Map();
    const seen = [];
    const pick = () => {
      if (!seen.length) return null;
      seen.sort((a, b) => a.ts - b.ts);
      const latest = seen[seen.length - 1];
      return { peer: latest.peer, text: latest.text, extra: seen.length - 1 };
    };
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      let settleTimer = null;
      const hardTimer = setTimeout(() => { finish(resolve, pick()); }, hardMs);
      function finish(fn, value) {
        clearTimeout(hardTimer);
        if (settleTimer) clearTimeout(settleTimer);
        try { ws.close(); } catch { /* already closed */ }
        fn(value);
      }
      ws.onopen = () => { settleTimer = setTimeout(() => finish(resolve, pick()), settleMs); };
      ws.onerror = () => finish(reject, new Error('ws could not connect'));
      ws.onmessage = async (ev) => {
        let f; try { f = JSON.parse(ev.data); } catch { return; }
        if (f.type !== 'msg' || !f.env?.m) return;
        const m = f.env.m;
        if (m.u && m.u.toLowerCase() !== record.username.toLowerCase()) return; // not ours
        try {
          let peerX = peerKeyCache.get(m.f);
          if (!peerX) {
            const res = await fetch(`/api/users/${encodeURIComponent(m.f)}/keys`, {
              headers: { authorization: `Bearer ${token}` },
            });
            if (!res.ok) return;
            const keys = await res.json();
            const dev = (keys.devices || []).find((d) => d.d === m.fd);
            if (!dev?.x) return;
            peerKeyCache.set(m.f, (peerX = dev.x));
          }
          const parts = [
            `${record.username.toLowerCase()}:${record.deviceId}`,
            `${m.f.toLowerCase()}:${m.fd}`,
          ].sort();
          const info = `${CONV_INFO_PREFIX}|${parts[0]}|${parts[1]}`;
          const pub = await crypto.subtle.importKey('raw', b64uBytes(peerX), { name: 'X25519' }, false, []);
          const shared = await crypto.subtle.deriveBits({ name: 'X25519', public: pub }, xPriv, 256);
          const hk = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
          const convKey = await crypto.subtle.deriveKey(
            { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(info) },
            hk, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
          );
          const buf = b64uBytes(m.d);
          const text = new TextDecoder().decode(await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: buf.subarray(0, 12) }, convKey, buf.subarray(12),
          ));
          seen.push({ peer: m.f, text, ts: f.ts || Date.now() });
        } catch { /* one undecryptable frame must not kill the peek */ }
      };
    });
  }

  return { loadIdentity, login, peek, swLog, lastSwLog, b64uBytes, bytesB64u };
})();
