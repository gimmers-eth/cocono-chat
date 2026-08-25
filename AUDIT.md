# Security Audit — cocono-chat

- **Date:** 2026-08-25
- **Scope:** Full manual source review of the current codebase (milestones 1–2: accounts +
  multi-device): backend (`be/src/`), admin app (`be/src/admin.js`, `be/admin/`), frontend
  (`fe/`), configuration (`be/src/config.js`, `be/.env.example`), and dependency state
  (`pnpm audit`). WebSocket/messaging layers do not exist yet and are out of scope.
- **Method:** Line-by-line review of auth/crypto/routes/config code, cross-checked against
  DESIGN.md and the OpenAPI spec; `pnpm audit` for dependency advisories; empirical probing
  of router/gate behavior with `app.inject()` (Fastify's router decodes percent-encoded
  paths while `request.url` stays raw — confirmed with find-my-way 9.9.0 sources and a
  live probe).

## Severity legend

| Severity | Meaning |
| -------- | ------- |
| **High** | Exploitable with serious impact (auth bypass, account takeover, secret disclosure) |
| **Medium** | Real risk with preconditions, or a defense-in-depth gap worth fixing before production |
| **Low** | Hardening, hygiene, or minor issues |

## Summary

| ID | Severity | Finding |
| -- | -------- | ------- |
| [H1](#h1--admin-token-gate-bypassed-by-percent-encoded-paths-verified) | High | Admin token gate bypassed by percent-encoded paths (**verified empirically**) |
| [H2](#h2--jwt-falls-back-to-a-hardcoded-dev-secret) | High | JWT falls back to a hardcoded dev secret |
| [H3](#h3--vulnerable-fastifystatic-path-traversal-advisories) | High | Vulnerable `@fastify/static@8.3.0` (4 advisories incl. path traversal) |
| [H4](#h4--no-session-revocation--removed-devices-keep-access) | High | No session revocation — removed devices keep access up to 24h |
| [M1](#m1--targeted-login-dos-via-verify-rate-limit-exhaustion) | Medium | Targeted login DoS via verify rate-limit exhaustion |
| [M2](#m2--per-ip-rate-limiting-collapses-behind-the-production-proxy) | Medium | Per-IP rate limiting collapses behind the production proxy (`trustProxy` unset) |
| [M3](#m3--raw-aes-key-bytes-persisted-in-indexeddb) | Medium | Raw AES key bytes persisted in IndexedDB |
| [M4](#m4--no-security-headers-csp-etc) | Medium | No security headers (CSP etc.) |
| [M5](#m5--enrollid-capability-leaks-into-server-logs) | Medium | `enrollId` capability leaks into server logs |
| [M6](#m6--signed-payloads-have-no-freshness-replayable) | Medium | Signed payloads have no freshness (replayable) |
| [M7](#m7--admin-api-fails-open-without-admin_token) | Medium | Admin API fails open without `ADMIN_TOKEN` |
| [L1](#l1--accountdevice-enumeration) | Low | Account/device enumeration |
| [L2](#l2--rate-limiter-increxpire-race) | Low | Rate limiter INCR/EXPIRE race |
| [L3](#l3--unbounded-usernames--unvalidated-rate-limit-key-subjects) | Low | Unbounded usernames + unvalidated rate-limit key subjects |
| [L4](#l4--pairing-code-collision-overwrites-a-pending-enrollment) | Low | Pairing-code collision overwrites a pending enrollment |
| [L5](#l5--admin-rate-limit-tooling-misses-milestone-2-limits) | Low | Admin rate-limit tooling misses milestone-2 limits |
| [L6](#l6--device-approval-ux-is-a-social-engineering-surface) | Low | Device-approval UX is a social-engineering surface |
| [L7](#l7--tokens-in-browser-storage-readable-by-xss) | Low | Tokens in browser storage readable by XSS |
| [L8](#l8--jwt-hardening-gaps) | Low | JWT hardening gaps |
| [L9](#l9--account-deletion-leaves-stale-redis-state) | Low | Account deletion leaves stale Redis state |

---

## High

### H1 — Admin token gate bypassed by percent-encoded paths (verified)

**Location:** `be/src/admin.js:17-21`

The admin app gates its API with an `onRequest` hook that checks the **raw** request URL:

```javascript
if (!request.url.startsWith('/api/')) return;
if (request.headers['x-admin-token'] !== config.adminToken) { /* 401 */ }
```

Fastify's router (find-my-way) percent-decodes the path **before** route matching, while
`request.url` keeps the raw form. A request whose first path segment is encoded therefore
reaches an `/api/...` handler without ever triggering the gate.

**Verified empirically** against a replica of the gate with find-my-way 9.9.0
(fastify 5.x):

```text
GET /api/admin/users            -> 401 unauthorized        (gate works)
GET /%61pi/admin/users          -> 200 <handler data>      (BYPASS — no token sent)
GET /api/admin/users + token    -> 200                     (control)
```

**Impact:** When the admin port is reachable by an attacker (non-loopback `ADMIN_HOST`,
container port mapping, exposed tunnel), **all** admin endpoints — delete any account,
remove devices, clear rate limits — are accessible without the token, even when
`ADMIN_TOKEN` is set.

**Fix:**
- Gate on the matched route, not the raw URL: check `request.routeOptions.url` (or
  register the auth hook inside the `app.register(adminRoutes, ...)` scope so it only
  applies to those routes), and
- run the admin app behind the same hardening as [M7](#m7--admin-api-fails-open-without-admin_token).

### H2 — JWT falls back to a hardcoded dev secret

**Location:** `be/src/config.js:24` (`jwtSecret: env.JWT_SECRET ?? 'dev-secret-change-me'`)

If `JWT_SECRET` is unset, the server silently uses `'dev-secret-change-me'` (a
`console.warn` at startup is the only signal). Anyone who can reach the server can then
mint valid HS256 JWTs for **any** account and device (`{ sub, u, d }`) and use every
authenticated endpoint (`/api/me`, `/api/devices`, `/api/devices/approve`).

**Impact:** Full account takeover of every account when deployed without the env var.

**Fix:**
- Refuse to boot when the secret is the dev default (or shorter than a sane minimum),
  unless an explicit `NODE_ENV=development`-style opt-out is set. Tests inject config
  overrides, so they are unaffected.
- Document secret generation (e.g. `openssl rand -base64 48`) in `.env.example` / README.

### H3 — Vulnerable `@fastify/static` (path-traversal advisories)

**Location:** `be/package.json` (`@fastify/static: ^8.0.0`), locked at **8.3.0**

`pnpm audit` reports **4 advisories, all on `@fastify/static@8.3.0`**:

| Advisory | Severity | Fixed in | Issue |
| -------- | -------- | -------- | ----- |
| GHSA-83w8-p2f5-377r | high | ≥10.1.1 | Route-guard bypass via path traversal |
| GHSA-x428-ghpx-8j92 | moderate | ≥9.1.1 | Route-guard bypass via encoded path separators |
| GHSA-pr96-94w5-mx2h | moderate | ≥9.1.1 | Path traversal in directory listing |
| GHSA-8pvw-jcv7-9cmj | moderate | ≥10.1.2 | Authorization bypass via non-canonical URL paths |

Both static registrations are exposed:

- **Main app** (`be/src/app.js`): serves `fe/`; `be/.env` (JWT secret, Mongo/Redis URLs,
  admin token) is one directory up — traversal that escapes the static root can reach it.
- **Admin app** (`be/src/admin.js`): serves `be/admin/`; `be/.env` is directly adjacent.

**Impact:** Potential disclosure of `be/.env` (→ JWT forgery, admin token, store
credentials) from the public port, depending on advisory mechanics.

**Fix:** Upgrade to `@fastify/static >= 10.1.2` (fixes all four; verify Fastify v5 peer
compatibility, run the test suite). Note that only ≥10.1.2 covers GHSA-8pvw-jcv7-9cmj.
Add `pnpm audit` to CI.

### H4 — No session revocation — removed devices keep access

**Locations:** `be/src/routes/shared.js` (`requireAuth`), `be/src/app.js:11-17`
(bearer hook), `be/src/routes/admin-routes/users.js` (device removal)

JWTs are stateless bearer tokens valid for `JWT_EXPIRES_IN_SEC` (default **24h**), and no
authenticated endpoint re-checks that `request.auth.d` is still a registered device on
the account. `requireAuth` only checks the token signature/expiry.

**Impact:**
- Admin-removing a device (`DELETE /api/admin/users/:username/devices/:deviceId`) does
  **not** revoke anything: the removed device's existing token keeps working on
  `/api/me`, `/api/devices`, and — notably — `/api/devices/approve`, so a compromised or
  stolen device can approve further devices for up to 24h after removal.
- There is no logout/revocation mechanism at all (FE "Log out" only drops its own copy).

**Fix (pick/combine):**
- Cheap: authenticated handlers already `users.findOne({ ul })` — additionally verify
  `user.devices.some(dev => dev.id === request.auth.d)` and reject otherwise.
- Better: keep a per-account device-revocation marker in Redis (checked in the onRequest
  hook), or shorten expiry and add a refresh flow. This becomes critical once messaging
  (milestone 3+) trusts the JWT on WebSockets.

---

## Medium

### M1 — Targeted login DoS via verify rate-limit exhaustion

**Location:** `be/src/routes/app-routes/auth.js:37-40`

The per-account counter `rl:verify:<ul>` is incremented **before** the nonce is checked,
and `/api/auth/verify` is unauthenticated. An attacker who knows a username can send 20
junk verify requests and exhaust the victim's budget (default 20/15 min), after which the
victim's legitimate logins receive `429` for up to 15 minutes. Repeatable indefinitely.

**Fix:** Validate/consume the nonce first and only count attempts that presented a valid
nonce; and/or add a per-IP budget for verify; and/or issue a short-lived signed attempt
token at challenge time that verify must present (then only challenge throughput limits
attackers, which is already per-IP).

### M2 — Per-IP rate limiting collapses behind the production proxy

**Location:** `be/src/app.js` (Fastify built without `trustProxy`); DESIGN.md deploys
nginx in front

Without `trustProxy`, `request.ip` behind nginx is the proxy's address for **every**
client. All IP-scoped limits (signup, challenge, device-enroll) then share one bucket:
a handful of requests from anywhere trip the limit for **all** users, while a distributed
attacker is equally "limited" — the protection inverts into self-DoS.

**Fix:** Set `trustProxy` appropriately for the deployment (e.g. the proxy hop(s)) and
document that nginx must forward `X-Forwarded-For`. Verify that `request.ip` reflects
real client IPs in staging.

### M3 — Raw AES key bytes persisted in IndexedDB

**Locations:** `fe/js/app.js:95-101` (signup) and `fe/js/app.js:265-267` (enroll) save
`aesRaw` into the identity record; `fe/js/db.js:28`

DESIGN.md and `fe/README_TECH.md` both state the AES key is re-imported as
**non-exportable** and the raw bytes are discarded ("the CryptoKey handles are the only
copies"). The code contradicts this: the raw base64url key bytes are stored in IndexedDB
and never read back after the initial import (login uses only the Ed25519 key + token).

**Impact:** Extractable transport-key material sits in IndexedDB indefinitely; any XSS
(see [M4](#m4--no-security-headers-csp-etc)) or same-origin compromise reads it directly.

**Fix:** Drop `aesRaw` from both `saveIdentity` calls (and from the stored record shape /
docs). Nothing consumes it after `importAesKeys()`.

### M4 — No security headers (CSP, etc.)

**Locations:** `be/src/app.js`, `be/src/admin.js` (fastify-static registered with no
headers)

Neither the FE nor the admin panel sends `Content-Security-Policy`,
`X-Content-Type-Options`, frame-protection, or `Referrer-Policy`. The FE holds key
material and session tokens, and the admin UI keeps the admin token in localStorage —
XSS in either context is maximally damaging, and CSP is the standard second line of
defense. The app is fully same-origin, so a strict CSP is cheap:

```text
content-security-policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'
x-content-type-options: nosniff
referrer-policy: no-referrer
```

(Admin panel uses a `<style>` block → `'unsafe-inline'` for styles, or move to a file.)

### M5 — `enrollId` capability leaks into server logs

**Location:** `be/src/routes/app-routes/devices.js` (`GET /api/devices/enroll-status/:enrollId`)

The enroll-status design relies on `enrollId` being an unguessable 192-bit capability.
But it travels in the URL path, and Fastify's default request logger logs the URL on
"request completed". Every poll writes the capability to stdout/log storage, weakening
the capability model whenever logs are collected, shipped, or shared.

**Fix:** Redact that path in the logger, or accept the `enrollId` via a header/POST body
instead of the URL. (Also note the endpoint has no rate limit — it is unauthenticated;
low risk given the entropy, but worth a generous limiter.)

### M6 — Signed payloads have no freshness (replayable)

**Locations:** `be/src/routes/app-routes/signup.js`, `be/src/routes/app-routes/devices.js`
(signed object is `canonical({ a, d, p, u })`)

Signup/enroll signatures carry no nonce or timestamp, so a captured payload is valid
forever. Impact is limited today (signup is first-writer-wins; enroll replay only spawns
more pending codes, rate-limited per IP), but once milestone 3+ adds signed key-rotation
and message envelopes, replayable signed payloads become a direct threat.

**Fix:** Include server-issued freshness (e.g. bind signup/enroll to a challenge nonce,
or add a client timestamp the server validates within a short window and de-duplicates).
Decide before the message envelope is frozen.

### M7 — Admin API fails open without `ADMIN_TOKEN`

**Location:** `be/src/admin.js:16-21`

When `ADMIN_TOKEN` is empty the auth hook is **not registered at all**: user deletion,
device removal, and rate-limit clearing are open to anyone who can reach the admin port.
The 127.0.0.1 default bind mitigates local dev, but one misconfiguration
(`ADMIN_HOST=0.0.0.0`, Docker port mapping, an exposed tunnel) turns this into an
unauthenticated admin API. Secondary issues at the same spot:

- Token comparison uses `!==` (not constant-time) — timing leakage.
- No rate limiting on failed tokens — online brute force if the token is weak.

**Fix:** Fail closed — require `ADMIN_TOKEN` to start (or refuse non-loopback binds
without it); compare with `crypto.timingSafeEqual`; rate-limit auth failures.

---

## Low

### L1 — Account/device enumeration

`/api/auth/challenge` returns `404 unknown_account` vs a nonce; `/api/signup` returns
`409 username_taken`; `/api/devices/enroll` returns `404` for unknown accounts. These
let an attacker enumerate existing usernames and (username, device) pairs. Per-IP rate
limits slow this down but do not stop a distributed probe. Consider uniform responses
(e.g. challenge always succeeds but returns a nonce that will never verify for unknown
accounts/devices) once usernames become privacy-sensitive.

### L2 — Rate limiter INCR/EXPIRE race

**Location:** `be/src/lib/rateLimit.js:3-4`

`INCR` then `EXPIRE` on first hit: a crash between the two leaves the key with **no
TTL**, permanently rate-limiting that subject. Use a single atomic operation
(`SET key 1 NX EX window` + a separate counter, or a Lua script / `INCR` + check
`EXPIRE`'s result).

### L3 — Unbounded usernames + unvalidated rate-limit key subjects

- `USERNAME_RE` (`be/src/lib/username.js`) has **no upper bound**; only the FE enforces
  `maxlength="64"`. Server-side, a username up to the ~1MB body limit can be stored and
  echoed back. Cap at 64 chars.
- `/api/auth/verify` builds `rl:verify:<u>` from the raw request value **before** any
  validation or existence check, so unauthenticated attackers can create unbounded
  distinct Redis keys (each TTL'd, but unbounded in number) with arbitrary characters.
  Validate format (and ideally account existence) before keying rate limits.

### L4 — Pairing-code collision overwrites a pending enrollment

**Location:** `be/src/routes/app-routes/devices.js` (enroll `redis.set` of
`denroll:c:<ul>:<code>`)

Two enrollments on the same account can draw the same 6-digit code; the second `SET`
silently overwrites the first pending enrollment — the first device stalls until TTL.
Use `SET ... NX` and re-draw on collision, or key by `enrollId` with a code→enrollId
index.

### L5 — Admin rate-limit tooling misses milestone-2 limits

**Location:** `be/src/routes/admin-routes/rateLimits.js`

- `{ ip }` clear deletes only `rl:signup:<ip>` and `rl:challenge:<ip>`, not
  `rl:denroll:<ip>`.
- `LIMIT_META` has no `denroll`/`dapprove` entries, so those counters are filtered out of
  `GET /api/admin/rate-limits`.

Support can neither see nor clear device-enrollment limits. Add the missing entries.

### L6 — Device-approval UX is a social-engineering surface

Anyone can start an enrollment against any existing account (it only proves nothing).
The approval gate is the user typing a 6-digit code — and the FE shows no details about
*what* they are approving. An attacker can present their own code to the victim
("approve this for me?"). Show the pending request's device id + request time in the
approve UI and require explicit confirmation; consider listing pending enrollments.

### L7 — Tokens in browser storage readable by XSS

Session JWT in `sessionStorage` (`fe/js/app.js` `setToken`), admin token in
`localStorage` (`be/admin/app.js`). Standard for token-based apps, but combined with
[M4](#m4--no-security-headers-csp-etc) any XSS exfiltrates them. CSP plus keeping the FE
XSS-free (it currently only uses `textContent`; the admin UI escapes all interpolations)
is the mitigation.

### L8 — JWT hardening gaps

**Location:** `be/src/lib/jwt.js`

No `iss`/`aud`/`jti` claims; 24h expiry with no revocation story (see
[H4](#h4--no-session-revocation--removed-devices-keep-access)). Fine for a
single-service MVP; add `iss`/`aud` checks before any second consumer of the token
appears (WebSocket layer in milestone 3 should re-verify, not just trust the header).

### L9 — Account deletion leaves stale Redis state

**Location:** `be/src/routes/admin-routes/users.js`

Deleting an account does not clean up its nonces (`auth:nonce:*`), pending enrollments
(`denroll:*`), or rate-limit counters. Harmless (they expire via TTL and all consumers
check the account exists), but tidy-up avoids confusion in the admin rate-limit view.

---

## Production deployment checklist

From DESIGN.md's deployment model (nginx TLS termination, pm2, self-hosted):

1. **TLS everywhere** — the app speaks plaintext HTTP by design (nginx terminates TLS).
   Tokens and signed payloads traverse the wire; never expose without TLS. Add HSTS at
   the proxy.
2. **`JWT_SECRET`** — long random value (see [H2](#h2--jwt-falls-back-to-a-hardcoded-dev-secret)).
3. **`ADMIN_TOKEN`** — always set, even on "internal" hosts; keep the admin port on
   loopback (see [M7](#m7--admin-api-fails-open-without-admin_token),
   [H1](#h1--admin-token-gate-bypassed-by-percent-encoded-paths-verified)).
4. **MongoDB / Redis** — auth + TLS + bind to private interfaces (both run
   unauthenticated by default; Redis additionally holds pending-enrollment AES keys and
   login nonces in plaintext).
5. **`trustProxy`** — configure before deploying behind nginx
   (see [M2](#m2--per-ip-rate-limiting-collapses-behind-the-production-proxy)).
6. **`pnpm audit` in CI** — dependency advisories regressed unnoticed
   (see [H3](#h3--vulnerable-fastifystatic-path-traversal-advisories)).

## What's already done well

- **JWT verification is sound:** `timingSafeEqual` MAC comparison, header pinned to the
  exact HS256 header (no `alg` substitution / `none` confusion), expiry enforced.
- **Login nonces:** 256-bit random, atomic single-use consumption via `GETDEL`, TTL'd —
  replays rejected (and regression-tested in `be/test/accounts.test.js`).
- **Race-safe writes:** unique index on `ul` handles concurrent signups; device approval
  uses an atomic `$push` guarded by `$expr` size check against `maxDevices`; pairing codes
  are per-account scoped, single-use via `GETDEL` (cross-account approval tested).
- **Strict input validation:** key lengths, charsets, base64url alphabet all checked
  server-side; the `enrollId` capability is 192-bit random.
- **Key hygiene in responses:** `/api/devices` and the admin user listing never expose
  `pub`/`aes` key material.
- **No DOM XSS surface in the FE** (only `textContent`); admin UI escapes every
  interpolated value.
- **Secrets hygiene:** `.env` gitignored (only `.env.example` committed); Mongo URL
  redacted in dev logs.
- **Rate limits exist on every sensitive endpoint** with `Retry-After`, and the test
  suite exercises replay, single-use, scoping, and limiting behavior.
