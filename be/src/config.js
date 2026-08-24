const env = process.env;

const listOf = (value, fallback) =>
  value ? value.split(',').map((s) => s.trim()).filter(Boolean) : fallback;

const numOf = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  port: numOf(env.PORT, 3000),
  host: env.HOST ?? '127.0.0.1',

  mongoUrl: env.MONGO_URL ?? 'mongodb://127.0.0.1:27017/cocono-chat',
  redisUrl: env.REDIS_URL ?? 'redis://127.0.0.1:6379/0',

  adminPort: numOf(env.ADMIN_PORT, 3001),
  adminHost: env.ADMIN_HOST ?? '127.0.0.1',
  adminToken: env.ADMIN_TOKEN || '',

  jwtSecret: env.JWT_SECRET ?? 'dev-secret-change-me',
  jwtExpiresInSec: numOf(env.JWT_EXPIRES_IN_SEC, 24 * 60 * 60),
  nonceTtlSec: numOf(env.NONCE_TTL_SEC, 5 * 60),

  reservedUsernames: listOf(env.RESERVED_USERNAMES, [
    'server',
    'admin',
    'root',
    'system',
    'support',
  ]),
  maxDevicesDefault: numOf(env.MAX_DEVICES, 3),

  signupIpLimit: numOf(env.SIGNUP_IP_LIMIT, 10),
  signupIpWindowSec: numOf(env.SIGNUP_IP_WINDOW_SEC, 60 * 5),
  challengeIpLimit: numOf(env.CHALLENGE_IP_LIMIT, 30),
  challengeIpWindowSec: numOf(env.CHALLENGE_IP_WINDOW_SEC, 15 * 60),
  verifyAccountLimit: numOf(env.VERIFY_ACCOUNT_LIMIT, 20),
  verifyAccountWindowSec: numOf(env.VERIFY_ACCOUNT_WINDOW_SEC, 15 * 60),
};

if (config.jwtSecret === 'dev-secret-change-me') {
  console.warn('[config] JWT_SECRET is the dev default — set a real secret in production');
}
