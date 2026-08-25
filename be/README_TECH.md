# be — technical overview

Node.js ≥ 22.9, plain JavaScript (ESM), bare-minimum dependencies. Fastify for HTTP;
MongoDB for persistence; Redis for nonces/rate limiting (and pub/sub once messaging
lands). JWT handling is hand-rolled HS256 (`src/lib/jwt.js`) to avoid a dependency for
something this small.

## Layout

```
src/
  server.js        entry: connects Mongo/Redis, builds app, listens, graceful shutdown
  dev.js           dev entry: persistent mongodb-memory-server, then server.js
  admin.js         internal admin app (separate process, see below)
  app.js           Fastify app factory: bearer-token hook + registers routes/app-routes
  config.js        env-driven config with defaults (see .env.example)
  db.js            Mongo/Redis connection helpers (Mongo index creation lives here)
  routes/
    shared.js      fail()/limited()/requireAuth(), security headers, freshness +
                   replay helpers
    app-routes/    public API, registered by app.js
      index.js     registers signup + auth + me + devices
      signup.js    POST /api/signup
      auth.js      POST /api/auth/challenge, POST /api/auth/verify
      me.js        GET /api/me
      devices.js   POST /api/devices/enroll, GET /api/devices/enroll-status/:id,
                   POST /api/devices/pending, POST /api/devices/approve,
                   GET /api/devices
    admin-routes/  internal API, registered by admin.js
      index.js     registers users + rateLimits
      users.js     GET/DELETE /api/admin/users[...]
      rateLimits.js GET/POST /api/admin/rate-limits[...]
  lib/
    b64u.js        base64url encode/decode
    canon.js       canonical JSON (sorted keys) used for signatures
    ed25519.js     raw-key import (via JWK) + signature verification
    jwt.js         minimal HS256 sign/verify (constant-time compare)
    rateLimit.js   Redis INCR + EXPIRE limiter
    username.js    username/device-id validation rules
admin/
  index.html       admin UI (served by admin.js)
  style.css        admin styles (external file — CSP forbids inline styles)
  app.js           admin UI logic
scripts/
  verify-e2e.mjs   smoke test of the account flow against a running server
test/
  helpers.js       setupApp() (ephemeral Mongo + Redis db 15) + simulated client
  unit.test.js     canonical JSON, b64u, JWT, validation, Ed25519 helpers
  accounts.test.js integration: signup/auth flows, errors, replay, rate limits
  devices.test.js  integration: device enroll/approve/status/list flows
```

`buildApp({ mongo, redis, config, feRoot })` is dependency-injected so tests run against
ephemeral stores with `app.inject()` — no ports needed.

## Storage

### MongoDB — `users` collection

```javascript
{
  _id,
  u: 'Alice',                 // original casing (display)
  ul: 'alice',                // lowercase — unique index
  devices: [
    {
      id: '<uuid>',           // client-generated device id
      pub: '<b64u raw 32-byte Ed25519 public key>',
      aes: '<b64u raw AES-GCM key (transport key)>',
      main: true,             // first device is the main device
      createdAt, lastSeenAt,
    },
  ],
  maxDevices: 3,              // per-account override (admin feature later)
  createdAt,
}
```

The schema is multi-device; devices are added via the pairing-code flow
(`routes/app-routes/devices.js`).

### Redis key namespace

| Key | Meaning |
| --- | ------- |
| `auth:nonce:<n>` | one-time login nonce → JSON `{ ul, d }`, TTL `NONCE_TTL_SEC` |
| `rl:signup:<ip>` | signup attempts per IP |
| `rl:challenge:<ip>` | challenge requests per IP |
| `rl:verify:<ul>` | verify attempts per account (counted only AFTER a valid nonce is consumed) |
| `rl:verifyip:<ip>` | verify attempts per IP |
| `rl:denroll:<ip>` | device enrollment requests per IP |
| `rl:dapprove:<ul>` | device approval attempts per account |
| `rl:dpending:<ul>` | pending-enrollment lookups per account |
| `rl:denrollstatus:<ip>` | enroll-status polls per IP (generous) |
| `rl:admintoken:<ip>` | failed admin-token attempts per IP |
| `sigseen:<sha256(s)>` | replay guard for signed payloads, TTL `2 x SIGNED_PAYLOAD_MAX_AGE_SEC` |
| `denroll:c:<ul>:<code>` | pending device enrollment (JSON, single-use), TTL `DEVICE_CODE_TTL_SEC` |
| `denroll:p:<enrollId>` | pending marker so the new device can poll its state |
| `denroll:ok:<enrollId>` | approval marker set when the device is added |

Counters are created atomically with their TTL (`SET NX EX` then `INCR`), so a crash can
never strand a key with no expiry.

Tests use Redis database 15 (`TEST_REDIS_URL`) and flush it before each suite.

## Authentication

### Signup — `POST /api/signup`

Body `{ u, p, a, d, t, s }`:

- `u` — username: 5–64 chars of `[a-zA-Z0-9_-]`, not reserved, case-insensitively unique
- `p` — raw 32-byte Ed25519 public key, base64url
- `a` — raw AES-GCM key (16/24/32 bytes), base64url
- `d` — device id: 8–64 chars of `[a-zA-Z0-9_-]` (clients use `crypto.randomUUID()`)
- `t` — client epoch-seconds timestamp; must be within `SIGNED_PAYLOAD_MAX_AGE_SEC`
  (default 5 min) of server time
- `s` — Ed25519 signature over the UTF-8 bytes of `canonical({ a, d, p, t, u })`;
  accepted signatures are de-duplicated in Redis (`sigseen:`), so payloads are not
  replayable

