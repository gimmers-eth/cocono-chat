import { createPublicKey, verify } from 'node:crypto';
import { b64uDecode } from './b64u.js';

export const RAW_PUBLIC_KEY_BYTES = 32;
export const SIGNATURE_BYTES = 64;

// Clients send the raw 32-byte Ed25519 public key, base64url-encoded
// (WebCrypto `exportKey('raw', ...)`). Node has no raw import, so go via JWK.
export function importRawPublicKey(b64u) {
  const raw = b64uDecode(b64u);
  if (!raw || raw.length !== RAW_PUBLIC_KEY_BYTES) return null;
  try {
    return createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: b64u },
      format: 'jwk',
    });
  } catch {
    return null;
  }
}

export function verifySignature(publicKey, dataBytes, signatureB64u) {
  const sig = b64uDecode(signatureB64u);
  if (!sig || sig.length !== SIGNATURE_BYTES) return false;
  try {
    return verify(null, dataBytes, publicKey, sig);
  } catch {
    return false;
  }
}

// --- X25519 (key agreement, milestone 3) ---
// The server only validates these at signup/enroll; conversation keys are
// derived by the clients (ECDH + HKDF), never by the server.

export const RAW_X25519_KEY_BYTES = 32;

export function importRawX25519PublicKey(b64u) {
  const raw = b64uDecode(b64u);
  if (!raw || raw.length !== RAW_X25519_KEY_BYTES) return null;
  try {
    return createPublicKey({
      key: { kty: 'OKP', crv: 'X25519', x: b64u },
      format: 'jwk',
    });
  } catch {
    return null;
  }
}
