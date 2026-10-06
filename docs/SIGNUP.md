# Signup & Accounts

How accounts are created, how users log in, and how additional devices join an
account. Covers the high-level flow first, then the technical details with API
call examples.

Related: [DESIGN.md](./DESIGN.md) · [be/openapi.yaml](../be/openapi.yaml) ·
[BE_TECH.md](./BE_TECH.md)

---

## 1. Overview

cocono-chat accounts have **no passwords**. Ownership of an account is proven
cryptographically: each device generates its own Ed25519 key pair, the private
key never leaves the device, and the username becomes yours by being the first
to register it with a key pair signed by that private key.

There are three distinct flows:

| Flow | When | What happens |
| ---- | ---- | ------------ |
| **Signup** | Brand-new account, first device | Device generates keys → `POST /api/signup` → the device becomes the **main** device → login |
| **Login** | Every session, any registered device | Challenge-response: fetch a nonce, sign it, exchange for a JWT |
| **Add device** (multi-device) | Second+ device joining an existing account | New device enrolls → gets a 6-digit pairing code → an existing device approves it → new device logs in |

Key properties:

- **No shared secrets.** The server stores public keys and a transport AES key
  only; it can never impersonate a device or sign on a user's behalf.
- **Every device has its own keys.** No private key is ever transferred between
  devices or to the server.
- **Codes are the trust anchor for multi-device.** Adding a device requires a
  human to enter a 6-digit code shown on the new device into an already-approved
  device — possession of the account's keys is delegated explicitly, one device
  at a time.
- **Replay-proof.** Signed payloads (signup, enrollment) carry a freshness
  timestamp and every accepted signature is de-duplicated server-side, so a
  captured payload can never be reused.
- **Immediate revocation.** JWTs are re-checked against the live device registry
  on every request; a device removed by an admin loses access instantly, not at
  token expiry.

### Sequence diagram — new account

```
 New device (browser)                     Server
 ────────────────────                     ------
 generate Ed25519 + X25519 key pairs
 generate AES-GCM transport key
 sign canonical({a,d,p,t,u,x}) ───►  POST /api/signup
                                    validate + verify signature + replay check
                                    store user + device (main: true)  ──► 201
                                    POST /api/auth/challenge  ◄── {u,d}
                             ◄── nonce n
 sign n ────────────────────────►  POST /api/auth/verify {u,d,n,s}
                             ◄── JWT
 open WebSocket /ws?token=<jwt>  (see MESSAGES.md)
```

### Sequence diagram — adding a device

```
 New device            Server            Existing (approved) device
 ───────────           ──────            ──────────────────────────
 generate own keys
 POST /api/devices/enroll ─►
                       check account exists,
                       device id new, limit not reached,
                       signature valid, not replayed
                       create 6-digit code (TTL 10 min)
 ◄── { code, enrollId }
 show code to user ──────────────────────► user types code into old device
                                                       POST /api/devices/pending
                                         ◄───────────── (what am I approving?)
                                                       POST /api/devices/approve {code}
                       atomically add device (maxDevices guard)
 poll GET /api/devices/enroll-status/:enrollId ...
 ◄── { approved: true }
 normal challenge-response login → JWT
```

---

## 2. Technical details

### 2.1 Identifier and key model

| Symbol | Meaning | Format |
| ------ | ------- | ------ |
| `u` | username | 5–64 chars `[a-zA-Z0-9_-]`, not reserved (`server`, `admin`, `root`, ... — configurable via `RESERVED_USERNAMES`). Normalised to lowercase at signup — the stored and displayed form is always lowercase; uniqueness is on the lowercase form (`ul`). Immutable once set. |
| `d` | device id | client-generated, 8–64 chars `[a-zA-Z0-9_-]`; browsers use `crypto.randomUUID()` |
| `p` | Ed25519 **identity public key** | raw 32 bytes, base64url. Verifies all signed payloads and login nonces |
| `x` | X25519 **key-agreement public key** | raw 32 bytes, base64url. Used to derive pairwise E2EE conversation keys (see [MESSAGES.md](./MESSAGES.md)) |
| `a` | **transport AES-GCM key** | raw 16/24/32 bytes (clients use 256-bit), base64url. Client↔server transport: the same bytes are used locally as AES-GCM `aesEnc` and HMAC-SHA256 `aesMac` (message envelope `h`) |
| `t` | client timestamp | epoch **seconds** at signing time; must be within `SIGNED_PAYLOAD_MAX_AGE_SEC` (default 300 s) of server time |
| `s` | Ed25519 signature | over the UTF-8 bytes of the **canonical JSON** of the signed object |

