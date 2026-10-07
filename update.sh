#!/usr/bin/env bash
# cocono-chat deploy script (ops trio #1 — see docs/PROJECT_STATUS.md).
#
#   ./update.sh [--dry-run]
#
# Flow: fetch -> fast-forward -> install (only if manifests changed) ->
# FULL test gate -> known-good service bounce -> verify the served build
# sha via /api/app-info. If the tests fail, HEAD is reset back to the
# pre-deploy commit — node --watch then bounces the service back too.
#
# Assumes it runs on the devbox as the service user (systemd --user units,
# repo at $PWD, be/.env in place). The service code itself is this checkout:
# statics are read per request and cocono-be runs --watch, so deploying is
# exactly 'move HEAD, gated by tests'.
set -euo pipefail
export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"

# Locate the repo: run from anywhere inside it, or from the script's dir.
if ! cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" 2>/dev/null \
   || [ ! -d .git ] || [ ! -f package.json ]; then
  cd "$(dirname "$0")"
fi
[ -d .git ] && [ -f package.json ] || { echo "[update] ERROR: not inside the cocono-chat repo" >&2; exit 1; }

BRANCH=${BRANCH:-master}
REMOTE=${REMOTE:-origin}
APP_INFO_URL=${APP_INFO_URL:-https://dev.co.co.no/api/app-info}

log() { printf '\033[1;32m[update]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[update]\033[0m ERROR: %s\n' "$*" >&2; exit 1; }

# One deploy at a time (two concurrent scripts would fight over HEAD).
exec 9>update.lock
flock -n 9 || die "another update.sh is already running"

DRY_RUN=${1:-}
[ -z "$DRY_RUN" ] || [ "$DRY_RUN" = "--dry-run" ] || die "usage: $0 [--dry-run]"

log "fetching $REMOTE/$BRANCH"
git fetch "$REMOTE" "$BRANCH" || die "git fetch failed"

# Move HEAD only from a clean tree (untracked stuff like be/.data is fine).
git diff --quiet && git diff --cached --quiet \
  || die "uncommitted changes — commit or stash first (deploys only move committed history)"

OLD=$(git rev-parse HEAD)
NEW=$(git rev-parse "$REMOTE/$BRANCH")
if [ "$OLD" = "$NEW" ]; then
  log "already at ${OLD:0:7} — nothing to do"
  exit 0
fi
CHANGED=$(git diff --name-only "$OLD" "$NEW")
log "deploying ${OLD:0:7} -> ${NEW:0:7}"
printf '%s\n' "$CHANGED" | sed 's/^/   | /'
if [ "$DRY_RUN" = "--dry-run" ]; then log "dry-run: stopping here"; exit 0; fi

git merge --ff-only "$REMOTE/$BRANCH" \
  || { git merge --abort 2>/dev/null || true; die "not a fast-forward (history diverged?) — resolve manually"; }

# ---- dependencies (only when a manifest actually changed) ----
if printf '%s\n' "$CHANGED" | grep -qE '(^|/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$'; then
  log "manifest changes — pnpm install"
  pnpm install
else
  log "no manifest changes — skipping install"
fi

# ---- THE GATE: full suites before declaring the deploy good ----
# NOTE: node --watch may already have bounced cocono-be on the checkout.
# If tests fail we reset and watch bounces straight back to last-known-good.
if ! pnpm test:all; then
  log "!! tests failed — rolling back ${NEW:0:7} -> ${OLD:0:7}"
  git reset --hard "$OLD"
  die "deployment REVERTED to ${OLD:0:7}; fix forward and re-run"
fi

# ---- known-good bounce ----
log "restarting cocono-be (clean restart, drops WS sessions briefly)"
systemctl --user restart cocono-be
if printf '%s\n' "$CHANGED" | grep -q '^be/'; then
  log "be/ changed — restarting cocono-admin too"
  systemctl --user restart cocono-admin
fi
systemctl --user is-active --quiet cocono-be \
  || die "cocono-be did not come back: journalctl --user -u cocono-be -n 50"

# ---- verify: the server must SERVE the commit we just deployed ----
# app-info reports `git log -1 --format=%h` (30 s TTL cache) — poll briefly.
EXPECT=$(git log -1 --format=%h)
SERVED=""
for _ in $(seq 1 12); do
  SERVED=$(curl -sf --max-time 5 "$APP_INFO_URL" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log((JSON.parse(s).version||"").split(" ")[0])}catch{console.log("")}})' || true)
  [ "$SERVED" = "$EXPECT" ] && break
  sleep 3
done
[ "$SERVED" = "$EXPECT" ] \
  || die "app-info serves '${SERVED:-nothing}', expected '$EXPECT' — check curl $APP_INFO_URL and journalctl --user -u cocono-be"

log "✅ deployed $EXPECT — tests green, services active, app-info agrees"
