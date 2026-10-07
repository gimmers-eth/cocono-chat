# Project Status — 2026-10-06

Living snapshot of where the app stands: what's built, how it's deployed, what is
known-broken or deliberately unsafe, and what's next. Keep this file current when
milestones, security posture, or ops change. The [README](../README.md) Status
section links here.

**Docs layout (since 2026-10-06):** every document lives in `docs/`
(`DESIGN/QUESTIONS/ANSWERS/PROJECT_STATUS/CLIENT_SDK/MESSAGES/SIGNUP/
BE_TECH/THEMES/GO_LIVE_PROCESS`, audits in `docs/audits/`). Only
`README.md` files stay beside code (root + `be/`, `client/`) and
they point into `docs/`. The legacy `fe/` PWA and its
`FE_LEGACY_TECH.md` doc were **deleted 2026-10-06** — `client/app`
is the only FE (audits mentioning `fe/` are historical).

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
- **Ops panel (admin)**: `~/backups/status/*.json` (written by backup.sh,
  backup-drill.sh, restore.sh AND update.sh via EXIT traps) + log tail +
  archive list are surfaced at `/api/admin/ops` (be/src/routes/admin-routes
  /ops.js) with buttons for Backup now / Box bundle / Test-a-backup (drill)
  / typed-confirmation PROD RESTORE. All four ops scripts share ONE flock
  (`~/backups/.ops.lock`, pid hint in `.ops.pid`) — timers, panel buttons and
  manual runs are mutually EXCLUSIVE (de-bounced: a busy lock makes the
  script skip silently instead of racing). Restore is double-gated (typed
  'RESTORE' in UI + API + script confirmation + existence & name-pattern
  check of the archive).
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
- **Two receive-path bugs found & fixed (Oct 6)**: (a) stale peer-key cache
  stranded live messages while push decoded fine (refresh-and-retry, b564b7a);
  (b) the transport blindly reconnected on 4401, so a dead session made an
  OPEN app silently deaf while push (fresh silent-login per event) kept
  working — "decodes when closed, not when open" — 4401/4403 are now
  permanent: token dropped, authFailed surfaced as a re-login prompt (3c6120d).
- **Push coalescing (wake-up flood fix)**: Windows Chrome often defers
  real-time delivery when fully closed — FCM queues the pushes and replays them as a
  burst on next start (symptom: 'nothing while closed, many at once when
  opened'). Layers: (1) Redis NX gate = one push per **(device,
  conversation)** per `PUSH_COALESCE_SEC` (90) while offline — messages in
  OTHER chats still notify, and a device reconnect (backlog delivered over
  the live WS) **clears all its gates**, so the next offline message always
  notifies. (An over-aggressive per-device gate that never reset on
  reconnect caused a 'notifications mostly missing' regression — fixed by
  design, not tuning.); (2) `TTL` (`PUSH_TTL_SEC`, 6 h) + RFC 8030
  per-conversation **`Topic`** (hashed sender — cleartext usernames never
  reach the push service) so the push service collapses backlog per chat;
  (3) the worker batches a replayed burst (2 s window → one login, one peek,
  one notification with '+N more'); (4) in-app banners treat messages within
  3 s of WS 'open' as catch-up (list + dots cover them, no pill storm).
- **Notification content by attention state (open-vs-closed fix)**: the
  open app pulls messages instantly, so a push fired while blurred always
  found an EMPTY queue at peek time and fell back to the content-less
  generic banner ('shows no message when open, works when closed'). Now:
  focused → in-app pill; open-but-unfocused → the PAGE shows the rich OS
  notification via `registration.showNotification` (`notifyOS` in chat.js,
  same tag → bursts replace into the latest); closed → worker peek finds
  the still-queued copy and shows rich. The worker now STAYS SILENT on an
  empty queue (the page owns that copy; generic-on-empty would only
  downgrade the visible notification) — generic remains only for genuine
  failures (login/peek errors, budget timeout).