Conventions that apply to every signed payload:

- **base64url** (RFC 4648 §5, no padding) for all binary material.
- **Canonical JSON** — keys sorted lexicographically, no whitespace. The object
  signed at signup/enroll is `canonical({ a, d, p, t, u, x })` →
  `{"a":…,"d":…,"p":…,"t":…,"u":…,"x":…}`. Implemented identically in
  `be/src/lib/canon.js` and `client/src/encoding.js`.
- **Freshness + replay**: `t` is checked against server time, and the signature
  `s` itself is de-duplicated in Redis (`sigseen:<sha256(s)>`, TTL = 2× the
  freshness window) — a captured payload can be neither re-sent late nor
  replayed verbatim.

Storage (MongoDB `users` collection, per account):

```javascript
{
  u: 'alice', ul: 'alice',            // lowercase display name + lowercase unique key
  devices: [{ id, pub, x, aes, main, createdAt, lastSeenAt }],
  maxDevices: 3,                      // admin-overridable per account (1–1000)
  createdAt,
}
```

### 2.2 Device-side key generation (WebCrypto)

From the client SDK (`client/src/crypto.js`, used by `client.js` register/enroll):

```javascript
const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']); // private key non-exportable
const xPair   = await crypto.subtle.generateKey({ name: 'X25519'  }, false, ['deriveBits']);
const aesTmp  = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']); // exportable ONCE, for shipping to the server

const p = b64u(await crypto.subtle.exportKey('raw', keyPair.publicKey));
const x = b64u(await crypto.subtle.exportKey('raw', xPair.publicKey));
const a = b64u(await crypto.subtle.exportKey('raw', aesTmp));
const d = crypto.randomUUID();
const t = Math.floor(Date.now() / 1000);

const s = await signEd25519(keyPair.privateKey, canonicalJson({ a, d, p, t, u, x }));
```

After the server accepts the payload, the client re-imports `a` as two
**non-exportable** keys (`AES-GCM` for transport encryption, `HMAC-SHA256` for
envelope integrity) and discards the raw bytes. All long-lived key material is
persisted in IndexedDB as `CryptoKey` handles.

### 2.3 Signup — `POST /api/signup`

Creates the account and registers the first device as **main**.

```bash
curl -X POST http://127.0.0.1:3000/api/signup \
  -H 'content-type: application/json' \
  -d '{
    "u": "alice",
    "p": "k7Sb3QKx9d2mVn4rT8uYw1zAe5fGh0jLpQsXcBvN-m",
    "x": "YMyc5f3bV7wqo4m3dS1nB7tKpXhE0gJ2cF9aRdUvW3k",
    "a": "F9r2KjLm8nPqRsT1uVwXyZa3bCdEfGhIjKlMnOpQrS",
    "d": "01234567-89ab-cdef-0123-456789abcdef",
    "t": 1787600000,
    "s": "zYxWvUtSrQpOnMlKjIhGfEdCbAzYxWvUtSrQpOnMlKjIhGfEdCbAzYxWvU-"
  }'
```

Response `201`: `{ "u": "alice" }`

Server-side order of checks (see `be/src/routes/app-routes/signup.js`):

1. Rate limit `rl:signup:<ip>` (default 10 / 15 min).
2. `u` valid + not reserved; `d` valid; `t` fresh.
3. `p` decodes to 32 raw bytes; `x` is a valid 32-byte X25519 key; `a` is
   16/24/32 bytes.
4. Ed25519 verify `s` against `p` over `canonical({a,d,p,t,u,x})` → else 401
   `invalid_signature`.
5. Replay check on `s` → 401 `replay`.
6. Insert into Mongo; unique `ul` index collision → 409 `username_taken`.

Error codes: `invalid_username`, `reserved_username`, `invalid_device_id`,
`stale_payload`, `invalid_public_key`, `invalid_x25519_key`, `invalid_aes_key`,
`invalid_signature`, `replay`, `username_taken`, `rate_limited` (429, with
`Retry-After` header). Errors are always
`{ "error": "<code>", "message": "<human readable>" }`.

### 2.4 Login — challenge-response (any device)

**Step 1 — request a nonce:**

