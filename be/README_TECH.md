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
    shared.js      fail()/limited() response helpers
    app-routes/    public API, registered by app.js
      index.js     registers signup + auth + me
      signup.js    POST /api/signup
      auth.js      POST /api/auth/challenge, POST /api/auth/verify
      me.js        GET /api/me
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
  app.js           admin UI logic
scripts/
  verify-e2e.mjs   smoke test of the account flow against a running server
test/
  helpers.js       setupApp() (ephemeral Mongo + Redis db 15) + simulated client
  unit.test.js     canonical JSON, b64u, JWT, validation, Ed25519 helpers
  accounts.test.js integration: signup/auth flows, errors, replay, rate limits
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

The schema is already multi-device ready; milestone 2 adds the device-adding flow.

### Redis key namespace

| Key | Meaning |
| --- | ------- |
| `auth:nonce:<n>` | one-time login nonce → JSON `{ ul, d }`, TTL `NONCE_TTL_SEC` |
| `rl:signup:<ip>` | signup attempts per IP |
| `rl:challenge:<ip>` | challenge requests per IP |
| `rl:verify:<ul>` | verify attempts per account (brute-force protection) |

Tests use Redis database 15 (`TEST_REDIS_URL`) and flush it before each suite.

## Authentication

### Signup — `POST /api/signup`

Body `{ u, p, a, d, s }`:

- `u` — username: 5+ chars of `[a-zA-Z0-9_-]`, not reserved, case-insensitively unique
- `p` — raw 32-byte Ed25519 public key, base64url
- `a` — raw AES-GCM key (16/24/32 bytes), base64url
- `d` — device id: 8–64 chars of `[a-zA-Z0-9_-]` (clients use `crypto.randomUUID()`)
- `s` — Ed25519 signature over the UTF-8 bytes of `canonical({ a, d, p, u })`

Canonical JSON (sorted keys, no whitespace) is implemented identically in
`src/lib/canon.js` and `fe/js/util.js` — they must stay in sync.

Node has no raw Ed25519 import, so keys are imported via JWK
(`{ kty: 'OKP', crv: 'Ed25519', x: <b64u> }`).

### Login — challenge-response

1. `POST /api/auth/challenge { u, d }` → `{ n }` — 32 random bytes (base64url), stored
   in Redis keyed to the account+device with a TTL.
2. Client signs the nonce string with the device's private key.
3. `POST /api/auth/verify { u, d, n, s }` → `{ token }` — the server `GETDEL`s the nonce
   (atomic, single-use: replays and even failed attempts consume it), verifies the
   signature against the stored public key, bumps `lastSeenAt`, and issues a JWT.

JWT payload: `{ sub: <ul>, u: <display name>, d: <device id>, iat, exp }`, HS256 with
`JWT_SECRET`. Authenticated routes read `Authorization: Bearer <token>` (set on
`request.auth` in an onRequest hook).

### Rate limiting

Redis INCR + EXPIRE per window. Defaults (see `config.js`): signup 10/IP/5min,
challenge 30/IP/15min, verify 20/account/15min — all configurable. 429 responses carry
`Retry-After`.

## Admin app

`src/admin.js` runs separately (`pnpm admin`, default http://127.0.0.1:3001) and shares
`config.js`/`db.js`, so it uses the same `.env`. It serves `admin/` as static files and
exposes internal-only endpoints:

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/api/admin/users` | users + devices (public keys omitted) |
| GET | `/api/admin/rate-limits` | live `rl:*` counters via Redis SCAN |
| POST | `/api/admin/rate-limits/clear` | clear by `{ ip }` (signup+challenge) or exact `{ key }` |
| DELETE | `/api/admin/users/:username` | delete an account |
| DELETE | `/api/admin/users/:username/devices/:deviceId` | remove a device (refuses the last one) |

If `ADMIN_TOKEN` is set, every `/api/*` request must carry it in the `x-admin-token`
header; the UI keeps the token in localStorage. The server binds `ADMIN_HOST`
(127.0.0.1 by default) — set the token before exposing it on a network.

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
- Device adding with 6-digit confirmation codes (`DEVICE_CODE_TTL`).