- **Friends (one-way trust)**: users can mark accounts as trusted. Server is
  the SOURCE OF TRUTH (`/api/me/friends` GET/PUT/DELETE, be/.../friends.js:
  validation, self/unknown rejected, `FRIENDS_MAX` cap 500, rate-limited).
  Devices mirror into per-account IndexedDB (`friends` store, DB v2) and
  sync LIVE via E2EE system messages — the acting device broadcasts
  `{"sys":"friend+/-","ul"}` to its OWN account over the normal relay path
  (server can't read/forge it); app-level filter keeps sys payloads out of
  the transcript. New/offline devices reconcile with `listFriends()` at app
  entry (main.js). UI: non-friend chat shows a red `user-xmark` warning
  strip + menu status; menu actions `user-shield` add / `user-minus` remove;
  **friends persist in the sidebar with zero messages** (list merges
  messages ∪ friends — clearing a chat never unfriends anyone).
- **Icons: Font Awesome 7 Free** — vendored (not CDN: CSP `default-src
  'self'` + offline shell). `client/app/vendor/fontawesome/{css,webfonts}`
  (+ LICENSE.txt). Single config `client/app/js/icons.js` (ICONS map +
  iconEl + applyIcons); static markup uses `data-icon="<key>"` placeholders
  filled at boot; NO glyph/emoji characters remain in components, no
  innerHTML. SW caches `/vendor/` (shell v4). serve-test asserts css+woff2
  are delivered with right content types.
- **Offline shell**: network-first SW caching of statics; app boots offline
  into read-only mode from IndexedDB (login failure w/ network error enters
  the app); online event promotes to live session.
- **Versioning**: `/api/app-info` returns name + VAPID + git sha (30s TTL);
  sidebar footer badge; diagnostics compare page vs server build.
- **Message actions (local, modal-based)**: tapping/clicking a bubble opens a
  **message modal** — full text in a scrollable area, actions fixed underneath:
  📋 Copy (clipboard w/ execCommand fallback), ➦ Forward (dialog, sends the
  plaintext via the normal E2EE path) and 🗑 Delete (this device only).
  Username inputs (forward dialog AND sidebar 'New chat') surface **local
  users** — message-store peers via `store.knownPeers()` — in suggestion lists
  (`components/peers.js`) that filter while typing; tapping one forwards /
  opens directly. No server contact.
  Header ⋮ opens a **chat-options modal** with **Clear messages** (whole
  conversation, this device only, confirm-guarded); report/block will join
  there later. Modals (not dropdown/focus classes) on purpose: an early
  in-bubble actions design was killed by the click-triggered catchUp
  re-render wiping the focus state mid-gesture — overlay DOM survives
  render(). Store: `deleteMessage(id)` + `clearMessages(peer)` in
  `client/app/js/store.js`.
- **Storage scoping**: per-account IndexedDB (identity records keyed
  `identity:<ul>` + `current` pointer; `cocono-app:<ul>` message DB), no
  cross-account bleed; 'remove account' wipes local data.

## Public launch

The sequenced path from this state to a public service — phases, gates,
cold-box drill, launch-day and post-launch schedule — lives in
**[GO_LIVE_PROCESS.md](./GO_LIVE_PROCESS.md)**. The P0 table below is the
input to it; keep both in sync when items close.

## Security posture — target: PUBLIC app

The end-state is a public, internet-facing messaging service. Controls below are
**verified in code** (2026-10-06); gaps are graded P0 = must fix before public
launch, P1 = strongly before/soon after, P2 = roadmap.

### Controls in place today (verified)
- **Transport**: native TLS (Let's Encrypt via DNS-01, acme.sh auto-renew), HTTPS+WSS only;
  Mongo + Redis bind loopback; admin binds loopback.
- **CSP** on every response (`be/src/routes/shared.js`): `default-src 'self'`, no
  `unsafe-inline` anywhere, `frame-ancestors 'none'`, `base-uri 'self'`; plus
  `nosniff`, `referrer-policy: no-referrer`. Client code uses **no innerHTML**
  (admin does — custom escaping, loopback-only surface).
- **Auth model**: passwordless Ed25519 device signatures; signup/enroll payloads have
  freshness windows + **signature replay dedup**; JWT bearer (24 h) re-validated on
  every request **against the live device registry** → detaching a device or deleting
  the account kills its tokens instantly; no cookies ⇒ no CSRF surface.
- **E2EE**: per-device-pair conversation keys (X25519 → HKDF → AES-GCM); relay
  envelopes carry an HMAC keyed with the sender's transport key → the server cannot
  forge or replay into a recipient; push payloads are **blind + padded** (event type
  only; content/usernames never cross FCM/APNs).
- **Enumeration care**: auth challenge always returns a nonce (no existence oracle);
  peer key lookup requires a JWT. (Signup *does* reveal taken usernames — inherent to
  username systems, accepted.)
- **Rate limiting** matrix across signup/challenge/verify/enroll/msg/userKeys/diag
  (env-tunable, per-IP + per-account layers; live sizes in `be/src/config.js`).
- **Logs redact** WS tokens and enrollment capability URLs.
- **Storage isolation**: per-account IndexedDB + identity records; removal detaches
  server-side and wipes local data; last-device removal deletes the account (no orphans).
- **Admin**: token-gated (constant-time compare + failed-attempt throttle), scoped to
  its own routes (percent-encoding bypass fixed), loopback-bound, message/redis state
  cleanup on deletes, limiter registry + per-IP clear.
- **Diagnostics**: size-capped, IP+account limited, 30-day TTL; SW failures self-report
  for fleet debugging without devtools.

### Threat sketch (who can see what)
| Adversary | Gets |
|---|---|
| Server operator | **metadata** (who↔whom, timing, sizes, IPs, UAs, push endpoints, retained E2EE envelopes) — never plaintext |
| Network MITM | nothing (TLS 1.3, valid cert) |
| Push services (Google/Apple/Mozilla) | padded blind blob + timing |
| XSS on our origin | that device\'s session incl. message store (v4\'s local wrap is **domain separation, not an XSS boundary**) ⇒ CSP strictness is load-bearing |
| Stolen locked device | OS data protection (passcode); keys sealed on iOS |
| Logged-in stolen device | full access by design — remote detach from another device is the mitigation |

### P0 — blockers before public launch
1. **Registration abuse gate.** 10 signups/h/IP only stops naive scripts; a public
   app needs invite codes / CAPTCHA / proof-of-work — else: botnet squatting, storage
   squatting, push spam.
2. **Queue DoS (unbounded storage).** Never-pulled message copies are retained
   **forever** (by design for store-and-forward): mass-register garbage accounts +
   spam = unbounded Mongo growth. Fix: per-recipient queue caps + queue-age policy.
3. **`TRUST_PROXY` before any CDN/proxy.** Without it every rate limiter and ban
   collapses onto the CDN\'s single IP (the .env comment warns; now it bites). Decide
   direct-expose vs Cloudflare and set hops accordingly.
4. **HSTS** missing on the HTTPS origin (one header line; also consider preload later).
5. **Backups + secrets.** Backup jobs are LIVE: age-encrypted hourly data +
   daily box bundles, weekly automatic restore drill (first full drill
   PASSED incl. real app boot from restored data). Current posture:
   **on-box only** (`RCLONE_DEST` unset; age identity on the box for
   unattended drills). Accepted for the dev box — **public launch requires
   off-box encrypted copies**: set `RCLONE_DEST`, move the identity off-box
   (recipient-only config remains).
6. **Abuse tooling.** No contact **block/report** exists — a public messenger without
   one is a support fire. (FE-side block = hide + drop-queued? needs small protocol
   thought: unsolicited E2EE messages can\'t be server-filtered by content, but the
   server CAN refuse delivery to a recipient who blocked a sender — cheap protocol add.)
7. **Content policy surface**: username reserved-list exists; no profanity/hate
   filter (E2EE ⇒ only usernames + metadata are policed; document it plainly).

### P1 — strongly recommended
- WS upgrade **origin allowlist** (defence-in-depth; tokens are the real gate).
- **Mongo auth + Redis requirepass** even on loopback (one box-compromise away from
  total leak); app creds per-purpose.
- Dependency audit: **in CI** (`pnpm audit --audit-level=high` blocks;
  Dependabot weekly grouped bumps + monthly actions) — done 2026-10-07.
- Rate-limit rebaseline for internet scale + **per-device** msg caps (CGNAT/office
  shared-IP false positives — verify-ip already bumped to 50 for that reason).
- **Safety numbers / explicit key-change verification** (pill exists; verification UI
  does not — TOFU-only today; `peerIdentityChanged` is the hook).
- JWT: add rotation runbook (swap `JWT_SECRET` ⇒ all sessions drop; acceptable, document
  it), later consider per-device key derivation of tokens.
- Decide publicly-exposed metadata honestly: `/api/app-info` reveals build sha + VAPID
  (harmless/useful); keep.

### P2 — roadmap (security-adjacent)
- Recovery kit + sealed key backup (fixes "lost device = lost account" AND gives an
  audited recovery path instead of hostage UX).
- Media (M4): encrypted thumbnails, size/quota policy, virus-scan-on-upload is
  pointless pre-decryption — client-side only.
- Groups (M5): sender-key distribution = biggest new attack surface; plan a review.
- Key transparency-ish peer directory (make stale-key MITM detectable across devices).

### Accepted today (dev/LAN only — revisit at launch)
open registration · 24 h JWTs with no server-side session list (device registry IS the
revocation) · unsigned-but-loopback DBs · admin without TLS · v2-handle rot risk on
macOS Safari (v4 migration prompt pending) · push timing metadata.

### Security-relevant test coverage (current)
replay dedup · envelope HMAC/sender-mismatch/unknown-recipient · auth flow happy+evil
(challenge indistinguishability) · device detach revocation (H4) · removal cascade
· admin clear-by-ip sweeps · graph parse test (blocks shipped worker syntax bugs).

## Deployment & ops (the devbox: 192.168.1.84, user `mike`)

- **systemd user units** (linger enabled, so they survive logout):
  - `cocono-mongo.service` — MongoDB 7 on `127.0.0.1:27018`, data
    `be/.data/mongo`, log `~/.local/share/mongodb/log/mongod-27018.log`
  - `cocono-redis.service` — rootless redis build in `~/.local` (liblzf
    wrapper), `127.0.0.1:6379`
  - `cocono-be.service` — `pnpm dev` (watch mode, in-memory-Mongo fallback
    NOT used since MONGO_URL is set in .env), HTTPS on :443
  - `cocono-admin.service` — admin panel on `127.0.0.1:3001`
- **Updating the deployment**: use **`./update.sh`** (ops trio #1, done) —
  fetch → fast-forward → install-if-manifest-changed → **full test gate
  (auto-revert on failure)** → known-good bounce of `cocono-be` (plus
  `cocono-admin` when `be/` changed) → verify `/api/app-info` serves the
  deployed sha. `--dry-run` shows the plan. The `--watch` process still
  restarts on `be/` edits during interactive development; static FE/SDK
  files are read per request. There is still NO backup cron — see "Next up"
  (ops trio). Test entry points: `pnpm test`, `pnpm test:client`,
  `pnpm test:all` (update.sh runs the gate for you).
- **DNS**: `dev.co.co.no` → 192.168.1.84 (EuroDNS hosts the zone; `co.no` is
  a CoDNS-operated public suffix — passkey-style grouping quirks on Apple
  came from there). Cert: LE via acme.sh DNS-01, cron renewal ~60d.
- **CI**: GitHub Actions `ci.yml` (test matrix Node 22/24 + redis service,
  frozen-lockfile install, blocking high-audit; Dependabot configured).
  Green checks prove the sha; `update.sh` remains the local deploy gate.
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

1. **Ops trio — ALL 3 DONE**:
   ✅ `update.sh` (pull → install → test-gate with auto-rollback → restart
   → verify served sha; `--dry-run` supported).
   ✅ **backup trio (LIVE, local-only)**: `ops/backup.sh hourly|daily`
   (mongodump + redis RDB / box bundle of `.env`+acme.sh+units → age
   encrypted, tmpfs staging only, mirror `~/backups/{hourly,daily}`,
   retention 24/14), `ops/backup-drill.sh` (weekly automatic: decrypt →
   throwaway mongo :27019 + redis :6380 → count checks; `--full` also boots
   the real app on :3100 from the backup — first run PASSED incl. full leg),
   `ops/restore.sh` (typed-confirmation prod restore). Dev-box decision
   2026-10-07: **backups stay on-box** (age identity lives here so drills
   are unattended; encryption guards files, NOT a full-box compromise).
   rclone off-box sync is implemented — set `RCLONE_DEST` in
   `~/.config/cocono-backup.conf` when a second box/B2 exists (required
   before public launch).
   ✅ **CI**: `.github/workflows/ci.yml` — every push to master/PR: test
   matrix (Node 22.x + 24.x, redis:7-alpine service, pnpm pinned 12.4.2,
   cached pnpm store + mongodb-memory-server binaries; `--frozen-lockfile`
   also proves lockfile↔manifest sync) + a blocking
   `pnpm audit --audit-level=high` job. `.github/dependabot.yml` set up.
   Landed with a side fix: the pnpm-12 `allowBuilds` entry in
   pnpm-workspace.yaml had an unfilled placeholder (frozen installs would
   fail anywhere); `pnpm update` then cleared all 15 advisories
   (fast-uri, brace-expansion, fastify transitives) to ZERO within
   existing ranges — both suites green after.
2. **Public-launch P0 list** (see Security posture): registration gate, queue
   caps, TRUST_PROXY/CDN decision, HSTS, encrypted backups, block/report.
3. M4 files/media (DESIGN.md sketch exists).
4. M5 groups, then M7 subgroups/tags.
5. Small backlog: registration invite gate, offline outbox (queue unsent
   messages), per-conversation mute, admin over TLS, v2→v4 migration prompt
   for macOS Safari users. (Done: notification click now routes to the
   sender's chat — postMessage when a window exists, `pendingchat` IDB
   hand-off + delete-on-read consume on cold boot.)
