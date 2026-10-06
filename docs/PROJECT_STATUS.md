# Project Status — 2026-10-06

Living snapshot of where the app stands: what's built, how it's deployed, what is
known-broken or deliberately unsafe, and what's next. Keep this file current when
milestones, security posture, or ops change. The [README](../README.md) Status
section links here.

## Milestones

| # | Milestone | State |
|---|---|---|
| 1 | Accounts (passwordless, Ed25519, lowercase usernames) | ✅ done |
| 2 | Multi-device (pairing codes, device detach, removal cascades) | ✅ done |
| 3 | 1:1 messages (E2EE, store-and-forward, retention + resync) | ✅ done |
| 4 | Files / media | ⬜ next |
| 5 | Groups (offline delivery) | ⬜ planned |
| 6 | PWA polish (install, push, offline shell) | ✅ done |
| 7 | Subgroups / tags | ⬜ planned |

## What's built (highlights since the base milestones)

- **TLS**: native HTTPS/WSS via Let's Encrypt (DNS-01 against EuroDNS for
  `dev.co.co.no`, acme.sh renewal cron). No reverse proxy; `be/.env` holds cert
  paths + `JWT_SECRET` + `ADMIN_TOKEN` + VAPID keys.
- **Passkeys / PRF: REMOVED as a dead end.** iOS WebKit gives web apps no
  WebAuthn PRF (as of iOS 26), so sealed-identity-by-passkey was replaced by
  the **local-seal (format 4)** fallback: on iOS, identity keys are exported
  transiently, AES-GCM-wrapped under a device-derived key, stored as plain
  bytes (the bug it fixes: iOS corrupts persisted non-extractable CryptoKey
  handles — v2 records rot on reload). v2 (handles) remains the desktop path.
  v3 record reading still exists for compatibility.
- **Device removal**: removing an account from a browser detaches the device
  server-side too; detaching the LAST device **deletes the account** (no
  orphan rows, username released). Settings drawer has per-device remove.
- **Diagnostics**: in-app ring buffer (`cocono-sw` IDB) + server-stored
  reports (`diagnostics` collection, 30-day TTL) + admin panel section with
  copy/delete/'un-limit IP'. Admin 'clear limits for IP' sweeps all
  IP-scoped limiters (registry-driven).
- **Notifications (PWA)**: blind push only (event type + padding; never
  content/usernames cross FCM/APNs). Rich text locally: worker silent-resumes,
  opens a peek-only WS session (never pulls), decrypts, one banner per event
  (shown-latch; manual close-and-replace for WebKit). `presence` frame:
  blurred/hidden clients release presence instantly so **background = OS
  push**; focused app shows in-app pills; the focused chat marks read.
  Live-receive self-heals stale peer-key caches (refresh-and-retry +
  `peerIdentityChanged` pill). iOS requires Add-to-Home-Screen for any push.
- **Offline shell**: network-first SW caching of statics; app boots offline
  into read-only mode from IndexedDB (login failure w/ network error enters
  the app); online event promotes to live session.
- **Versioning**: `/api/app-info` returns name + VAPID + git sha (30s TTL);
  sidebar footer badge; diagnostics compare page vs server build.
- **Storage scoping**: per-account IndexedDB (identity records keyed
  `identity:<ul>` + `current` pointer; `cocono-app:<ul>` message DB), no
  cross-account bleed; 'remove account' wipes local data.

## Security posture — honest list

### Currently UNSAFE by design (dev-only)
- **Open registration on a LAN-reachable host.** `HOST=0.0.0.0` + any
  internet client can create accounts (rate-limited signup per IP only).
  Before real use: registration allowlist / invite gate, or bind to LAN-only.
- **Admin panel**: loopback-only (`127.0.0.1:3001`) + `ADMIN_TOKEN`, but no
  HTTPS for admin (tunnel via SSH). Never expose `ADMIN_HOST` beyond loopback
  without a TLS story.

### Known gaps / TODO
- **No account recovery.** Losing all devices' local identities = account
  gone (removing the last device now deletes it outright). Recovery kit +
  server-side sealed key backup is the next security milestone; until then
  every destructive flow (last-device removal, forget) is irreversible —
  confirmed via danger modals.
