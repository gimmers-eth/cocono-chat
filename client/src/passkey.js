// Passkey-backed identity sealing (the iOS fix).
//
// WebKit browsers cannot reliably persist non-extractable CryptoKey HANDLES in
// IndexedDB — records survive, handles come back unreadable, logins die on
// reload. Passkeys invert that: the wrapping secret lives in the platform
// authenticator (Secure Enclave / TPM, syncable via iCloud/Google), and the
// identity keys are stored as plain AES-GCM-wrapped BYTES, which every browser
// persists correctly.
//
// Flow:
//   seal:  create resident passkey (PRF extension) -> derive AES-GCM wrap key
//          from the PRF outputs -> encrypt {ed25519 pkcs8, x25519 pkcs8,
//          transport aes raw} -> {credId, prfEval, wrapped} goes to storage.
//   unseal: navigator.credentials.get() with the stored PRF eval -> same
//          outputs -> wrap key -> decrypt -> import as NON-extractable
//          handles for the session. Requires a user gesture + biometric/PIN.
//
// The passkey is origin-bound: a different hostname = different credential =
// different wrap key. Losing the passkey (OS passkey deletion) loses the
// sealed identity — server-side backup/recovery is the planned counterweight.

import { b64uEncode, b64uDecode, utf8 } from './encoding.js';
import * as c from './crypto.js';

const WRAP_INFO = 'cocono-prf-wrap-v1';

export function passkeyAvailable() {
  return typeof globalThis.PublicKeyCredential !== 'undefined'
    && typeof navigator !== 'undefined'
    && !!navigator.credentials?.create;
}

function prfOutputs(response) {
  // Shipped API is response.extensions?.prf; a couple of engines exposed a
  // getter instead. Accept either, require both outputs.
  const prf = response?.extensions?.prf ?? response?.getExtensions?.()?.prf;
  if (!prf?.first || !prf?.second) return null;
  return { first: new Uint8Array(prf.first), second: new Uint8Array(prf.second) };
}

// Registration-time ceremony — MUST run inside a user gesture (the sign-up /
// pair button click). Throws if WebAuthn or the PRF extension is unavailable.
export async function createPasskey(username) {
  const firstOut = crypto.getRandomValues(new Uint8Array(32));
  const secondOut = crypto.getRandomValues(new Uint8Array(32));
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: 'co.co.no', id: location.hostname },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: username,
        displayName: username,
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -8 },   // EdDSA
        { type: 'public-key', alg: -7 },   // ES256
        { type: 'public-key', alg: -257 }, // RS256
      ],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      attestation: 'none',
      // Evaluate the PRF at creation too: proves the authenticator actually
      // returns outputs before we ever trust it with the identity.
      extensions: { prf: { eval: { firstOut, secondOut } } },
    },
  });
  const secrets = prfOutputs(cred?.response);
  if (!cred || !secrets) throw new Error('passkey-prf-unavailable');
  return {
    credId: b64uEncode(new Uint8Array(cred.rawId)),
    prfEval: { firstOut: b64uEncode(firstOut), secondOut: b64uEncode(secondOut) },
    secrets,
  };
}

// Unlock ceremony — MUST run inside a user gesture (the Unlock button tap).
export async function evaluatePasskey(credId, prfEval) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: location.hostname,
      allowCredentials: [{ type: 'public-key', id: b64uDecode(credId) }],
      userVerification: 'required',
      extensions: { prf: {
        eval: {
          firstOut: b64uDecode(prfEval.firstOut),
          secondOut: b64uDecode(prfEval.secondOut),
        },
      } },
    },
  });
  const secrets = prfOutputs(assertion?.response);
  if (!assertion || !secrets) throw new Error('passkey-prf-unavailable');
  return secrets;
}

export async function deriveWrapKey(secrets) {
  const input = new Uint8Array(64);
  input.set(secrets.first, 0);
  input.set(secrets.second, 32);
  const base = await crypto.subtle.importKey('raw', input, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(WRAP_INFO) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// Take the device's freshly generated (transiently extractable) key material,
// encrypt it under the passkey-derived wrap key, and hand back the storable
// bundle + NON-extractable runtime handles re-imported from the same bytes.
export async function sealDevice(username, device) {
  const pk = await createPasskey(username);
  const wrapKey = await deriveWrapKey(pk.secrets);
  const ed = await c.exportPkcs8b64u(device.keyPair.privateKey);
  const x = await c.exportPkcs8b64u(device.xPair.privateKey);
  const wrapped = await wrapBytes(wrapKey, utf8(JSON.stringify({ ed, x, aes: device.aesRaw })));
  const runtime = await importRuntime({ ed, x, aes: device.aesRaw });
  return { bundle: { credId: pk.credId, prfEval: pk.prfEval, wrapped }, runtime };
}

export async function unsealDevice(bundle) {
  const secrets = await evaluatePasskey(bundle.credId, bundle.prfEval);
  const wrapKey = await deriveWrapKey(secrets);
  const json = await unwrapBytes(wrapKey, bundle.wrapped);
  return importRuntime(JSON.parse(new TextDecoder().decode(json)));
}

async function wrapBytes(wrapKey, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapKey, bytes);
  return { iv: b64uEncode(iv), ct: b64uEncode(new Uint8Array(ct)) };
}

async function unwrapBytes(wrapKey, blob) {
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64uDecode(blob.iv) },
    wrapKey,
    b64uDecode(blob.ct),
  ));
}

async function importRuntime({ ed, x, aes }) {
  const priv = await c.importEd25519PrivatePkcs8(ed);
  const xPriv = await c.importX25519PrivatePkcs8(x);
  const { aesEnc, aesMac } = await c.importAesKeys(aes);
  return { priv, xPriv, aesEnc, aesMac };
}
