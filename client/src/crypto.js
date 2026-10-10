// All WebCrypto used by the SDK. Requires a secure context (https/localhost)
// in browsers; Node >= 22.9 exposes crypto.subtle with Ed25519 + X25519.
// Private keys are non-extractable at runtime. They are persisted either as
// CryptoKey handles (fine on most engines, unreliable on iOS WebKit) or, on
// iOS, as PKCS8 bytes sealed under a device-derived key (localseal.js); the
// raw bytes only ever exist transiently between generate/export/wrap and
// unwrap/import, always in memory.

import { b64uEncode, b64uDecode, utf8 } from './encoding.js';

export async function generateIdentityKeyPair(extractable = false) {
  return crypto.subtle.generateKey({ name: 'Ed25519' }, extractable, ['sign', 'verify']);
}

export async function exportRawPublicKey(key) {
  const raw = await crypto.subtle.exportKey('raw', key);
  return b64uEncode(new Uint8Array(raw));
}

export async function generateX25519KeyPair(extractable = false) {
  return crypto.subtle.generateKey({ name: 'X25519' }, extractable, ['deriveBits']);
}

export async function exportRawX25519(key) {
  const raw = await crypto.subtle.exportKey('raw', key);
  return b64uEncode(new Uint8Array(raw));
}

// --- PKCS8 export/import for key sealing (see localseal.js) ---

export async function exportPkcs8b64u(privateKey) {
  return b64uEncode(new Uint8Array(await crypto.subtle.exportKey('pkcs8', privateKey)));
}

export async function importEd25519PrivatePkcs8(pkcs8B64u) {
  return crypto.subtle.importKey('pkcs8', b64uDecode(pkcs8B64u), { name: 'Ed25519' }, false, ['sign']);
}

export async function importX25519PrivatePkcs8(pkcs8B64u) {
  return crypto.subtle.importKey('pkcs8', b64uDecode(pkcs8B64u), { name: 'X25519' }, false, ['deriveBits']);
}

export async function generateAesKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function exportRawAesKey(aesKey) {
  const raw = await crypto.subtle.exportKey('raw', aesKey);
  return b64uEncode(new Uint8Array(raw));
}

// The transport key is used two ways (matching the server): AES-GCM for
// session encryption and HMAC-SHA256 for envelope integrity (`h`).
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

// --- byte-level AES-GCM: the ONE encrypt/decrypt path ---
// Message ciphertexts and media blobs are the same wire shape —
// iv(12) ‖ ciphertext ‖ tag(16) — so both go through these two functions and
// differ only in what goes in (utf8 text vs raw bytes) and which key is used
// (a derived conversation key vs a per-file random key). Keeping one path is
// the point: a drift here would silently break every stored blob.
export async function encryptBytes(key, data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), iv.length);
  return out;
}

export async function decryptBytes(key, buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const iv = bytes.slice(0, 12);
  const ct = bytes.slice(12); // WebCrypto expects ciphertext‖tag
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
}

// A media file's OWN key: random, EXPORTABLE (it must travel to the
// recipients inside their encrypted envelopes — that is what lets the server
// hold ciphertext it cannot read), AES-GCM-256.
export async function generateFileKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function importFileKey(rawB64u) {
  return crypto.subtle.importKey('raw', b64uDecode(rawB64u), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// Integrity of a DOWNLOAD: the sender hashes the CIPHERTEXT it uploaded and
// ships that hash inside the encrypted payload, so a recipient can prove the
// bytes it got are the bytes that were sent — even though it cannot read them.
export async function sha256B64u(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return b64uEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

// --- E2EE conversation keys (DESIGN.md milestone 3) ---

// Deterministic per-device-pair conversation key; BOTH sides derive the
// identical key. info MUST stay byte-compatible with the server mirror.
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

// Wire format: b64u(iv(12) || ciphertext || tag(16)) — see encryptBytes above.
export async function encryptForConversation(convKey, plaintext) {
  return b64uEncode(await encryptBytes(convKey, utf8(plaintext)));
}

export async function decryptFromConversation(convKey, dB64u) {
  return new TextDecoder().decode(await decryptBytes(convKey, b64uDecode(dB64u)));
}
