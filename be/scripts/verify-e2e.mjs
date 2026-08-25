// End-to-end check of the milestone-1 account flow against the live dev server.
// Mimics the browser: generate Ed25519 + AES, sign signup, challenge/verify, hit /api/me.
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const BASE = 'http://127.0.0.1:3000';
const b64u = (b) => Buffer.from(b).toString('base64url');

function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const spki = publicKey.export({ format: 'der', type: 'spki' });
const p = b64u(spki.subarray(spki.length - 32));
const a = b64u(randomBytes(32));
const d = crypto.randomUUID();
const u = 'verifier_' + Date.now().toString(36);

async function post(path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

let fail = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const t = Math.floor(Date.now() / 1000);
const sSignup = b64u(sign(null, Buffer.from(canonical({ a, d, p, t, u }), 'utf8'), privateKey));
const su = await post('/api/signup', { u, p, a, d, t, s: sSignup });
check('signup returns 201', su.status === 201, `status=${su.status}`);

const home = await fetch(BASE + '/');
check('security headers present (M4)', (home.headers.get('content-security-policy') ?? '').includes("default-src 'self'"));

const ch = await post('/api/auth/challenge', { u, d });
check('challenge returns 200 + nonce', ch.status === 200 && !!ch.json.n, `status=${ch.status}`);

const sNonce = b64u(sign(null, Buffer.from(ch.json.n, 'utf8'), privateKey));
const ve = await post('/api/auth/verify', { u, d, n: ch.json.n, s: sNonce });
check('verify returns 200 + token', ve.status === 200 && !!ve.json.token, `status=${ve.status}`);

const me = await fetch(BASE + '/api/me', { headers: { authorization: `Bearer ${ve.json.token}` } });
const meJson = await me.json();
check('/api/me echoes username', me.status === 200 && meJson.u === u, `u=${meJson.u}`);

const replay = await post('/api/auth/verify', { u, d, n: ch.json.n, s: sNonce });
check('nonce replay rejected (401)', replay.status === 401, `status=${replay.status}`);

const noAuth = await fetch(BASE + '/api/me');
check('/api/me without token rejected (401)', noAuth.status === 401, `status=${noAuth.status}`);

console.log(fail === 0 ? '\nALL CHECKS PASSED' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
