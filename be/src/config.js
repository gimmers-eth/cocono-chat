const env = process.env;

const DEFAULT_TIME_WINDOW = 900 // 15 * 60 = 15 mins

const listOf = (value, fallback) =>
  value ? value.split(',').map((s) => s.trim()).filter(Boolean) : fallback;

const numOf = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

// TRUST_PROXY: 'true' | hop count | comma-separated trusted addresses | unset.
// Needed behind nginx so request.ip is the real client IP for rate limiting.
const parseTrustProxy = (value) => {
  if (!value) return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value.split(',').map((s) => s.trim()).filter(Boolean);
};

export const config = {
  port: numOf(env.PORT, 3000),
  host: env.HOST ?? '127.0.0.1',
  trustProxy: parseTrustProxy(env.TRUST_PROXY),

  mongoUrl: env.MONGO_URL ?? 'mongodb://127.0.0.1:27017/cocono-chat',
  redisUrl: env.REDIS_URL ?? 'redis://127.0.0.1:6379/0',

  adminPort: numOf(env.ADMIN_PORT, 3001),
  adminHost: env.ADMIN_HOST ?? '127.0.0.1',
  adminToken: env.ADMIN_TOKEN || '',

  jwtSecret: env.JWT_SECRET ?? 'dev-secret-change-me',
  jwtExpiresInSec: numOf(env.JWT_EXPIRES_IN_SEC, 24 * 60 * 60),
  nonceTtlSec: numOf(env.NONCE_TTL_SEC, 5 * 60),
  // Explicit opt-out for local dev; `pnpm start` refuses the dev default otherwise.
  allowDevJwtSecret: env.ALLOW_DEV_JWT_SECRET === 'true',
  // Max age of the client timestamp `t` in signed signup/enroll payloads (M6 fix).
  signedPayloadMaxAgeSec: numOf(env.SIGNED_PAYLOAD_MAX_AGE_SEC, 5 * 60),

  reservedUsernames: listOf(env.RESERVED_USERNAMES, [
    'server',
    'admin',
    'root',
    'system',
    'support',
  ]),
  maxDevicesDefault: numOf(env.MAX_DEVICES, 3),

  signupIpLimit: numOf(env.SIGNUP_IP_LIMIT, 10),
  signupIpWindowSec: numOf(env.SIGNUP_IP_WINDOW_SEC, DEFAULT_TIME_WINDOW),
  challengeIpLimit: numOf(env.CHALLENGE_IP_LIMIT, 30),
  challengeIpWindowSec: numOf(env.CHALLENGE_IP_WINDOW_SEC, DEFAULT_TIME_WINDOW),
  verifyAccountLimit: numOf(env.VERIFY_ACCOUNT_LIMIT, 20),
  verifyAccountWindowSec: numOf(env.VERIFY_ACCOUNT_WINDOW_SEC, DEFAULT_TIME_WINDOW),
  verifyIpLimit: numOf(env.VERIFY_IP_LIMIT, 20),
  verifyIpWindowSec: numOf(env.VERIFY_IP_WINDOW_SEC, DEFAULT_TIME_WINDOW),
  deviceCodeTtlSec: numOf(env.DEVICE_CODE_TTL_SEC, 10 * 60),
  deviceEnrollIpLimit: numOf(env.DEVICE_ENROLL_IP_LIMIT, 10),
  deviceEnrollIpWindowSec: numOf(env.DEVICE_ENROLL_IP_WINDOW_SEC, DEFAULT_TIME_WINDOW),
  deviceApproveAccountLimit: numOf(env.DEVICE_APPROVE_ACCOUNT_LIMIT, 20),
  deviceApproveAccountWindowSec: numOf(env.DEVICE_APPROVE_ACCOUNT_WINDOW_SEC, DEFAULT_TIME_WINDOW),
  enrollStatusIpLimit: numOf(env.ENROLL_STATUS_IP_LIMIT, 600),
  enrollStatusIpWindowSec: numOf(env.ENROLL_STATUS_IP_WINDOW_SEC, DEFAULT_TIME_WINDOW),
};

config.jwtSecretInsecure = config.jwtSecret === 'dev-secret-change-me' || config.jwtSecret.length < 32;

if (config.jwtSecretInsecure) {
  console.warn('[config] JWT_SECRET is the dev default or too short — generate one with: openssl rand -base64 48');
}
