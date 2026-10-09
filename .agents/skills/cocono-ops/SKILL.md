---
name: cocono-ops
description: Operate the cocono-chat devbox services - check status and logs, restart the backend/admin, and run the post-update deploy flow (git pull, pnpm install, test, restart). Use when asked whether the app/server is running, to inspect server logs, to restart something, or after code changes are committed/pulled on the devbox.
---

# cocono-chat operations (devbox)

Everything runs as **systemd user units** (linger is enabled, so they survive
logout). The box is `devbox` (192.168.1.84), repo at `/home/mike/cocono-chat`,
app exposed at `https://dev.co.co.no` (native TLS :443).

## The units

| Unit | Runs | Notes |
|---|---|---|
| `cocono-mongo.service` | MongoDB 7 on `127.0.0.1:27018` | data `be/.data/mongo`, log `~/.local/share/mongodb/log/mongod-27018.log` |
| `cocono-redis.service` | Redis on `127.0.0.1:6379` | rootless build under `~/.local` |
| `cocono-be.service` | the app server | `pnpm dev` from repo root = `node --watch src/dev.js` in `be/`, reads `be/.env` (TLS paths, `JWT_SECRET`, `ADMIN_TOKEN`, VAPID) |
| `cocono-admin.service` | admin panel | `pnpm admin`, loopback `127.0.0.1:3001` only |

Unit files: `~/.config/systemd/user/cocono-*.service`.

## Status & logs

```bash
systemctl --user list-units 'cocono*' --all      # all four in one view
systemctl --user is-active cocono-be             # quick single check
journalctl --user -u cocono-be -n 100 --no-pager # recent server logs (JSON lines; WS tokens redacted)
journalctl --user -u cocono-be --since '-10 min' | grep -i push   # e.g. push outcomes
tail -n 100 ~/.local/share/mongodb/log/mongod-27018.log           # mongo keeps its own log file
```

Sanity check the app answers (also proves TLS):

```bash
curl -s https://dev.co.co.no/api/app-info        # name + build sha + VAPID (30 s TTL cache)
curl -s http://127.0.0.1:3001/ -o /dev/null -w '%{http_code}\n'   # admin up (loopback)
```

## Restarting

```bash
systemctl --user restart cocono-be        # app server (kills WS sessions; clients reconnect)
systemctl --user restart cocono-admin     # admin panel
systemctl --user restart cocono-mongo cocono-redis   # databases - only when really needed
systemctl --user daemon-reload            # after EDITING a unit file, then restart
```

A `cocono-be` restart is invisible to users beyond a brief WS reconnect, but
**restart mongo/redis loses in-flight state** (queues live in Redis!) - prefer
letting them run.

## Wiping all user data (dev reset)

`./ops/wipe-data.sh` — DRY RUNS by default; actually wipes only with the
literal argument `confirm`:

```bash
./ops/wipe-data.sh            # show what would drop (collection + doc counts)
./ops/wipe-data.sh confirm    # backup -> drop -> flush -> restart
```

It takes a fresh `ops/backup.sh hourly` first (aborts the wipe if the backup
fails — restore would be `ops/restore.sh <archive>`), then drops **every
auto-discovered Mongo collection** except the script's `KEEP` list,
`FLUSHDB`s only the app's Redis db (never FLUSHALL — db 15 is the test
suite's), and restarts `cocono-be` + `cocono-admin`.
The `settings` collection survives as a collection but is PRUNED BY DOC:
only `KEEP_DOCS` ids (currently just `branding`) remain. User-keyed config
(`limits` per-user/per-device overrides) and the rate-limit kill switch
(`traffic`) are wiped back to defaults — a wiped box must never stay
un-throttled, and user-keyed config IS user data.

