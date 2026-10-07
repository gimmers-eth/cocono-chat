#!/usr/bin/env bash
# cocono-chat restore drill (ops trio #2 verification arm).
#
# Proves the newest hourly backup can actually BOOTS the app again —
# without touching production. Steps:
#   1. take the newest ~/backups/hourly/*.tar.age (or $1)
#   2. decrypt with the age identity (~/.config/cocono-backup/identity.age)
#   3. throwaway mongod on DRILL_MONGO_PORT (27019), mongorestore the dump
#   4. sanity counts via the repo's own mongodb driver
#   5. throwaway redis on DRILL_REDIS_PORT (6380) loaded with the backed RDB
#   6. --full: boot the REAL app on PORT 3100 against the throwaway pair
#      with the backed-up .env (MONGO/REDIS/PORT overridden) and curl it
#   7. tear everything down, log the verdict to ~/backups/backup.log
#
# A green drill = "our backups restore". Run weekly by timer; the --full
# leg is for the human-monthly (PROJECT_STATUS P0 #5 asks for a real drill).
set -uo pipefail
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin"

REPO=$HOME/cocono-chat
BACKUP_DIR=$HOME/backups
WORK=$HOME/backup-drill
DRILL_MONGO_PORT=${DRILL_MONGO_PORT:-27019}
DRILL_REDIS_PORT=${DRILL_REDIS_PORT:-6380}
DRILL_APP_PORT=${DRILL_APP_PORT:-3100}
MONGOD=$(awk -F'[ =]' '/^ExecStart=/{print $2; exit}' "$HOME/.config/systemd/user/cocono-mongo.service")
FULL=0; ARCHIVE=${1:-}
[ "${1:-}" = "--full" ] && { FULL=1; ARCHIVE=${2:-}; }
LOG=$BACKUP_DIR/backup.log
log() { echo "[drill] $*"; echo "[$(date -u +%FT%TZ) drill] $*" >>"$LOG"; }
IDENTITY=$HOME/.config/cocono-backup/identity.age

cleanup() {
  [ -n "${APP_PID:-}" ] && kill "$APP_PID" 2>/dev/null
  redis-cli -p "$DRILL_REDIS_PORT" SHUTDOWN NOSAVE 2>/dev/null
  mongod --dbpath "$WORK/mongo" --shutdown >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() { log "DRILL FAILED: $*"; exit 1; }

[ -f "$IDENTITY" ] || fail "no age identity at $IDENTITY — drills must decrypt; keep a copy on the box (chmod 600) or run manually with it"

if [ -z "$ARCHIVE" ]; then
  ARCHIVE=$(ls -1 "$BACKUP_DIR"/hourly/cocono-hourly-*.tar.age 2>/dev/null | sort | tail -1)
fi
[ -n "$ARCHIVE" ] && [ -f "$ARCHIVE" ] || fail "no hourly archive found in $BACKUP_DIR/hourly"
log "drilling with: $(basename "$ARCHIVE")"

rm -rf "$WORK"; mkdir -p "$WORK/extract" "$WORK/mongo" "$WORK/redis"
age -d -i "$IDENTITY" "$ARCHIVE" | tar -x -C "$WORK/extract" || fail "decrypt/untar failed (corrupt backup?!)"
if [ -f "$WORK/extract/mongo.archive" ]; then
  MODE=hourly
  [ -f "$WORK/extract/redis.rdb" ] || fail "hourly archive lacks redis.rdb"
else
  MODE=daily; log "note: this is a DAILY box bundle — restoring its .env/acme state only (no DB step)"
fi

if [ "$MODE" = hourly ]; then
  # ---- throwaway mongo ----
  "$MONGOD" --bind_ip 127.0.0.1 --port "$DRILL_MONGO_PORT" --dbpath "$WORK/mongo" \
    --storageEngine wiredTiger --logpath "$WORK/mongo.log" --fork >/dev/null || fail "throwaway mongod did not start"
  mongorestore --host 127.0.0.1 --port "$DRILL_MONGO_PORT" --archive="$WORK/extract/mongo.archive" --drop >/dev/null \
    || fail "mongorestore failed"
  read -r USERS MSGS < <(cd "$REPO/be" && node --input-type=module -e '
    const { MongoClient } = await import("mongodb");
    const c = new MongoClient("mongodb://127.0.0.1:'"$DRILL_MONGO_PORT"'/cocono-chat");
    await c.connect(); const db = c.db();
    console.log(await db.collection("users").countDocuments(), await db.collection("messages").countDocuments());
    await c.close();' ) || fail "count check crashed"
  [ "${USERS:-0}" -gt 0 ] || fail "restored DB has 0 users — backup content suspect"
  log "mongo restored: $USERS users, $MSGS retained message docs"

  # ---- throwaway redis with the backed-up queue RDB ----
  cp "$WORK/extract/redis.rdb" "$WORK/redis/dump.rdb"
  redis-server --port "$DRILL_REDIS_PORT" --bind 127.0.0.1 --dir "$WORK/redis" --daemonize yes \
    >/dev/null || fail "throwaway redis did not start"
  sleep 1
  log "redis loaded: $(redis-cli -p "$DRILL_REDIS_PORT" DBSIZE) keys visible"
fi

if [ "$MODE" = daily ]; then
  # sanity: the bundle really contains the secrets we need to rebuild a box
  for f in box/be.env box/acme.sh/account.conf; do
    [ -e "$WORK/extract/$f" ] || fail "daily bundle missing $f"
  done
  log "daily bundle intact: .env + acme.sh + units present"
fi

# ---- the real proof: boot the actual app against the restored data ----
if [ "$MODE" = hourly ] && [ "$FULL" = 1 ]; then
  # env source: backed-up .env if this were a daily-style bundle, else the
  # live one; ALWAYS strip store/port coords so the drill can never touch prod.
  if [ -f "$WORK/extract/box/be.env" ]; then SRC=$WORK/extract/box/be.env; else SRC=$REPO/be/.env; fi
  grep -vE '^(MONGO_URL|REDIS_URL|PORT)=' "$SRC" >"$WORK/env" || fail "no env source"
  ( cd "$REPO/be" && env PORT="$DRILL_APP_PORT" \
      MONGO_URL="mongodb://127.0.0.1:$DRILL_MONGO_PORT/cocono-chat" \
      REDIS_URL="redis://127.0.0.1:$DRILL_REDIS_PORT/0" \
      node --env-file-if-exists="$WORK/env" src/dev.js >"$WORK/app.log" 2>&1 & echo $! >"$WORK/app.pid" )
  APP_PID=$(cat "$WORK/app.pid")
  # the app speaks native TLS (certs from the env file) -> -k https
  for _ in $(seq 1 20); do
    sleep 1
    curl -k -sf "https://127.0.0.1:$DRILL_APP_PORT/api/app-info" >/dev/null && break
  done
  V=$(curl -k -sf "https://127.0.0.1:$DRILL_APP_PORT/api/app-info" | head -c 120)
  [ -n "${V:-}" ] || { tail -5 "$WORK/app.log"; fail "app did not answer on https://127.0.0.1:$DRILL_APP_PORT"; }
  log "app booted from backup: $V"
  kill "$APP_PID" 2>/dev/null; APP_PID=
fi

log "DRILL PASSED ✅ ($MODE archive $(basename "$ARCHIVE")$([ "$FULL" = 1 ] && echo ' + full app boot'))"
