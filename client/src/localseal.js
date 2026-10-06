// Local-wrap seal (identity format 4) — for WebKit browsers (iOS) that
// cannot persist CryptoKey HANDLES (format 2 breaks on reload). The earlier
// format-3 passkey-PRF scheme was retired: devices lacking PRF littered the
// OS vault with dead credentials, and where the OS already authenticates the
// user the marginal protection over this scheme is small.
//
// The identity bytes are AES-GCM encrypted under a key derived via HKDF from
// the record's PUBLIC identifiers. Be clear about what that is: domain
// separation, not secrecy — anyone who can read the record can recompute the
// wrap key. What it buys: no plaintext key material at rest (synced backups,
// DB scrapers, casual inspection see opaque bytes), while the real protection
// is the iOS per-app data encryption behind the device passcode. The crucial
// property: everything stored is PLAIN BYTES, which iOS persists correctly —
// unlike CryptoKey handles, which it corrupts on reload.


import { b64uEncode, b64uDecode, utf8 } from './encoding.js';
import * as c from './crypto.js';

export async function localSeal(username, device) {
  const wrapKey = await deriveLocalKey(username, device.deviceId, device.pubRaw);
  const ed = await c.exportPkcs8b64u(device.keyPair.privateKey);
  const x = await c.exportPkcs8b64u(device.xPair.privateKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    wrapKey,
    utf8(JSON.stringify({ ed, x, aes: device.aesRaw })),
  );
  return {
    bundle: {
      format: 4,
      wrapped: { iv: b64uEncode(iv), ct: b64uEncode(new Uint8Array(ct)) },
    },
    runtime: await importRuntime({ ed, x, aes: device.aesRaw }),
  };
}

export async function localUnseal(record) {
  const wrapKey = await deriveLocalKey(record.username, record.deviceId, record.pubRaw);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64uDecode(record.wrapped.iv) },
    wrapKey,
    b64uDecode(record.wrapped.ct),
  );
  return importRuntime(JSON.parse(new TextDecoder().decode(pt)));
}

async function deriveLocalKey(username, deviceId, pubRaw) {
  const ikm = utf8(`cocono-local-seal-v1|${username}|${deviceId}|${pubRaw}`);
  const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8('cocono-local-salt-v1'), info: utf8('wrap') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function importRuntime({ ed, x, aes }) {
  const priv = await c.importEd25519PrivatePkcs8(ed);
  const xPriv = await c.importX25519PrivatePkcs8(x);
  const { aesEnc, aesMac } = await c.importAesKeys(aes);
  return { priv, xPriv, aesEnc, aesMac };
}