MAINTENANCE CONTRACT (update as we add features): new features that store
per-user data in Mongo/Redis are covered automatically — **no script edit
needed** — because collections are auto-discovered, settings docs default to
wiped, and the whole app Redis DB is flushed. Edit `KEEP` only when a NEW
collection is NOT user data and must survive; add a `KEEP_DOCS` id only for
durable app config inside `settings`. Client-side state
(IndexedDB transcripts/identities in users' browsers) is NOT reachable from
here — the wiped server simply refuses old identities and devices re-pair.

## Fake traffic / fake users (dev only)

`./ops/fake-users.sh [--count N] [--types a,b] [--fresh] [--keep-limits] [--list]`
— generates scenario accounts through the REAL SDK/API (keys live in memory
only): `normal`, `verified` (admin flag), `friendly` (pairs that mutually
add/verify/trust + exchange live E2EE messages), `diagnostic` (report pile),
`ratelimited` (account limiters seeded spent), `ipratelimited` / `ipflapper`
(TEST-NET egress IPs + live counters, visible via the user panel's
"search rate limits" link). At least 1 of every scenario always; usernames
are `<prefix>-N`. The run flips the server-wide **kill switch** off and back
on itself (settings `{_id:'traffic'}`, admin Traffic page toggle) — never
leave it off by hand unless you mean to.

New scenarios: drop a `FakeUserType` subclass in `ops/fake-users/types/` and
add it to `TYPES` in `index.mjs`. Seeded limiter state is indistinguishable
from earned state on the Traffic page — that is the point.

## Deploying updates

**Use `./update.sh`** — it IS the deploy flow: fetch → fast-forward →
`pnpm install` (only if manifests changed) → **full test gate** (on failure
it resets HEAD back to the pre-deploy commit and exits) → restart
`cocono-be` (+ `cocono-admin` when `be/` changed) → verify `/api/app-info`
serves the deployed sha. `./update.sh --dry-run` shows the plan without
acting. It refuses to run with uncommitted changes or a diverged history —
commit/stash or resolve first.

Static FE/SDK files (`client/app`, `client/src`) are read per request and
need NO restart. **Do NOT trust `node --watch` for `be/` sources**: it has
been observed to silently stop restarting its child after a while (2026-10
incident: server code was ~15 min stale, a new required-field check never
went live, and blocks were accepted without reasons while tests said the
route was correct). After ANY `be/` change: `systemctl --user restart
cocono-be` (and `cocono-admin` when `be/` touched admin routes), then
confirm freshness — compare `ps -ef | grep src/dev.js` child start time
against the edited files' mtimes (`stat -c %y …`); the child must be NEWER
than the code it should be running. update.sh does this bounce itself.

## Backups (ops trio #2 — LIVE, local-only)

- Scripts: `ops/backup.sh hourly|daily` (mongodump + redis RDB / box bundle
  of `.env` + acme.sh + units; **always age-encrypted**, staging only in
  tmpfs, local mirror `~/backups`, rclone copy off-box IF `RCLONE_DEST` is
  set, retention 24 hourly / 14 daily).
- Timers (enabled): `cocono-backup.timer` (hourly),
  `cocono-backup-daily.timer` (~02:30), `cocono-backup-drill.timer`
  (Sun ~04:15 automatic drill; manual deeper proof:
  `ops/backup-drill.sh --full` boots the real app on :3100 from the
  backup). Check: `systemctl --user list-timers 'cocono-*'`.
- Posture (dev box decision 2026-10-07): backups stay **on-box**,
  `~/backups/{hourly,daily}`; age identity is on-box
  (`~/.config/cocono-backup/identity.age`, needed for unattended drills) —
  encryption guards the files, not a full-box compromise. Before public
  launch: set `RCLONE_DEST` + move the identity off-box.
- Status/log: `~/backups/last-run.json`, `~/backups/backup.log`,
  `journalctl --user -u cocono-backup -a`.
- **Admin panel Ops section** (127.0.0.1:3001): per-job result table
  (update/hourly/daily/drill/restore from `~/backups/status/*.json`), log
  tail, archive list, buttons for Backup now / Box bundle / Drill /
  PROD Restore (typed 'RESTORE' required).
- De-bounce: ALL ops scripts share one flock
  (`~/backups/.ops.lock`; live run marker `~/backups/.ops.pid`) — timers,
  admin buttons and manual runs never overlap; a blocked run skips
  silently (exit 0) so the next scheduled tick carries on.
- Restore (panic button): `ops/restore.sh <archive>` — typed 'RESTORE'
  confirmation; overwrites prod data with the backup state.


- Tests need local Redis (up as `cocono-redis`); the backend test suite boots
  its own in-process Mongo fallback, dev uses `MONGO_URL` from `be/.env`.
- Changing `JWT_SECRET` in `be/.env` **drops every session** (tokens are
  re-validated against it) - clients must log in again. Fine on dev, a
  documented launch-day runbook item otherwise.
- TLS certs renew via an acme.sh cron (DNS-01/EuroDNS, ~60 d). If HTTPS fails:
  `journalctl --user -u cocono-be | grep -i cert` and check the acme.sh cron
  log before touching anything.
- There is **no backup cron yet** (ops trio #2) and **no CI yet** (ops trio
  #3) — `update.sh` covers deploys; keep this skill as the canonical ops
  reference for the rest.
- Never restart services as a *system* service - these are user units:
  always `systemctl --user ...` (running plain `systemctl status cocono-be`
  finds nothing and is misleading).

## UI conventions (any client/admin styling change)
- **Think about spacing before declaring done.** Every new element gets checked against its container's existing rhythm: alignment (centered bar → centered contents), gaps/padding on the same rem scale already used there, and symmetric breathing room when an element adds a line. Trailing/inline crowding (a button hugging the last word, mixed px/rem margins, uneven top-vs-bottom space) is a bug, not a detail.
- Prefer the **existing local pattern** (icon `margin-right: .45em`, bar padding `rem`, `gap` in flex rows) over inventing per-component magic numbers; if the pattern breaks for the new case, state why in a comment.
- Buttons inside text bars/strips (e.g. trust-warning actions): **own line, centered, `width: max-content`** with a clear top margin (`margin: .6rem auto .15rem`-style) — never an inline tail on flowing text.
- When touching drawer/modal headers with multiple actions: group them (`display:inline-flex; gap:6px`) so icon buttons share one rhythm.
- After a UI change, sanity-check the visual result (render the page or re-read the composed CSS/markup) — spacing is only "done" when it looks consistent with its neighbors.
