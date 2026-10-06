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
//
// Every ceremony step is recorded in a trace buffer; the app's "Send
// diagnostics" uploads it, so unsupported PRF failures are explainable
// remotely (which accessor returned what, PRF errors per output, etc.).

import { b64uEncode, b64uDecode, utf8 } from './encoding.js';
import * as c from './crypto.js';

const WRAP_INFO = 'cocono-prf-wrap-v1';

// --- trace buffer ----------------------------------------------------------

const trace = [];
const TRACE_CAP = 60;

function traceIt(stage, info) {
  trace.push(`${new Date().toISOString().slice(11, 23)} ${stage}: ${
    typeof info === 'string' ? info : JSON.stringify(info)
  }`.slice(0, 300));
  if (trace.length > TRACE_CAP) trace.shift();
}

export function passkeyTrace() {
  return trace.join('\n') || '(empty — no passkey ceremony this session)';
}

function describeExtensions(response, label) {
  const exts = response?.extensions ?? response?.getClientExtensionResults?.() ?? null;
  const keys = exts ? Object.keys(exts) : [];
  if (!keys.length) {
    // Distinguish "browser ignored the extension" from "we read the wrong
    // place": log whether the engine exposes any extension surface at all.
    const proto = response ? (Object.getPrototypeOf(response) ?? {}) : {};
    const members = Object.getOwnPropertyNames(proto).slice(0, 24).join(',');
    traceIt(label, `no extension results (accessor=${exts ? 'returned {}' : 'missing'}; ` +
      `response members=[${members}])`);
    return null;
  }
  const prf = exts.prf;
  if (!prf) {
    traceIt(label, `extensions present but no prf: [${keys.join(',')}]`);
    return null;
  }
  const outs = Object.keys(prf).filter((k) => prf[k] instanceof ArrayBuffer || prf[k] instanceof Uint8Array);
  const errs = prf.errors ? Object.entries(prf.errors).map(([k, v]) => `${k}=${v}`).join(',') : '';
  traceIt(label, `prf outputs=[${outs.join(',')}]${errs ? ` errors{${errs}}` : ''}`);
  if (!prf.first || !prf.second) return null;
  return { first: new Uint8Array(prf.first), second: new Uint8Array(prf.second) };
}

export function passkeyAvailable() {
  return typeof globalThis.PublicKeyCredential !== 'undefined'
    && typeof navigator !== 'undefined'
    && !!navigator.credentials?.create;
}

/** What this browser can actually do — surfaced in Storage diagnostics. */
export async function passkeyStatus() {
  if (!passkeyAvailable()) return 'webauthn-unavailable';
  try {
    const platform = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    return `platform-authenticator=${platform}`;
  } catch (err) {
    return `probe failed: ${err?.name}: ${err?.message}`;
  }
}

// Registration-time ceremony — MUST run inside a user gesture (the sign-up /
// pair button click). Throws with a precise reason if PRF is unavailable.
export async function createPasskey(username) {
  traceIt('create:start', `rp=${location.hostname} user=${username}`);
  const firstInput = crypto.getRandomValues(new Uint8Array(32));
  const secondInput = crypto.getRandomValues(new Uint8Array(32));
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
      // PRF eval INPUTS are `first`/`second` (WebAuthn L3 IDL). Engines that
      // do not return create-time outputs fall through to the get() below.
      extensions: { prf: { eval: { first: firstInput, second: secondInput } } },
    },
  });
  if (!cred) throw new Error('passkey ceremony cancelled');
  traceIt('create:ok', `credId=${b64uEncode(new Uint8Array(cred.rawId)).slice(0, 12)}… aaguid=${cred.response?.getAuthenticatorData?.().slice(37, 53) ? 'yes' : 'n/a'}`);
  let secrets = describeExtensions(cred.response, 'create:ext');
  if (!secrets) {
    // Documented path: evaluate the PRF via an assertion right after creation
    // (same user activation). Also proves the authenticator can produce PRF
    // outputs before we trust it with the identity.
    traceIt('verify-get:start', 'create returned no usable PRF outputs — evaluating via assertion');
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId: location.hostname,
        allowCredentials: [{ type: 'public-key', id: new Uint8Array(cred.rawId) }],
        userVerification: 'required',
        extensions: { prf: { eval: { first: firstInput, second: secondInput } } },
      },
    });
    if (!assertion) throw new Error('passkey verification cancelled');
    secrets = describeExtensions(assertion.response, 'verify-get:ext');
  }
  if (!secrets) {
    throw new Error(
      'this browser/authenticator created a passkey but returned no PRF outputs — '
      + 'see the passkey trace in diagnostics for details',
    );
  }
  traceIt('seal:prf-ok', 'both PRF outputs available');
  return {
    credId: b64uEncode(new Uint8Array(cred.rawId)),
    prfEval: { first: b64uEncode(firstInput), second: b64uEncode(secondInput) },
    secrets,
  };
}

// Unlock ceremony — MUST run inside a user gesture (the Unlock button tap).
export async function evaluatePasskey(credId, prfEval) {
  traceIt('unlock:start', `credId=${String(credId).slice(0, 12)}…`);
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: location.hostname,
      allowCredentials: [{ type: 'public-key', id: b64uDecode(credId) }],
      userVerification: 'required',
      extensions: { prf: {
        eval: {
          first: b64uDecode(prfEval.first),
          second: b64uDecode(prfEval.second),
        },
      } },
    },
  });
  if (!assertion) throw new Error('passkey unlock cancelled');
  const secrets = describeExtensions(assertion.response, 'unlock:ext');
  if (!secrets) throw new Error('passkey unlock returned no PRF outputs');
  traceIt('unlock:prf-ok', 'identity unsealed');
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