- **Trust-on-first-use only.** Peer key changes (re-created account, new
  device) are surfaced as a pill (`peerIdentityChanged`), but there are no
  safety numbers / explicit key confirmation yet.
- **Push privacy**: payloads are blind + padded, but push *timing* leaks
  message-arrival metadata to the push service (accepted trade-off).
- **v2 desktop identities**: CryptoKey handle storage is robust on
  Chrome/Firefox, but a WebKit desktop (Safari on macOS) can rot like iOS.
  Consider forcing local-seal on all WebKit.
- **MongoDB is single-instance, unauthenticated (loopback only).** Nightly
  dumps exist; no replica/HA.
- **Message retention**: pulled copies live ≤30 days server-side (E2EE
  envelopes; metadata visible to server). Sender copy deletion is local-only.
- VAPID subject/private key live in `be/.env` (0600, uncommitted) — rotate if
  the box is ever shared.

## Deployment & ops (the devbox: 192.168.1.84, user `mike`)

- **systemd user units** (linger enabled, so they survive logout):
  - `cocono-mongo.service` — MongoDB 7 on `127.0.0.1:27018`, data
    `be/.data/mongo`, log `~/.local/share/mongodb/log/mongod-27018.log`
  - `cocono-redis.service` — rootless redis build in `~/.local` (liblzf
    wrapper), `127.0.0.1:6379`
  - `cocono-be.service` — `pnpm dev` (watch mode, in-memory-Mongo fallback
    NOT used since MONGO_URL is set in .env), HTTPS on :443
  - `cocono-admin.service` — admin panel on `127.0.0.1:3001`
- **Updating the deployment**: edit files (or push to `origin/master`), then
  `git pull --ff-only && pnpm install` on the box; the `--watch` process
  restarts on `be/` changes automatically. Static FE/SDK files are read per
  request. There is currently NO `update.sh` and NO backup cron — see
  "Next up" (ops trio). Test entry points: `pnpm test`, `pnpm test:client`,
  `pnpm test:all`.
- **DNS**: `dev.co.co.no` → 192.168.1.84 (EuroDNS hosts the zone; `co.no` is
  a CoDNS-operated public suffix — passkey-style grouping quirks on Apple
  came from there). Cert: LE via acme.sh DNS-01, cron renewal ~60d.
- **CI**: none yet (proposed in Next up).
- **Test suite**: backend `pnpm test` (54), client `pnpm test:client` (26),
  `pnpm test:all` for both. Client suite runs the real backend in-process.

## Test-maintenance lessons (baked into the suites)

- **WS connect race**: clients may answer `hello` before the connect handler
  finishes async setup — frames were dropped by the listenerless emitter.
  The connect path queues early frames; do not move `socket.on('message')`
  attachment after any `await`. (Root-caused via stress loops: 0/16 after.)
- **Ack path discipline**: notification/push work must stay fire-and-forget
  AFTER the ack is queued (a `redis.exists` once caused ack-jitter flakes).
- Node's test runner doesn't inherit `--test-concurrency=1` when a single
  file is run directly — pass it explicitly in manual one-file runs.
- FE has no DOM tests; `client/test/graph.test.js` guards: every browser/SDK
  module parses + every relative import resolves (caught two shipped
  worker-blocking bugs; extend it when adding app-root classic scripts).
- Workers: NO localStorage (spec), NO dynamic `import()`, `importScripts`
  only during evaluation — all worker persistence goes through IndexedDB
  (`cocono-sw`: kv + log stores).

## Next up (agreed order)

1. **Ops trio — NOT DONE YET, despite how tidy the section above looks**:
   `update.sh` (pull → install → test → restart), backup cron
   (hourly `mongodump`, daily repo bundle), GitHub Actions CI (Node 22 +
   redis, both suites). No build step exists (client is unbundled ES
   modules; there is no `dist/`).
2. **Backup & recovery** milestone (recovery kit, sealed-key backup, maybe
   safety numbers) — the biggest security hole.
3. M4 files/media (DESIGN.md sketch exists).
4. M5 groups, then M7 subgroups/tags.
5. Small backlog: registration invite gate, offline outbox (queue unsent
   messages), per-conversation mute, admin over TLS, v2→v4 migration prompt
   for macOS Safari users, notification click-routing to specific chats.
