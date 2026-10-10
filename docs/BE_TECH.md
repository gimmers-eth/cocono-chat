# be — technical overview

Node.js ≥ 22.9, plain JavaScript (ESM), bare-minimum dependencies. Fastify for HTTP +
WebSocket (`@fastify/websocket`); MongoDB for persistence; Redis for nonces, rate
limiting and pub/sub fan-out. JWT handling is hand-rolled HS256 (`src/lib/jwt.js`) to
avoid a dependency for something this small.

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
      index.js     registers signup + auth + me + devices + userKeys
      signup.js    POST /api/signup
      auth.js      POST /api/auth/challenge, POST /api/auth/verify
      me.js        GET /api/me
      devices.js   POST /api/devices/enroll, GET /api/devices/enroll-status/:id,
                   POST /api/devices/pending, POST /api/devices/approve,
                   GET /api/devices
      userKeys.js  GET /api/users/:username/keys (device public keys)
      media.js     POST /api/media, GET /api/media/:id[?part=thumb],
                   POST /api/media/:id/ack (milestone 4 blob transfer)
    ws-routes/     WebSocket layer, registered by app.js
      index.js     /ws endpoint: JWT-at-upgrade auth, heartbeats, dispatch,
                   pub/sub wiring, one-live-connection-per-device
      protocol.js  wire constants (frame cap, batch size) + sendJson/devKey
      envelope.js  envelope validation: structure, freshness, HMAC, signature
      handlers.js  handleSend / handlePulled / deliverPending (the
                   store-and-forward seam for a future worker_threads move)
    admin-routes/  internal API, registered by admin.js
      index.js     registers users + rateLimits
      users.js     GET/DELETE /api/admin/users[...]
      rateLimits.js GET/POST /api/admin/rate-limits[...]
      reports.js   GET/DELETE /api/admin/reports[...] + the decrypted
                   attachment bytes: GET /api/admin/reports/:id/media/:index
    lib/media.js   THE blob lifecycle (att validation, device registration,
                   ack → delete-on-empty-pending, retention/orphan sweeper,
                   moderation decryption for reports)
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
  messaging.test.js integration (real WS): online/offline delivery, receipts,
                   HMAC/sender/recipient guards, idempotent retries, keys endpoint
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

### MongoDB — `messages` collection (milestone 3)

Store-and-forward queue: one doc per recipient device, deleted once that device pulls.

```javascript
{
  mid: '<uuid>',              // server-assigned message id
  to: { ul, dv },             // recipient account + device
  from: { ul, fd },           // sender account + device
  cid: '<client id>',         // sender's client id (idempotent retries)
  env: { m, s? },             // the envelope as sent (ciphertext inside m.d)
  ts: Date,                   // server receive time (ordering)
}
```

Indexes: `{ to.ul, to.dv, ts }` (pending fetch) and unique `{ from.ul, from.fd, cid }`
(idempotent retries).

### MongoDB — `media` collection (milestone 4)

One doc per SEND (not per recipient), holding CIPHERTEXT only. The message that
references it rides the normal queue; this is the blob locker.

```javascript
{
  _id: '<blob id, server uuid>',
  owner: { ul, fd },           // uploading device (the sender) — quota + auth
  kind: 'image'|'video'|'file',
  ctSize, thumbCtSize,         // byte lengths of what is stored
  sha256,                      // digest of the ciphertext, VERIFIED on upload
  blob: Binary,                // iv(12) ‖ ct ‖ tag(16) — unreadable server-side
  thumb: Binary | null,        // client-made 256 px preview, same key, own IV
  devices: [ { ul, dv } ],     // authorised recipients (handleSend adds)
  pending: [ { ul, dv } ],     // …of those, the ones that have not acked
  reported: false,              // pinned by a report — excluded from deletion
  ts: Date,                     // upload time (retention/orphan sweep)
}
```

Indexes: `{ 'owner.ul': 1 }` (quota) and `{ ts: 1 }` (sweep). Deliberately **no
unique index on `sha256`** — cross-send de-dup would turn a hash match into an
upload oracle ("someone already holds this exact ciphertext").