Canonical JSON (sorted keys, no whitespace) is implemented identically in
`src/lib/canon.js` and `fe/js/util.js` — they must stay in sync.

Node has no raw Ed25519 import, so keys are imported via JWK
(`{ kty: 'OKP', crv: 'Ed25519', x: <b64u> }`).

### Login — challenge-response

1. `POST /api/auth/challenge { u, d }` → `{ n }` — 32 random bytes (base64url), stored
   in Redis keyed to the account+device with a TTL. Issued for ANY pair (unknown pairs
   get a nonce that never verifies), so the endpoint does not enumerate accounts.
2. Client signs the nonce string with the device's private key.
3. `POST /api/auth/verify { u, d, n, s }` → `{ token }` — the server `GETDEL`s the nonce
   FIRST (atomic, single-use; junk without a valid nonce never touches the rate-limit
   budget), then rate-limits per account AND per IP, verifies the signature against the
   stored public key, bumps `lastSeenAt`, and issues a JWT.

JWT payload: `{ sub: <ul>, u: <display name>, d: <device id>, iss, aud, iat, exp }`,
HS256 with `JWT_SECRET`. Authenticated routes read `Authorization: Bearer <token>` (set
on `request.auth` in an onRequest hook). The hook also re-checks that the token's device
is still registered — a removed device loses access immediately (revocation by registry,
no blacklist needed).

`server.js` refuses to boot when `JWT_SECRET` is the dev default or shorter than 32
chars, unless `ALLOW_DEV_JWT_SECRET=true` (`pnpm dev` sets that for localhost use).

### Adding devices — pairing code

1. `POST /api/devices/enroll` — same payload/signature as signup (freshness + replay
   rules included), signed by the NEW device; the server checks the account exists, the
   device id is new, and `maxDevices` is not reached, then issues `{ code, enrollId }`
   (6-digit code claimed with `SET NX` so concurrent enrollments can't collide, TTL
   `DEVICE_CODE_TTL_SEC`, default 10 min).
2. `POST /api/devices/pending { code }` (JWT) — returns `{ d, requestedAt }` so the
   approving UI can show WHAT would be approved and ask for confirmation.
3. `POST /api/devices/approve { code }` (JWT) — an existing device approves. Codes are
   scoped per account (`denroll:c:<ul>:<code>`) and single-use; the device is added with
   an atomic update guarded by a `$expr` size check against `maxDevices`.
4. `GET /api/devices/enroll-status/:enrollId` — polled by the new device; `enrollId` is
   an unguessable 192-bit capability (the device has no JWT yet). The path is redacted
   in request logs so the capability never leaks there.

Once approved, the new device logs in via the normal challenge-response flow. All
devices authenticate independently, so several can be signed in simultaneously.

### Rate limiting

Redis `SET NX EX` + `INCR` per window. Defaults (see `config.js`): signup 10/IP/15min,
challenge 30/IP/15min, verify 20/account/15min + 20/IP/15min, device enroll 10/IP/15min,
device approve/pending 20/account/15min, enroll-status 600/IP/15min, failed admin tokens
10/IP/15min — all configurable. 429 responses carry `Retry-After`.

Behind nginx, set `TRUST_PROXY` so `request.ip` reflects real client IPs (Fastify
`trustProxy`); otherwise every IP-scoped bucket collapses into one shared bucket.

### Response hardening

Every response from both servers carries a strict same-origin CSP (`default-src 'self'`,
no inline scripts/styles), `X-Content-Type-Options: nosniff`, and
`Referrer-Policy: no-referrer`.

## Admin app

`src/admin.js` runs separately (`pnpm admin`, default http://127.0.0.1:3001) and shares
`config.js`/`db.js`, so it uses the same `.env`. It serves `admin/` as static files and
exposes internal-only endpoints:

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/api/admin/users` | users + devices (public keys omitted) |
| GET | `/api/admin/rate-limits` | live `rl:*` counters via Redis SCAN |
| POST | `/api/admin/rate-limits/clear` | clear by `{ ip }` (all IP-scoped counters) or exact `{ key }` |
| DELETE | `/api/admin/users/:username` | delete an account |
| DELETE | `/api/admin/users/:username/devices/:deviceId` | remove a device (refuses the last one) |

If `ADMIN_TOKEN` is set, every admin API request must carry it in the `x-admin-token`
header; the UI keeps the token in localStorage. Security properties of the gate:

- **Scoped to the admin routes' encapsulation context** — it keys off the matched route,
  not the raw URL, so percent-encoding tricks (`/%61pi/...`) cannot bypass it.
- **Fail closed** — a non-loopback `ADMIN_HOST` without `ADMIN_TOKEN` refuses to boot;
  loopback without a token boots with a loud warning (local dev only).
- **Constant-time comparison** and per-IP throttling of failed token attempts.

## Testing

`node:test` + `node:assert/strict`. Integration tests spin up an ephemeral
`MongoMemoryServer` per suite and use the local Redis db 15. The simulated client
(`makeClient()`) mirrors what the browser does: raw-key export from an SPKI DER suffix,
canonical-JSON signing.

```bash
pnpm test                          # unit + integration
node scripts/verify-e2e.mjs        # live-server smoke test (server must be running)
```

## Roadmap (next milestones)

- WebSocket server (`ws`): identity in headers/query at upgrade time, server-initiated
  heartbeat, per-node `localClients` map, Redis pub/sub fan-out (see DESIGN.md "Message
  Flow on BE").
- `worker_threads` for everything except pub/sub (persistence, fan-out, crypto checks).
- Store-and-forward message queues (Redis → MongoDB → expiry), per-device encrypted
  messages, pull-on-reconnect.
