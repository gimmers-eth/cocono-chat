const env = process.env;

const DEFAULT_TIME_WINDOW = 900 // 15 * 60 = 15 mins
// 2026-10 policy: IP-scoped limits run on a tight 5-minute window (a real
// user rarely exceeds any of them from one IP; a script abuser gets capped
// fast) with doubled allowances, since the window is 3x shorter.
const IP_TIME_WINDOW = 300

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
  appName: env.APP_NAME ?? 'CoCoNo',

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
  // Push coalescing: a device that is offline (app closed) gets AT MOST ONE
  // blind push per this window — the missed messages stay queued and the
  // worker's peek reports '(+N more)'. Without it, every queued message
  // becomes a push the push service replays as a burst when Chrome restarts.
  pushCoalesceSec: numOf(env.PUSH_COALESCE_SEC, 90),
  // Web Push TTL: how long the push service may keep an undelivered
  // notification (web-push's own default is ~40 min). Bounds how stale the
  // wake-up can be; the messages themselves live in our queue, not here.
  pushTtlSec: numOf(env.PUSH_TTL_SEC, 6 * 3600),
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
    'user',
    'username',
    'cocono',
    'co-co-no',
  ]),
  // names may not START with these either (brand impersonation): covers the
  // app name 'CoCoNo' in its dashed domain spelling too
  reservedUsernamePrefixes: listOf(env.RESERVED_USERNAME_PREFIXES, ['cocono', 'co-co-no']),
  maxDevicesDefault: numOf(env.MAX_DEVICES, 3),

  signupIpLimit: numOf(env.SIGNUP_IP_LIMIT, 20),
  signupIpWindowSec: numOf(env.SIGNUP_IP_WINDOW_SEC, IP_TIME_WINDOW),
  challengeIpLimit: numOf(env.CHALLENGE_IP_LIMIT, 60),
  challengeIpWindowSec: numOf(env.CHALLENGE_IP_WINDOW_SEC, IP_TIME_WINDOW),
  verifyAccountLimit: numOf(env.VERIFY_ACCOUNT_LIMIT, 20),
  verifyAccountWindowSec: numOf(env.VERIFY_ACCOUNT_WINDOW_SEC, DEFAULT_TIME_WINDOW),
  verifyIpLimit: numOf(env.VERIFY_IP_LIMIT, 100),
  verifyIpWindowSec: numOf(env.VERIFY_IP_WINDOW_SEC, IP_TIME_WINDOW),
  deviceCodeTtlSec: numOf(env.DEVICE_CODE_TTL_SEC, 10 * 60),
  deviceEnrollIpLimit: numOf(env.DEVICE_ENROLL_IP_LIMIT, 20),
  deviceEnrollIpWindowSec: numOf(env.DEVICE_ENROLL_IP_WINDOW_SEC, IP_TIME_WINDOW),
  deviceApproveAccountLimit: numOf(env.DEVICE_APPROVE_ACCOUNT_LIMIT, 20),
  deviceApproveAccountWindowSec: numOf(env.DEVICE_APPROVE_ACCOUNT_WINDOW_SEC, DEFAULT_TIME_WINDOW),
  enrollStatusIpLimit: numOf(env.ENROLL_STATUS_IP_LIMIT, 1200),
  enrollStatusIpWindowSec: numOf(env.ENROLL_STATUS_IP_WINDOW_SEC, IP_TIME_WINDOW),

  // Messaging (milestone 3)
  msgAccountLimit: numOf(env.MSG_ACCOUNT_LIMIT, 120),
  // Message send (per account) shares the tight 5-minute window too
  // (2026-10 policy) — env MSG_ACCOUNT_WINDOW_SEC still overrides.
  msgAccountWindowSec: numOf(env.MSG_ACCOUNT_WINDOW_SEC, 300),
  msgIpLimit: numOf(env.MSG_IP_LIMIT, 480),
  // Retention: how long PULLED copies stay server-side (expireAt = pulledAt +
  // this) for re-delivery via 'resync'. Never-pulled copies stay queued.
  msgRetentionSec: numOf(env.MSG_RETENTION_SEC, 30 * 24 * 3600),
  msgIpWindowSec: numOf(env.MSG_IP_WINDOW_SEC, IP_TIME_WINDOW),
  userKeysIpLimit: numOf(env.USER_KEYS_IP_LIMIT, 120),
  userKeysIpWindowSec: numOf(env.USER_KEYS_IP_WINDOW_SEC, IP_TIME_WINDOW),

  // Friends (one-way trust list, stored per account; devices sync via
  // GET + E2EE system messages broadcast by the acting device).
  friendsMax: numOf(env.FRIENDS_MAX, 500),
  friendsIpLimit: numOf(env.FRIENDS_IP_LIMIT, 600),
  friendsChangeIpLimit: numOf(env.FRIENDS_CHANGE_IP_LIMIT, 120),
  friendsIpWindowSec: numOf(env.FRIENDS_IP_WINDOW_SEC, IP_TIME_WINDOW),

  // Per-ACCOUNT budgets on the friendship stages that vouch for real people:
  // verifying a safety number and trusting an account. Daily AND weekly per
  // action — the week caps slow grinding past the daily allowance. All four
  // admin-tunable app-wide or per user (see lib/limits.js + admin Limits).
  friendVerifyDailyLimit: numOf(env.FRIEND_VERIFY_DAILY_LIMIT, 4),
  friendVerifyDailyWindowSec: numOf(env.FRIEND_VERIFY_DAILY_WINDOW_SEC, 24 * 3600),
  friendVerifyWeeklyLimit: numOf(env.FRIEND_VERIFY_WEEKLY_LIMIT, 10),
  friendVerifyWeeklyWindowSec: numOf(env.FRIEND_VERIFY_WEEKLY_WINDOW_SEC, 7 * 24 * 3600),
  friendTrustDailyLimit: numOf(env.FRIEND_TRUST_DAILY_LIMIT, 4),
  friendTrustDailyWindowSec: numOf(env.FRIEND_TRUST_DAILY_WINDOW_SEC, 24 * 3600),
  friendTrustWeeklyLimit: numOf(env.FRIEND_TRUST_WEEKLY_LIMIT, 10),
  friendTrustWeeklyWindowSec: numOf(env.FRIEND_TRUST_WEEKLY_WINDOW_SEC, 7 * 24 * 3600),

  // Self-service device removal (DELETE /api/devices/:id).
  deviceRemoveAccountLimit: numOf(env.DEVICE_REMOVE_ACCOUNT_LIMIT, 10),
  deviceRemoveWindowSec: numOf(env.DEVICE_REMOVE_WINDOW_SEC, 3600),

  // Diagnostics upload ('Send diagnostics' button) — payload size-capped and
  // TTL-expired server-side; the per-IP limit is the spam gate.
  diagIpLimit: numOf(env.DIAG_IP_LIMIT, 60),
  diagIpWindowSec: numOf(env.DIAG_IP_WINDOW_SEC, IP_TIME_WINDOW),
  diagAccountLimit: numOf(env.DIAG_ACCOUNT_LIMIT, 30),
  diagAccountWindowSec: numOf(env.DIAG_ACCOUNT_WINDOW_SEC, 24 * 3600),
  wsHeartbeatSec: numOf(env.WS_HEARTBEAT_SEC, 30),

  // Identity verification (real-person check by the admin, distinct from
  // the peer trust ladder):
  // - unverified accounts may only message people who ADDED them as a
  //   friend, or who MESSAGED them first — no cold-messaging the directory.
  // - users upload an ID photo (image only, size-capped) via the app;
  //   only the admin can flip the verified flag, and can purge the image.
  coldSendRequiresVerification: env.COLD_SEND_REQUIRES_VERIFICATION !== 'false',
  // CoCo social score (be/src/lib/cocoScore.js): trusted needs score >
  // threshold AND account older than the minimum age
  cocoTrustThreshold: numOf(env.COCO_TRUST_THRESHOLD, 10),
  cocoTrustMinAgeDays: numOf(env.COCO_TRUST_MIN_AGE_DAYS, 30),
  // distinct trusted vouches required for Social: Trusted (1 is not a network)
  cocoTrustMinVouchers: numOf(env.COCO_TRUST_MIN_VOUCHERS, 2),

  // Profiles: short bio + tiny avatar image (clients resize before upload;
  // the server enforces anyway). Avatars are delivered ONLY when viewer
  // and target have mutually added each other (or viewer === target).
  profileBioMaxLen: numOf(env.PROFILE_BIO_MAX_LEN, 250),
  profileAvatarMaxBytes: numOf(env.PROFILE_AVATAR_MAX_BYTES, 288 * 1024),
  profileEditAccountLimit: numOf(env.PROFILE_EDIT_ACCOUNT_LIMIT, 30),
  profileEditWindowSec: numOf(env.PROFILE_EDIT_WINDOW_SEC, 3600),
  idDocMaxBytes: numOf(env.ID_DOC_MAX_BYTES, 5 * 1024 * 1024),
  // ID upload unlocks once at least one VERIFIED user has TRUSTED this
  // account (trusting = vouching on the platform; see friends trust stage)
  idUploadRequiresTrustedVerifier: env.ID_UPLOAD_REQUIRES_TRUSTED_VERIFIER !== 'false',
  idDocIpLimit: numOf(env.ID_DOC_IP_LIMIT, 20),
  idDocIpWindowSec: numOf(env.ID_DOC_IP_WINDOW_SEC, IP_TIME_WINDOW),
  idDocAccountLimit: numOf(env.ID_DOC_ACCOUNT_LIMIT, 5),
  idDocWindowSec: numOf(env.ID_DOC_WINDOW_SEC, 24 * 3600),

  // app-info endpoint poll guard (the FE fetches it on boot; cached 30s)
  appInfoIpLimit: numOf(env.APP_INFO_IP_LIMIT, 240),
  appInfoWindowSec: numOf(env.APP_INFO_WINDOW_SEC, IP_TIME_WINDOW),
};

config.jwtSecretInsecure = config.jwtSecret === 'dev-secret-change-me' || config.jwtSecret.length < 32;

if (config.jwtSecretInsecure) {
  console.warn('[config] JWT_SECRET is the dev default or too short — generate one with: openssl rand -base64 48');
}
