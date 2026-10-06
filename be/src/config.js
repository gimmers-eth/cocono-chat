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
  // Display name of the app (sign-in screen, chat header, PWA, admin).
  // Overridable at runtime in the admin panel (settings collection).
  appName: env.APP_NAME ?? 'co.co.no',

  port: numOf(env.PORT, 3000),
  // Default to all interfaces so LAN/mobile access works out of the box.
  // The app is passwordless and network-open by default — set a real
  // JWT_SECRET and consider restricting with HOST=127.0.0.1 on shared nets.
  host: env.HOST ?? '0.0.0.0',
  trustProxy: parseTrustProxy(env.TRUST_PROXY),

  mongoUrl: env.MONGO_URL ?? 'mongodb://127.0.0.1:27017/cocono-chat',

  // Web Push (Phase 1, blind notifications). Generate keys once:
  //   node -e "console.log(require('web-push').generateVAPIDKeys())"
  vapidPublicKey: env.VAPID_PUBLIC_KEY ?? '',
  vapidPrivateKey: env.VAPID_PRIVATE_KEY ?? '',
  vapidSubject: env.VAPID_SUBJECT ?? 'mailto:unknown',
  redisUrl: env.REDIS_URL ?? 'redis://127.0.0.1:6379/0',

  // Native TLS: when BOTH paths are set the server speaks https/wss directly
  // (no reverse proxy). Browsers require a secure context for WebCrypto/PWA,
  // so LAN access over anything but localhost needs these.
  tlsKeyPath: env.TLS_KEY_PATH || '',
  tlsCertPath: env.TLS_CERT_PATH || '',

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
  verifyIpLimit: numOf(env.VERIFY_IP_LIMIT, 50),
  verifyIpWindowSec: numOf(env.VERIFY_IP_WINDOW_SEC, DEFAULT_TIME_WINDOW),
  deviceCodeTtlSec: numOf(env.DEVICE_CODE_TTL_SEC, 10 * 60),
  deviceEnrollIpLimit: numOf(env.DEVICE_ENROLL_IP_LIMIT, 10),
  deviceEnrollIpWindowSec: numOf(env.DEVICE_ENROLL_IP_WINDOW_SEC, DEFAULT_TIME_WINDOW),
  deviceApproveAccountLimit: numOf(env.DEVICE_APPROVE_ACCOUNT_LIMIT, 20),
  deviceApproveAccountWindowSec: numOf(env.DEVICE_APPROVE_ACCOUNT_WINDOW_SEC, DEFAULT_TIME_WINDOW),
  enrollStatusIpLimit: numOf(env.ENROLL_STATUS_IP_LIMIT, 600),
  enrollStatusIpWindowSec: numOf(env.ENROLL_STATUS_IP_WINDOW_SEC, DEFAULT_TIME_WINDOW),

  // Messaging (milestone 3)
  msgAccountLimit: numOf(env.MSG_ACCOUNT_LIMIT, 120),
  msgAccountWindowSec: numOf(env.MSG_ACCOUNT_WINDOW_SEC, DEFAULT_TIME_WINDOW),
  msgIpLimit: numOf(env.MSG_IP_LIMIT, 240),
  // Retention: how long PULLED copies stay server-side (expireAt = pulledAt +
  // this) for re-delivery via 'resync'. Never-pulled copies stay queued.
  msgRetentionSec: numOf(env.MSG_RETENTION_SEC, 30 * 24 * 3600),
  msgIpWindowSec: numOf(env.MSG_IP_WINDOW_SEC, DEFAULT_TIME_WINDOW),
  userKeysIpLimit: numOf(env.USER_KEYS_IP_LIMIT, 60),
  userKeysIpWindowSec: numOf(env.USER_KEYS_IP_WINDOW_SEC, DEFAULT_TIME_WINDOW),

  // Self-service device removal (DELETE /api/devices/:id).
  deviceRemoveAccountLimit: numOf(env.DEVICE_REMOVE_ACCOUNT_LIMIT, 10),
  deviceRemoveWindowSec: numOf(env.DEVICE_REMOVE_WINDOW_SEC, 3600),

  // Diagnostics upload ('Send diagnostics' button) — payload size-capped and
  // TTL-expired server-side; the per-IP limit is the spam gate.
  diagIpLimit: numOf(env.DIAG_IP_LIMIT, 30),
  diagIpWindowSec: numOf(env.DIAG_IP_WINDOW_SEC, 3600),
  diagAccountLimit: numOf(env.DIAG_ACCOUNT_LIMIT, 30),
  diagAccountWindowSec: numOf(env.DIAG_ACCOUNT_WINDOW_SEC, 24 * 3600),
  wsHeartbeatSec: numOf(env.WS_HEARTBEAT_SEC, 30),
};

config.jwtSecretInsecure = config.jwtSecret === 'dev-secret-change-me' || config.jwtSecret.length < 32;

if (config.jwtSecretInsecure) {
  console.warn('[config] JWT_SECRET is the dev default or too short — generate one with: openssl rand -base64 48');
}
