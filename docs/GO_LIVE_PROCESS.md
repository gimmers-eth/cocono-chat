# Go-Live Process

The runbook for taking cocono-chat from the dev box to a public,
internet-facing service. It exists because the security posture in
[PROJECT_STATUS.md](./PROJECT_STATUS.md) is explicitly **"do not expose this
app to the internet with P0 items open"** — this document is the ordered path
to close that gap. Read PROJECT_STATUS first; this file turns it into
sequenced steps, owners and checks.

**Definition of ready:** a stranger can register, chat, receive push
notifications, and abuse-resist controls hold; one operator can restore the
service from an off-box backup on a clean machine without losing usernames.

---

## Phase 0 — Prerequisites (engineering, weeks)

Gate: every item below merged, CI green (`ci.yml` matrix + blocking
high-severity audit), deployed to the dev box via `./update.sh` and exercised
in real use for at least a week.

### P0 blockers (from PROJECT_STATUS — all must be CLOSED)

1. **Registration abuse gate** — invite codes (recommended for launch:
   controlled growth + no third-party CAPTCHA privacy leak), or CAPTCHA/PoW.
   Must also cover the push-spam vector (rate per new account, warm-up).
2. **Queue storage caps** — per-recipient pending-queue cap + queue-age
   policy so "never-pulled" copies cannot grow Mongo without bound. Decide
   and document the behaviour when a queue is full (reject with error to the
   sender; sender's copy stays in their local store).
3. **Block + report tooling** — server-side refusal to deliver from a
   blocked sender (cheap protocol add; the E2EE blind-relay contract is
   unaffected), report flow feeding the admin panel (diagnostics pipeline
   already exists as a pattern). UI slots already reserved: chat ⋮ menu →
   chat-options modal.
4. **HSTS** on the HTTPS origin (one header line in `routes/shared.js`;
   includeSubDomains after it has proven out; consider preload later).
5. **TRUST_PROXY / edge decision** — direct expose vs Cloudflare (see Phase
   1); whatever is chosen, set `TRUST_PROXY` to the real hop count so rate
   limiters and bans key on true client IPs.
6. **Off-box encrypted backups** — set `RCLONE_DEST` in
   `~/.config/cocono-backup.conf`, move the age identity OFF the box (keep a
   recipient-only config on it), run `ops/backup-drill.sh --full` green, and
   perform one **cold-box restore drill** (Phase 2 dress rehearsal counts).

### P1 strongly-before-launch (close or formally accept each with a date)

- WS upgrade **origin allowlist**.
- **Mongo auth + Redis requirepass** (even loopback-together is one box
  compromise from total leak); per-purpose app creds.
- Rate-limit **rebaseline for internet scale** + per-device msg caps
  (shared-CGNAT false positives).
- **Safety numbers / key-change verification UI** (`peerIdentityChanged`
  event is the existing hook; TOFU-only is not acceptable at scale).
- JWT rotation runbook (swap `JWT_SECRET` ⇒ all sessions drop; document +
  rehearse).

### Content policy (surface it honestly)

E2EE means only **usernames + metadata** are policeable. Write the two
sentences into the app (signup footer) and the future site: we cannot see or
filter message content; we police usernames (reserved list exists),
registration (invite gate), and delivery (block/report).

## Phase 1 — Production infrastructure (days)

The dev box has been the deployment; production should be a distinct,
hardened environment. Decide **A vs B** before anything else:

- **A. Direct expose** (current model, scaled): public IP, native TLS, no
  proxy. `TRUST_PROXY=false`. Simplest; you own DDoS surface.
- **B. CDN in front** (Cloudflare etc.): TLS to the edge, origin keeps
  native TLS or plain loopback; **set `TRUST_PROXY` to the exact hop
  count** — leaving it wrong collapses every limiter onto one CDN IP (P0
  #3). Push services still talk to origin? Web Push endpoints are
  push-service→origin direct; a CDN does not intercept them.

Steps (either choice):

1. Provision the box (Ubuntu, Node ≥ 22.9, pnpm 12.x — pin via CI parity;
   no other toolchain needed: there is no build step).
2. Install the systemd **system** units (not user units; or keep user units
   with linger as on devbox — document which) mirroring
   `cocono-{mongo,redis,be,admin}.service`; bind Mongo/Redis to loopback.
3. DNS + acme.sh DNS-01 (the devbox cron pattern transfers 1:1); cert paths
   into `be/.env` alongside `JWT_SECRET` (fresh `openssl rand -base64 48`),
   `ADMIN_TOKEN` (new), VAPID keys (regenerate per `be/.env.example`).
4. Restore the **box bundle** backup onto it (`ops/restore.sh` equivalent
   for config) — or provision secrets fresh; never copy `.env` in plaintext.
5. `update.sh` clone for the prod checkout (parameterise host/URL; it is
   deliberately devbox-hardcoded today — generalize it here).
6. Bind **admin to loopback only**; access via SSH tunnel (P1: admin over
   TLS later, still not public).
7. Firewall: only 443 (+ SSH, rate-limited/fail2ban) inbound; `ulimit -n`
   check per DESIGN.md; fail2ban or equivalent for SSH before an invite code
   is worth squatting.

## Phase 2 — Dress rehearsal (one day, recorded)

1. Point a staging hostname at the prod box; run a full `./update.sh` deploy
   to it.
2. **Cold-box drill**: on a spare machine/VM, from ONLY the off-box age
   archives (`ops/restore.sh <archive> --yes` flow), bring the service up and
   verify: existing account logs in from a second device, history resyncs,
   a push arrives on a closed app. Note timing (RTO) and gaps in the drill
   log — that is the incident runbook's first draft.
3. Abuse smoke pass: scripted registration attempts hit the invite gate;
   queue caps reject; block drops delivery; report lands in admin.
4. Check the launch-critical telemetry exists and is looked at:
   `~/backups/status/*`, admin Ops panel, `[push]` log outcomes, app-info sha.

Gate to proceed: rehearsal green + P0 table in PROJECT_STATUS shows no
open items + sign-off recorded below this line (date, who).

## Phase 3 — Launch day

1. Freeze merges; final `./update.sh` to prod from the CI-green sha.
2. Enable HSTS (already deployed header; confirm via
   `curl -sI https://… | grep -i strict-transport`).
3. Open registration (invite codes issued at chosen pace — recommend
   friends-and-family wave first: one week of real use before links).
4. Monitor for the first 72 h: rate-limit hits in admin (false-positive
   tuning), `[push]` outcomes, queue depths, disk growth vs projections.
5. Announce with the honest privacy lines (content policy + "server knows
   who-talks-to-whom metadata, never content").

## Phase 4 — Post-launch (schedule, not wishes)

- **Weekly**: restore drill is automatic (`cocono-backup-drill.timer`);
  a human eyeballs `~/backups/status/` + admin Ops monthly.
- **Continuing**: Dependabot PRs triaged ≤1 week (CI gates them); P2 roadmap
  (recovery kit, media, groups review, key transparency) only after P1
  backlog is closed or accepted.
- **Never**: expose admin publicly; never run `JWT_SECRET` rotation and a
  deploy in the same window; never merge to master with CI red (branch
  protection when PR flow starts).

## Rollback

Deploy history IS git: `git reset --hard <last-good-sha>` on the prod
checkout (mirror of `update.sh`'s test-gate rollback) + service bounce; data
rollback = `ops/restore.sh <pre-incident archive>` — which is why the drill
in Phase 0.6 is non-negotiable. Record every rollback as an incident note in
docs/audits/.

---

*Standing risks accepted at launch (see PROJECT_STATUS threat sketch):
metadata visibility to the operator, push-timing metadata, XSS-on-origin =
that device's session, remote-access = full access (mitigated by detach UI),
24 h JWTs without a server session list (device registry IS revocation).*