```bash
curl -X POST http://127.0.0.1:3000/api/auth/challenge \
  -H 'content-type: application/json' \
  -d '{ "u": "alice", "d": "01234567-89ab-cdef-0123-456789abcdef" }'
# → { "n": "3fJ9x0Q2wE7rT5yU8iO4pA6sD1gH0kL9mN3bV6cX1zQ" }
```

The nonce is 32 random bytes (base64url), stored in Redis
(`auth:nonce:<n>`, TTL `NONCE_TTL_SEC`, default 5 min) keyed to that
username+device. A nonce is issued for **any** pair — unknown pairs get a nonce
that simply never verifies, so this endpoint cannot be used to enumerate
accounts.

**Step 2 — sign the nonce** (the UTF-8 bytes of the nonce string, not a JSON
object):

```javascript
const s = await signEd25519(identity.priv, n);
```

**Step 3 — verify and receive the JWT:**

```bash
curl -X POST http://127.0.0.1:3000/api/auth/verify \
  -H 'content-type: application/json' \
  -d '{ "u": "alice", "d": "01234567-89ab-cdef-0123-456789abcdef",
        "n": "3fJ9x0Q2wE7rT5yU8iO4pA6sD1gH0kL9mN3bV6cX1zQ",
        "s": "mQ0wE0rT5yU8iO4pA6sD1gH0kL9mN3bV6cX1zQ2wE0rT5yU8iO4pA6sD1gH0kL9mN3bV6cX1zQ2wE0-" }'
# → { "token": "eyJhbGciOiJIUzI1NiIs..." }
```

Details (`be/src/routes/app-routes/auth.js`):

- The server consumes the nonce atomically with `GETDEL` **before** applying
  account rate limits — junk requests without a valid nonce cannot exhaust a
  victim's verify budget. Nonces are single-use; replays of `verify` get 401
  `bad_nonce`.
- Signature is checked against the device's stored `p`; failure → 401
  `bad_signature`.
- On success: `lastSeenAt` is bumped and a JWT (HS256, `JWT_SECRET`) is issued
  with payload `{ sub: ul, u, d, iss, aud, iat, exp }`, lifetime
  `JWT_EXPIRES_IN_SEC` (default 24 h).
- Use as `Authorization: Bearer <token>` on authenticated REST endpoints. Every
  authenticated request re-checks that the token's device is still registered —
  removal by admin = instant access loss.

```bash
curl http://127.0.0.1:3000/api/me -H "authorization: Bearer $TOKEN"
# → { "u": "alice", "d": "01234567-89ab-cdef-0123-456789abcdef", "createdAt": "..." }
```

### 2.5 Multi-device — enrollment + pairing code

All devices on an account authenticate independently with their own keys;
several can be logged in simultaneously. Default max devices per account is
**3** (`MAX_DEVICES`), with per-account admin overrides
(`PATCH /api/admin/users/:username/max-devices`, 1–1000).

#### Step 1 — `POST /api/devices/enroll` (no auth; signed by the NEW device)

Exactly the same payload shape and signature rules as signup — the new device's
own keys, signed by the new device's own private key:

```bash
curl -X POST http://127.0.0.1:3000/api/devices/enroll \
  -H 'content-type: application/json' \
  -d '{ "u": "alice",
        "p": "nT3dQ7wE0rT5yU8iO4pA6sD1gH0kL9mN3bV6cX1zQ",
        "x": "bV6cX1zQ2wE0rT5yU8iO4pA6sD1gH0kL9mN3KjLm8nP",
        "a": "xY1zQ2wE0rT5yU8iO4pA6sD1gH0kL9mN3bV6cX1zQ2w",
        "d": "77a1b2c3-d4e5-4f60-8a9b-0c1d2e3f4a5b",
        "t": 1787600300,
        "s": "0kL9mN3bV6cX1zQ2wE0rT5yU8iO4pA6sD1gH0kL9mN3bV6cX1zQ2wE0rT5yU8iO4pA6sD1gH0kL9mN" }'
# → 201 { "code": "483920", "enrollId": "sU8iO4pA6sD1gH0kL9mN3bV6cX1zQ2", "expiresInSec": 600 }
```

Server behaviour (`be/src/routes/app-routes/devices.js`):

- Validates the account exists (404 `unknown_account`), the device id is new
  (409 `device_exists`), and the cap is not reached (409 `device_limit`), in
  addition to the same key/signature/freshness/replay checks as signup.
