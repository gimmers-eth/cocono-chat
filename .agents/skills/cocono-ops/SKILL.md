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

## Deploy flow after updates

`cocono-be` runs under `node --watch`: edits to **`be/` sources restart it
automatically**; static FE/SDK files (`client/app`, `client/src`) are read per
request and need NO restart. Use a manual restart only when: watch got stuck
in a crash loop, env/config changed, deps changed, or you want a clean
known-good bounce.

When pulling from `origin/master` (or after committing locally):

```bash
cd /home/mike/cocono-chat
git pull --ff-only
pnpm install                # only if lockfile changed (safe to run anyway)
pnpm test:all               # 54 backend + 27 client tests; fix BEFORE restarting
systemctl --user restart cocono-be
sleep 2 && systemctl --user is-active cocono-be
curl -s https://dev.co.co.no/api/app-info | head -c 200   # verify new sha is served
```

## Gotchas

- Tests need local Redis (up as `cocono-redis`); the backend test suite boots
  its own in-process Mongo fallback, dev uses `MONGO_URL` from `be/.env`.
- Changing `JWT_SECRET` in `be/.env` **drops every session** (tokens are
  re-validated against it) - clients must log in again. Fine on dev, a
  documented launch-day runbook item otherwise.
- TLS certs renew via an acme.sh cron (DNS-01/EuroDNS, ~60 d). If HTTPS fails:
  `journalctl --user -u cocono-be | grep -i cert` and check the acme.sh cron
  log before touching anything.
- There is **no `update.sh` and no backup cron yet** (tracked as the "ops
  trio" in `docs/PROJECT_STATUS.md`) - do the steps above by hand and keep
  this skill as the canonical checklist.
- Never restart services as a *system* service - these are user units:
  always `systemctl --user ...` (running plain `systemctl status cocono-be`
  finds nothing and is misleading).