Lifecycle: `handleSend` adds each addressed device to `devices`+`pending`
(including the sender's own sync-copy devices); `POST /api/media/:id/ack`
removes the acker and deletes the doc when `pending` empties and nothing is
`reported`. A `setInterval` sweeper in `server.js` (hourly, `lib/media.js`) is
the safety net: un-acked blobs past `MEDIA_RETENTION_DAYS`, orphan uploads
(empty `devices`) past `MEDIA_ORPHAN_MAX_SEC`, never `reported` docs.

### MongoDB — `report_media` collection (req 9)

A report's DECRYPTED attachments, one doc per item — a report carrying three
10 MB images could never fit a single 16 MB Mongo document, and the report list
must stay a list.

```javascript
{ report: <reports _id>, index: <n>, blobId, kind, name, mime, bytes,
  source: 'server'|'reporter', plain: Binary, ts }
```

Unique index `{ report, index }`. Served by
`GET /api/admin/reports/:id/media/:index` and deleted with the report.

### MongoDB — `shares` / `contacts` (share-link attribution + graph edges)

Metadata only — no content, no envelope. Model, trust level and the admin
views built on them: [SHARES.md](./SHARES.md); helpers in `src/lib/shares.js`.

```javascript
// shares: ONE doc per (link owner -> account that followed it)
{ o: 'alice', viewer: 'bobby', n: 3, firstAt, lastAt, created: Date? }
//   n        clicks, excluding the creation itself
//   created  set only when `viewer` was CREATED from o's link

// contacts: ONE doc per (sender -> recipient), written on every accepted send
{ from: 'alice', to: 'bobby', n: 12, firstAt, lastAt }
```

Indexes: unique `{o, viewer}` + `{viewer}` (the reverse read) on `shares`;
unique `{from, to}` on `contacts`. Both are bounded by real relationships, not
by traffic — a repeat click bumps a counter. `users.ref = { by, at }` (written
once at signup from the UNSIGNED `r` field) is the account's parent, and
survives the parent's deletion so the graph can draw a ghost node.
`deleteAccountFully` purges both collections in BOTH directions.

### MongoDB — `graph` collection (one doc, `_id: 'godview'`)

The stored God View snapshot: `{ generatedAt, stats, nodes[], edges[], layout,
layoutSavedAt }`. Derived data — replaced by `POST /api/admin/graph`, never
refreshed on a timer; `layout` holds the panel's settled node positions so a
reload shows the same picture without re-simulating.

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
| `rl:msg:<ul>` | message sends per account |
| `rl:msgip:<ip>` | message sends per IP |
| `rl:userkeys:<ip>` | peer-key lookups per IP |
| `rl:mediaup:<ip>` / `rl:mediaupacct:<ul>` | media blob uploads (M4) |
| `rl:mediadl:<ip>` / `rl:mediadlacct:<ul>` | media downloads and acks (M4) |
| `dm:<ul>:<dv>` | live-delivery pub/sub channel for one device |

Counters are created atomically with their TTL (`SET NX EX` then `INCR`), so a crash can
never strand a key with no expiry.

Tests use Redis database 15 (`TEST_REDIS_URL`) and flush it before each suite.

## Authentication

### Signup — `POST /api/signup`

Body `{ u, p, x, a, d, t, s }`:

- `u` — username: 5–64 chars of `[a-zA-Z0-9_-]`, not reserved, case-insensitively unique
- `p` — raw 32-byte Ed25519 public key, base64url
- `x` — raw 32-byte X25519 key-agreement public key, base64url (milestone 3)
- `a` — raw AES-GCM key (16/24/32 bytes), base64url
- `d` — device id: 8–64 chars of `[a-zA-Z0-9_-]` (clients use `crypto.randomUUID()`)
- `t` — client epoch-seconds timestamp; must be within `SIGNED_PAYLOAD_MAX_AGE_SEC`
  (default 5 min) of server time
- `s` — Ed25519 signature over the UTF-8 bytes of `canonical({ a, d, p, t, u, x })`;
  accepted signatures are de-duplicated in Redis (`sigseen:`), so payloads are not
  replayable

Canonical JSON (sorted keys, no whitespace) is implemented identically in
`src/lib/canon.js` and `client/src/encoding.js` — they must stay in sync.

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
10/IP/15min, message sends 120/account/15min + 240/IP/15min, peer-key lookups
60/IP/15min — all configurable. 429 responses carry `Retry-After`.

Behind nginx, set `TRUST_PROXY` so `request.ip` reflects real client IPs (Fastify
`trustProxy`); otherwise every IP-scoped bucket collapses into one shared bucket.

### Response hardening

Every response from both servers carries a strict same-origin CSP (`default-src 'self'`,
no inline scripts/styles), `X-Content-Type-Options: nosniff`, and
`Referrer-Policy: no-referrer`.

## Media / files (milestone 4)

Blobs never ride the WebSocket (64 KB frame cap). Three REST endpoints move
bytes; the *message* that points at them rides the normal E2EE queue, so
delivery, ordering, idempotency, receipts, push gating and resync are unchanged.

| Method | Path | Purpose |
| ------ | ---- | ------- |
| POST | `/api/media` | `{ kind, blob, thumb?, sha256 }` (base64url ciphertext) → `{ id }`. Caps: `MEDIA_MAX_BYTES`, `MEDIA_THUMB_MAX_BYTES`, per-account `MEDIA_QUOTA_MB`; the claimed sha256 must match the bytes (a stored digest never lies) |
| GET | `/api/media/:id` | the ciphertext, as `application/octet-stream` + `nosniff` (never a browser-renderable mime from our origin) with `x-cocono-kind` and `ETag = sha256`. `?part=thumb` returns just the encrypted poster (video previews without a 10 MB pull) and does NOT ack |
| POST | `/api/media/:id/ack` | `{ downloaded: true\|false }` — the second is "delete it before I download it". Idempotent; authorisation is exactly `(account, device) ∈ devices` |

The envelope gains one optional plaintext field `m.att = { id, kind, size }`
(HMAC-covered). `handleSend` requires the blob to be the sender's own upload of
exactly the claimed kind/size (`unknown_attachment` / `invalid_envelope`) and
`$addToSet`s the addressed device into `devices` + `pending` — sync copies of
the sender's own devices included, so a blob cannot vanish before every device
that was promised it has answered.

Config (see `.env.example`): `MEDIA_MAX_BYTES` (10 MiB),
`MEDIA_THUMB_MAX_BYTES` (64 KiB), `MEDIA_QUOTA_MB` (100),
`MEDIA_RETENTION_DAYS` (7), `MEDIA_ORPHAN_MAX_SEC` (86400),
`MEDIA_SWEEP_SEC` (3600), `MEDIA_UP_IP_LIMIT`/`MEDIA_UP_ACCOUNT_LIMIT`,
`MEDIA_DL_IP_LIMIT`/`MEDIA_DL_ACCOUNT_LIMIT`, `REPORT_MEDIA_MAX_BYTES` (30 MiB).
All four media limiters are catalog entries (`lib/limits.js`), so admin
per-user/per-IP overrides and "clear limits for IP" cover them like everything
else. Account deletion purges owned blobs; `ops/wipe-data.sh` needs no edit
(`media` and `report_media` are auto-discovered user data).

Because the server holds ciphertext, it cannot check mime or magic bytes — that
is by design, and it makes SIZE the abuse lever: caps + quota + sweeps ship in
the same change as the upload route (`docs/features/images-and-files.md` §8).

## Messaging (milestone 3)

WebSocket endpoint `GET /ws?token=<jwt>` (same port as REST). The JWT is in the query
string because browsers cannot set WS upgrade headers; it is validated the same way as
REST and the token is redacted from request logs. The server heartbeats every
`WS_HEARTBEAT_SEC` (default 30s) and terminates connections that miss a pong. One live
connection per device — a newer connection replaces the older (`4000 replaced`).

Wire protocol (JSON frames):

| Direction | Frame | Meaning |
| --------- | ----- | ------- |
| c → s | `{type:'msg', msg:envelope}` | send a message envelope |
| c → s | `{type:'pulled', ids:[mid,...]}` | confirm receipt of delivered messages |
| s → c | `{type:'hello'}` | connection accepted |
| s → c | `{type:'msg', id, ts, env}` | incoming message |
| s → c | `{type:'ack', cid, ok, error?}` | server accepted/rejected an envelope |
| s → c | `{type:'delivered', cid, to}` | a recipient device pulled your message |
| s → c | `{type:'notice', what}` | content-free nudge: re-pull a slice of YOUR server truth (`what` = `friends` / `gone` / `profile` / `identity`; taxonomy + rationale in `be/src/lib/notify.js`) |

Flow: the sender builds an envelope (E2EE ciphertext per recipient device + HMAC `h`
keyed with the sender's transport AES key), the server validates structure, freshness,
sender match and HMAC, persists it to MongoDB, publishes to `dm:<ul>:<dv>` for live
delivery, and acks. The recipient device decrypts, stores locally, and sends `pulled`;
the server deletes the doc and notifies the sender (`delivered`). Retried envelopes are
idempotent (unique `(from, cid)` index). Self-chat echoes (your own message routed back
to your own device) are acked but not re-saved — the sender already has them as
outgoing. See DESIGN.md "Milestone 3 implementation notes" for the decisions and
deviations.

## Admin app

`src/admin.js` runs separately (`pnpm admin`, default http://127.0.0.1:3001) and shares
`config.js`/`db.js`, so it uses the same `.env`. It serves `admin/` as static files and
exposes internal-only endpoints:

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/api/admin/users` | users + devices (public keys omitted) |
| GET | `/api/admin/reports/:id/media/:index` | a reported attachment's PLAINTEXT bytes (M4) — content type SNIFFED from the bytes against an image/video allowlist, forced `attachment` for anything else, so a reported `.html`/`.svg` cannot execute on this origin |
| PATCH | `/api/admin/users/:username/max-devices` | set the account's device cap (1–1000) |
| GET | `/api/admin/users/:username/shares` | share-link story: created / seen / clicked / parent |
| GET | `/api/admin/rate-limits` | live `rl:*` counters via Redis SCAN |
| POST | `/api/admin/rate-limits/clear` | clear by `{ ip }` (all IP-scoped counters) or exact `{ key }` |
| DELETE | `/api/admin/users/:username` | delete an account |
| DELETE | `/api/admin/users/:username/devices/:deviceId` | remove a device (refuses the last one) |
| GET | `/api/admin/graph` | the STORED God View snapshot (never recomputes) |
| POST | `/api/admin/graph` | regenerate it on demand (`{keepLayout:true}` keeps surviving positions) |
| PUT | `/api/admin/graph/layout` | save the panel's node positions into the snapshot |

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

- Move message persistence/crypto into `worker_threads` (the `handleSend`/`handlePulled`
  pair is the seam) — inline for milestone 3 to keep the flow testable.
- Undelivered-message sweep (delete after X days) and the 14-day inactive-device removal.
- Files/media attachments, groups + group key agreement, subgroups, message tags.