- Allocates a **6-digit code** valid for `DEVICE_CODE_TTL_SEC` (default
  600 s = 10 min) in Redis at `denroll:c:<ul>:<code>` (JSON:
  `{ p, x, a, d, enrollId, requestedAt }`). Claimed with `SET NX` and re-drawn
  on collision, so concurrent enrollments on the same account can never
  clobber each other's codes.
- `enrollId` is an unguessable 192-bit random capability (base64url) used for
  polling; the pending marker `denroll:p:<enrollId>` is set with the same TTL.

The new device shows `code` to the user and begins polling.

#### Step 2 — approve on an existing device

The user types the code into an already-registered, logged-in device. To make
social-engineering attacks visible, the UI first asks the server **what** the
code refers to:

```bash
curl -X POST http://127.0.0.1:3000/api/devices/pending \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{ "code": "483920" }'
# → { "d": "77a1b2c3-d4e5-4f60-8a9b-0c1d2e3f4a5b", "requestedAt": "2026-01-15T10:23:00.000Z" }
```

After explicit confirmation:

```bash
curl -X POST http://127.0.0.1:3000/api/devices/approve \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{ "code": "483920" }'
# → { "approved": "77a1b2c3-d4e5-4f60-8a9b-0c1d2e3f4a5b" }
```

- Codes are scoped per account (`denroll:c:<ul>:<code>`) — a code typed at any
  other account simply does not exist there.
- Approval consumes the code atomically with `GETDEL`: single-use, no
  double-approve race.
- The device is pushed into the account with an **atomic guarded update**
  (`devices.id != d` AND `$expr: size(devices) < maxDevices`), so concurrent
  approvals cannot exceed the cap or duplicate a device.
- On success `denroll:p:<enrollId>` is deleted and `denroll:ok:<enrollId>`
  marks approval for the poller.

#### Step 3 — the new device polls and logs in

```bash
# unauthenticated — the enrollId capability is the only credential
curl http://127.0.0.1:3000/api/devices/enroll-status/sU8iO4pA6sD1gH0kL9mN3bV6cX1zQ2
# while pending:  { "approved": false }
# once approved:  { "approved": true }
# expired/never:  410 { "error": "expired", ... }
```

The FE polls every 2 s (per-IP limit is generous: 600/15 min — entropy of the
capability is the real gate). On `approved: true` the device saves its identity
to IndexedDB and runs the normal challenge-response login with its own keys.

### 2.6 Device management — `GET /api/devices`

```bash
curl http://127.0.0.1:3000/api/devices -H "authorization: Bearer $TOKEN"
```

```json
{
  "maxDevices": 3,
  "devices": [
    { "id": "01234567-...", "main": true,  "current": true,  "createdAt": "...", "lastSeenAt": "..." },
    { "id": "77a1b2c3-...", "main": false, "current": false, "createdAt": "...", "lastSeenAt": "..." }
  ]
}
```

Removal is currently an admin operation:
`DELETE /api/admin/users/:username/devices/:deviceId` (refuses to remove the
last device). Because auth is registry-checked, this revokes the device's JWT
immediately. Per DESIGN.md, a non-main device inactive for 14 days should be
removed with its pending messages deleted — that sweep is not yet implemented.

### 2.7 Rate limits & freshness summary

| Endpoint | Bucket(s) | Default |
| -------- | --------- | ------- |
| `POST /api/signup` | per IP | 10 / 15 min |
| `POST /api/auth/challenge` | per IP | 30 / 15 min |
| `POST /api/auth/verify` | per account + per IP | 20 + 20 / 15 min |
| `POST /api/devices/enroll` | per IP | 10 / 15 min |
| `POST /api/devices/pending` / `approve` | per account | 20 / 15 min each |
| `GET /api/devices/enroll-status/:id` | per IP | 600 / 15 min |

All limits are env-configurable (`be/.env.example`); 429 responses carry a
`Retry-After` header. Behind nginx, set `TRUST_PROXY` or all per-IP buckets
collapse into one. Signed-payload freshness window: `SIGNED_PAYLOAD_MAX_AGE_SEC`
(default 300 s). Login nonce TTL: `NONCE_TTL_SEC` (300 s, single-use). Pairing
code TTL: `DEVICE_CODE_TTL_SEC` (600 s, single-use).
