// Envelope validation: structure, freshness, HMAC (keyed with the sender's
// transport AES key), and the optional Ed25519 signature.
// Returns an error code, or null when the envelope is valid.
import { createHmac } from 'node:crypto';
import { canonical } from '../../lib/canon.js';
import { b64uDecode } from '../../lib/b64u.js';
import { importRawPublicKey, verifySignature } from '../../lib/ed25519.js';
import { isValidUsername, isValidDeviceId } from '../../lib/username.js';

const CID_RE = /^[a-zA-Z0-9_-]{8,64}$/;

export function verifyEnvelope(env, senderDevice, config) {
  const m = env?.m;
  if (typeof env !== 'object' || !m || typeof m !== 'object') return 'invalid_envelope';
  const { d, u, dv, f, fd, cid, t, h } = m;
  if (
    typeof d !== 'string' ||
    !isValidUsername(u) ||
    !isValidDeviceId(dv) ||
    !isValidUsername(f) ||
    !isValidDeviceId(fd) ||
    typeof cid !== 'string' ||
    !CID_RE.test(cid)
  ) {
    return 'invalid_envelope';
  }
  if (
    typeof t !== 'number' ||
    Math.abs(Math.floor(Date.now() / 1000) - t) > config.signedPayloadMaxAgeSec
  ) {
    return 'stale_payload';
  }
  if (typeof h !== 'string') return 'invalid_envelope';

  const { h: _omit, ...rest } = m;
  const keyBytes = b64uDecode(senderDevice.aes);
  if (!keyBytes) return 'invalid_envelope';
  const mac = createHmac('sha256', keyBytes).update(canonical(rest)).digest('base64url');
  if (mac !== h) return 'bad_hmac';

  if (env.s !== undefined) {
    const pubKey = importRawPublicKey(senderDevice.pub);
    if (!pubKey || !verifySignature(pubKey, Buffer.from(canonical(m), 'utf8'), env.s)) {
      return 'bad_signature';
    }
  }
  return null;
}
