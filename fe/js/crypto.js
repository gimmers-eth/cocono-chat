// WebCrypto helpers. The Ed25519 private key is non-exportable and never
// leaves this device; it is persisted in IndexedDB as a CryptoKey handle.

import { b64uDecode, b64uEncode, utf8 } from './util.js';

export async function generateIdentityKeyPair() {
  return crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
}

export async function exportRawPublicKey(keyPair) {
  const raw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  return b64uEncode(new Uint8Array(raw));
}

export async function generateAesKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
}

export async function exportRawAesKey(aesKey) {
  const raw = await crypto.subtle.exportKey('raw', aesKey);
  return b64uEncode(new Uint8Array(raw));
}

// Once the server has the AES key it is re-imported as non-exportable
// (per DESIGN.md). The same bytes are imported twice: AES-GCM for transport
// encryption, HMAC for message integrity (the envelope `h` field).
export async function importAesKeys(rawB64u) {
  const raw = b64uDecode(rawB64u);
  const aesEnc = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
  const aesMac = await crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  return { aesEnc, aesMac };
}

export async function sign(privateKey, data) {
  const bytes = typeof data === 'string' ? utf8(data) : data;
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, bytes);
  return b64uEncode(new Uint8Array(sig));
}

export async function hmac(aesMacKey, data) {
  const bytes = typeof data === 'string' ? utf8(data) : data;
  const sig = await crypto.subtle.sign({ name: 'HMAC' }, aesMacKey, bytes);
  return b64uEncode(new Uint8Array(sig));
}

export function newDeviceId() {
  return crypto.randomUUID();
}

// --- X25519 key agreement + E2EE (milestone 3) ---

export async function generateX25519KeyPair() {
  return crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
}

export async function exportRawX25519(keyPair) {
  const raw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  return b64uEncode(new Uint8Array(raw));
}

// Deterministic per-device-pair conversation key — both sides derive the
// identical key via ECDH + HKDF, so no key distribution is needed.
// info MUST match the server-side test mirror:
//   'cocono-conv-v1|' + sorted ['ul:deviceId', 'ul:deviceId'].join('|')
export function pairInfo(aUl, aDv, bUl, bDv) {
  const parts = [`${aUl}:${aDv}`, `${bUl}:${bDv}`].sort();
  return `cocono-conv-v1|${parts[0]}|${parts[1]}`;
}

export async function deriveConversationKey(myXPriv, peerXPubB64u, info) {
  const peerPub = await crypto.subtle.importKey(
    'raw',
    b64uDecode(peerXPubB64u),
    { name: 'X25519' },
    false,
    [],
  );
  const shared = await crypto.subtle.deriveBits({ name: 'X25519', public: peerPub }, myXPriv, 256);
  const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(info) },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// Wire format: b64u(iv(12) || ciphertext || tag(16)) — WebCrypto appends the
// GCM tag to the ciphertext; the BE test mirror parses it the same way.
export async function encryptForConversation(convKey, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, convKey, utf8(plaintext));
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), iv.length);
  return b64uEncode(out);
}

export async function decryptFromConversation(convKey, dB64u) {
  const buf = b64uDecode(dB64u);
  const iv = buf.slice(0, 12);
  const ct = buf.slice(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, convKey, ct);
  return new TextDecoder().decode(pt);
}
