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

export function newDeviceId() {
  return crypto.randomUUID();
}
