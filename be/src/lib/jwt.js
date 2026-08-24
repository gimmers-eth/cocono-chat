import { createHmac, timingSafeEqual } from 'node:crypto';
import { b64uDecode, b64uEncode } from './b64u.js';

// Minimal HS256 JWT — keeps dependencies at zero for something this small.

const header = b64uEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

function mac(signingInput, secret) {
  return createHmac('sha256', secret).update(signingInput).digest();
}

export function signJwt(payload, secret, expiresInSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const body = b64uEncode(JSON.stringify({ ...payload, iat: now, exp: now + expiresInSeconds }));
  const signingInput = `${header}.${body}`;
  return `${signingInput}.${b64uEncode(mac(signingInput, secret))}`;
}

// Returns the payload when the token is authentic and unexpired, else null.
export function verifyJwt(token, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [h, body, sig] = parts;
  if (h !== header) return null;

  const expected = mac(`${h}.${body}`, secret);
  const actual = b64uDecode(sig);
  if (!actual || actual.length !== expected.length) return null;
  if (!timingSafeEqual(actual, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(b64uDecode(body).toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return payload;
}
