# be — cocono-chat backend

Node.js backend for cocono-chat: a Fastify REST API backed by MongoDB (long-term
persistence) and Redis (nonces, rate limiting; pub/sub fan-out comes with messaging).
It also serves the front end (from `client/app`, with the SDK at `/sdk/`) as static
files, so the whole app runs from one origin.

Current milestone scope: **accounts** — signup, passwordless challenge-response login,
JWT-authenticated REST. WebSockets and messaging arrive in later milestones.

For internals (storage schema, crypto, auth flow details), see
[docs/BE_TECH.md](../docs/BE_TECH.md). The REST API contract is specified in
[openapi.yaml](./openapi.yaml).

## Running

Prerequisites: Node.js ≥ 22.9, pnpm, Redis on `redis://127.0.0.1:6379` (or set
`REDIS_URL`).

From the repo root:

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts the server with auto-reload on file changes. If `MONGO_URL` is set it
uses that database; otherwise it starts a persistent mongodb-memory-server (data in
`be/.data/mongo`, so accounts survive restarts). The app is served at
http://127.0.0.1:3000.

Against a real MongoDB (production-like):

```bash
cp .env.example .env        # then set MONGO_URL, REDIS_URL, JWT_SECRET
pnpm start
```

## Configuration

All settings are environment variables with sensible defaults — see
[.env.example](./.env.example): server port/host, `MONGO_URL`, `REDIS_URL`,
`JWT_SECRET`, token/nonce TTLs, reserved usernames, max devices, and rate limits.

## API

| Method | Path | Purpose |
| ------ | ---- | ------- |
| POST | `/api/signup` | Create an account (+ first device) |
| POST | `/api/auth/challenge` | Get a one-time login nonce |
| POST | `/api/auth/verify` | Verify the signed nonce, receive a JWT |
| GET | `/api/me` | Current account (JWT required) |

Full request/response schemas: [openapi.yaml](./openapi.yaml).

## Admin app

A separate internal web app for operators — list users and their devices, inspect active
rate-limit counters, clear rate limits for an IP, and delete users/devices:

```bash
pnpm admin        # http://127.0.0.1:3001
```

It shares the main server's `.env` (`MONGO_URL`, `REDIS_URL`). It binds to localhost by
default; if you expose it on a network, set `ADMIN_TOKEN` and enter it in the UI.

Pages: **Users** (list + a tabbed side panel: Details, Verification, Badges, Devices,
Traffic, **Shares**, Relationships, Blocked-by), **God View** (the whole social graph —
share-link creations, opened links and messages, generated on demand and stored
server-side; see [docs/SHARES.md](../docs/SHARES.md)), **App** (branding), **Traffic**
(rate-limit search + tuning), **Reports**, **Diagnostics**, **Ops** (backups).

The panel is a no-build static app (`be/admin/`): `index.html` + `app.js` +
`godview.js` + `style.css`, plus the badge artwork served from the client app and the
vendored d3-force modules in `admin/vendor/d3/` (see the README there). Its CSP is
`script-src 'self'`, so nothing may be loaded from a CDN — vendor it instead.

## Tests

```bash
pnpm test
```

Unit and integration tests run on `node:test` against an ephemeral in-memory MongoDB and
the local Redis (database 15). A separate smoke script exercises the full account flow
against a *running* dev server:

```bash
node scripts/verify-e2e.mjs
```
