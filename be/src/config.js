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
  maxDevicesDefault: numOf(env.MAX_DEVICES, 3), // legacy seed value; enforcement uses lib/devicePolicy.js

  // Device-cap policy by account state (see lib/devicePolicy.js): unverified
  // devices are a spam/abuse surface, so the free tier is one device, a
  // human-verified account two, premium five. Admin can pin any number via
  // the per-user override.
  deviceLimitUnverified: numOf(env.DEVICE_LIMIT_UNVERIFIED, 1),
  deviceLimitVerified: numOf(env.DEVICE_LIMIT_VERIFIED, 2),
  deviceLimitPremium: numOf(env.DEVICE_LIMIT_PREMIUM, 5),

  signupIpLimit: numOf(env.SIGNUP_IP_LIMIT, 20),
  signupIpWindowSec: numOf(env.SIGNUP_IP_WINDOW_SEC, IP_TIME_WINDOW),
  challengeIpLimit: numOf(env.CHALLENGE_IP_LIMIT, 60),
  challengeIpWindowSec: numOf(env.CHALLENGE_IP_WINDOW_SEC, IP_TIME_WINDOW),
  // 40/15min: a household or shared NAT signing several devices in
  // kept generous after the 2026-10 doubling — login churn should not 429
  // 'You've got mail' award threshold — messages SENT per account. Currently
  // 5 for a playful dev-scale target; the plan is 1000 for production.
  mailBadgeCount: numOf(env.MAIL_BADGE_COUNT, 5),
  verifyAccountLimit: numOf(env.VERIFY_ACCOUNT_LIMIT, 40),
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
  // this) for re-delivery via 'resync'.
  msgRetentionSec: numOf(env.MSG_RETENTION_SEC, 30 * 24 * 3600),
  // Queue cap: NEVER-pulled copies get expireAt = ts + this at insert, so an
  // offline-forever device can no longer pin unbounded storage (P0 #2 first
  // instalment; outgoing multi-device sync multiplies copies per send). The
  // TTL index on messages.expireAt does the sweeping.
  msgQueueMaxSec: numOf(env.MSG_QUEUE_MAX_DAYS, 30) * 24 * 3600,
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
  // ID-verified accounts get a bigger DAILY verification budget (10, not 4):
  // a proven human can vouch faster. The WEEKLY cap stays 10 for everyone —
  // the day is a throttle, the week is the real ceiling (slow grinding past
  // the daily allowance is exactly what the weekly limit exists to stop).
  friendVerifyDailyVerifiedLimit: numOf(env.FRIEND_VERIFY_DAILY_VERIFIED_LIMIT, 10),
  friendVerifyWeeklyLimit: numOf(env.FRIEND_VERIFY_WEEKLY_LIMIT, 10),
  friendVerifyWeeklyWindowSec: numOf(env.FRIEND_VERIFY_WEEKLY_WINDOW_SEC, 7 * 24 * 3600),
  friendTrustDailyLimit: numOf(env.FRIEND_TRUST_DAILY_LIMIT, 4),
  friendTrustDailyWindowSec: numOf(env.FRIEND_TRUST_DAILY_WINDOW_SEC, 24 * 3600),
  friendTrustWeeklyLimit: numOf(env.FRIEND_TRUST_WEEKLY_LIMIT, 10),
  friendTrustWeeklyWindowSec: numOf(env.FRIEND_TRUST_WEEKLY_WINDOW_SEC, 7 * 24 * 3600),

  // Self-service device removal (DELETE /api/devices/:id).
  deviceRemoveAccountLimit: numOf(env.DEVICE_REMOVE_ACCOUNT_LIMIT, 10),
  deviceRemoveWindowSec: numOf(env.DEVICE_REMOVE_WINDOW_SEC, 3600),

  // Device self-status (PWA-installed flag): fires on every WS open, so the
  // budget is per-day churn headroom, not a scarce allowance.
  deviceSelfAccountLimit: numOf(env.DEVICE_SELF_ACCOUNT_LIMIT, 200),
  deviceSelfWindowSec: numOf(env.DEVICE_SELF_WINDOW_SEC, 24 * 3600),

  // Device egress-IP tracking (app.js auth hook): the latest IP is kept per
  // device (admin 'known IPs'); an IP CHANGE costs the device one unit from
  // a fixed-window budget — more than `limit` changes inside `windowSec` and
  // that device's API calls get 429 until the window passes. Fixed-window
  // expiry makes this self-healing: a device behind flapping carrier NAT
  // cools back in within minutes; a proxy-hopper gets a hard stall per
  // device without punishing the account's other devices.
  // default budget: 20 IP changes per 5 min — generous for carrier-NAT /
  // VPN- hopping humans, still a wall for proxy rotation; the ipflap entry
  // in lib/limits.js makes it tunable app-wide (Traffic → Tune) AND per
  // device (user panel device rows)
  deviceIpFlapLimit: numOf(env.DEVICE_IP_FLAP_LIMIT, 20),
  deviceIpFlapWindowSec: numOf(env.DEVICE_IP_FLAP_WINDOW_SEC, 300),

  // Server-wide rate-limit kill switch (dev/ops): hard-off at boot via this
  // env, or at runtime via settings {_id:'traffic'}.rateLimitsDisabled — see
  // lib/rateLimit.js + the admin state endpoint. Used by ops/fake-users.
  rateLimitsDisabled: env.RATE_LIMITS_DISABLED === 'true',
  // how long a device's last-seen IP survives quiet periods (redis)
  deviceIpTtlSec: numOf(env.DEVICE_IP_TTL_SEC, 24 * 3600),

  // Diagnostics upload ('Send diagnostics' button) — payload size-capped and
  // TTL-expired server-side; the per-IP limit is the spam gate.
  diagIpLimit: numOf(env.DIAG_IP_LIMIT, 60),
  diagIpWindowSec: numOf(env.DIAG_IP_WINDOW_SEC, IP_TIME_WINDOW),
  diagAccountLimit: numOf(env.DIAG_ACCOUNT_LIMIT, 30),
  diagAccountWindowSec: numOf(env.DIAG_ACCOUNT_WINDOW_SEC, 24 * 3600),

  // Abuse reports ('Report user' in the chat menu): rare by nature — the
  // per-IP window is the spam gate, the per-account budget stops one device
  // from roaming IPs. Transcripts ride these bodies (route caps size).
  reportIpLimit: numOf(env.REPORT_IP_LIMIT, 20),
  reportIpWindowSec: numOf(env.REPORT_IP_WINDOW_SEC, IP_TIME_WINDOW),
  reportAccountLimit: numOf(env.REPORT_ACCOUNT_LIMIT, 20),
  reportAccountWindowSec: numOf(env.REPORT_ACCOUNT_WINDOW_SEC, 24 * 3600),
  // A report's attachments (req 9): three items and this many PLAINTEXT bytes
  // in total per report. The bytes live one doc each in `report_media` — a
  // single 30 MB field would exceed Mongo's 16 MB document limit.
  reportMediaMaxBytes: numOf(env.REPORT_MEDIA_MAX_BYTES, 30 * 1024 * 1024),
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
  // flat reputation gift for PREMIUM subscribers (gold certificate)
  cocoPremiumBonus: numOf(env.COCO_PREMIUM_BONUS, 5),
  // accounts created before this instant are Early-Bird eligible (capped)
  earlyBirdDeadline: env.EARLY_BIRD_DEADLINE || '2026-12-31T23:59:59Z',
  // badge caps (seat counts) — config so ops/tests can shrink them
  ogBadgeCap: numOf(env.OG_BADGE_CAP, 10),
  earlyBirdCap: numOf(env.EARLY_BIRD_CAP, 1000),

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

  // Media / files (milestone 4). Blobs NEVER ride the WebSocket (frames are
  // capped at 64 KB) — bytes move over REST, the referencing *message* rides
  // the existing E2EE store-and-forward path. The server stores CIPHERTEXT
  // only (per-file AES-GCM key travels inside the recipient's envelope), so
  // it cannot validate mime/magic bytes and must instead be stingy about
  // SIZE: caps + a per-account quota + retention sweeps are all part of the
  // same PR as the upload route (unbounded blob storage is a P0-class DoS).
  mediaMaxBytes: numOf(env.MEDIA_MAX_BYTES, 10 * 1024 * 1024),
  mediaThumbMaxBytes: numOf(env.MEDIA_THUMB_MAX_BYTES, 64 * 1024),
  // per-account server-held bytes (sum of ciphertext sizes of owned docs)
  mediaQuotaMb: numOf(env.MEDIA_QUOTA_MB, 100),
  // un-acked blobs are swept after this many days (and never-sent uploads
  // — orphan docs with an empty `devices` list — after 24 h)
  mediaRetentionDays: numOf(env.MEDIA_RETENTION_DAYS, 7),
  mediaOrphanMaxSec: numOf(env.MEDIA_ORPHAN_MAX_SEC, 24 * 3600),
  // JSON/base64 bodies inflate ~4/3; the upload route's bodyLimit is derived
  // from the blob caps (same trick as the ID-doc route).
  mediaUpIpLimit: numOf(env.MEDIA_UP_IP_LIMIT, 60),
  mediaUpAccountLimit: numOf(env.MEDIA_UP_ACCOUNT_LIMIT, 60),
  mediaUpWindowSec: numOf(env.MEDIA_UP_WINDOW_SEC, DEFAULT_TIME_WINDOW),
  mediaDlIpLimit: numOf(env.MEDIA_DL_IP_LIMIT, 240),
  mediaDlAccountLimit: numOf(env.MEDIA_DL_ACCOUNT_LIMIT, 240),
  mediaDlWindowSec: numOf(env.MEDIA_DL_WINDOW_SEC, DEFAULT_TIME_WINDOW),
  // how often the media sweeper runs (server-side safety net behind the
  // inline delete-on-empty-pending path)
  mediaSweepSec: numOf(env.MEDIA_SWEEP_SEC, 3600),

  // app-info endpoint poll guard (the FE fetches it on boot; cached 30s)
  appInfoIpLimit: numOf(env.APP_INFO_IP_LIMIT, 240),
  appInfoWindowSec: numOf(env.APP_INFO_WINDOW_SEC, IP_TIME_WINDOW),

  // Share-link click reports (POST /api/share/hit, lib/shares.js). Per
  // ACCOUNT, not per IP: only a signed-in session can report one, and the
  // write is an upsert on a bounded (owner -> viewer) pair, so the budget
  // only has to stop a client hammering the endpoint in a loop. 60/hour is
  // far past any real usage (a click is reported once per link open).
  shareHitAccountLimit: numOf(env.SHARE_HIT_ACCOUNT_LIMIT, 60),
  shareHitWindowSec: numOf(env.SHARE_HIT_WINDOW_SEC, 3600),
};

config.jwtSecretInsecure = config.jwtSecret === 'dev-secret-change-me' || config.jwtSecret.length < 32;

if (config.jwtSecretInsecure) {
  console.warn('[config] JWT_SECRET is the dev default or too short — generate one with: openssl rand -base64 48');
}
