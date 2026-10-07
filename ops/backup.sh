#!/usr/bin/env bash
# cocono-chat backup (ops trio #2). Usage: backup.sh [hourly|daily]
#
#   hourly: mongodump (accounts, device registry, retained E2EE envelopes)
#           + redis RDB (never-pulled message queue) -> ONE age-encrypted
#           tar -> local mirror ~/backups/hourly + rclone to $RCLONE_DEST.
#   daily : box bundle: be/.env (JWT/ADMIN/VAPID secrets), systemd units,
#           acme.sh (certs + DNS token), redis/mongo facts -> same pipeline.
#
# SECURITY: nothing unencrypted ever touches disk (dump streams into a tmpfs
# mktemp dir, immediately tar|age'd, dir wiped). Off-box copies are ONLY the
# encrypted blobs. Decryption needs the age identity, which lives OFF the
# box (or an optional on-box copy — see backup.conf.example).
#
# Config: ~/.config/cocono-backup.conf (template: ops/backup.conf.example).
# Missing/unconfigured -> silent skip (timer keeps quiet until setup).
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin"
MODE=${1:-hourly}
case "$MODE" in hourly|daily) ;; *) echo "usage: $0 [hourly|daily]" >&2; exit 2;; esac

REPO=$HOME/cocono-chat
CONF=$HOME/.config/cocono-backup.conf
BACKUP_DIR=$HOME/backups
STATUS_DIR=$BACKUP_DIR/status
LOCK=$BACKUP_DIR/.ops.lock
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
LOG=$BACKUP_DIR/backup.log
STATUS_DETAIL=""
mkdir -p "$BACKUP_DIR" "$STATUS_DIR"

log() { echo "[backup $MODE] $*"; echo "[$(date -u +%FT%TZ) $MODE] $*" >>"$LOG"; }

# ---- de-bounce: ONE ops run at a time. backup/daily/drill/restore share
# this lock, so timers, admin buttons and manual runs can never overlap;
# a busy lock means a silent skip (not a failed run). ----
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "[backup $MODE] another ops run is active — skipping (de-bounced)"
  exit 0
fi
printf '%s|%s|%s\n' "$$" "$MODE" "$STAMP" > "$BACKUP_DIR/.ops.pid"

STARTED=$(date -u +%FT%TZ)
START_EPOCH=$(date +%s)
on_exit() {
  local rc=$?
  printf '{"mode":"%s","startedAt":"%s","finishedAt":"%s","code":%d,"durationSec":%d,"detail":"%s"}\n' \
    "$MODE" "$STARTED" "$(date -u +%FT%TZ)" "$rc" "$(( $(date +%s) - START_EPOCH ))" \
    "${STATUS_DETAIL:-$([ $rc -eq 0 ] && echo ok || echo failed)}" > "$STATUS_DIR/$MODE.json"
  rm -f "$BACKUP_DIR/.ops.pid"
  [ $rc -eq 0 ] || log "FAILED (exit $rc) — check: journalctl --user -u cocono-backup -n 50"
}
trap on_exit EXIT

[ -f "$CONF" ] || { STATUS_DETAIL="not configured (no $CONF)"; log "not configured — skipping"; exit 0; }
# shellcheck disable=SC1090
. "$CONF"
if [ -z "${AGE_RECIPIENT:-}" ]; then STATUS_DETAIL="AGE_RECIPIENT unset"; log "AGE_RECIPIENT unset — skipping"; exit 0; fi

command -v age >/dev/null || { log "age missing"; exit 1; }
TMP=$(mktemp -d /tmp/cocono-backup.XXXXXX)
trap 'rm -rf "$TMP"; on_exit' EXIT

OUT=$BACKUP_DIR/$MODE/cocono-$MODE-$STAMP.tar.age
mkdir -p "$BACKUP_DIR/$MODE"

if [ "$MODE" = hourly ]; then
  MONGO_URL=$(grep -m1 '^MONGO_URL=' "$REPO/be/.env" | cut -d= -f2-)
  [ -n "$MONGO_URL" ] || { log "MONGO_URL not found in be/.env"; exit 1; }
  mongodump --uri "$MONGO_URL" --archive="$TMP/mongo.archive" >/dev/null

  # Ask redis to snapshot, wait for it to actually finish, copy the RDB.
  # (redis >= 6 answers 'Background saving started'; older 'OK' — don't gate on it)
  before=$(redis-cli LASTSAVE)
  redis-cli BGSAVE >/dev/null
  for _ in $(seq 1 60); do [ "$(redis-cli LASTSAVE)" != "$before" ] && break; sleep 1; done
  [ "$(redis-cli LASTSAVE)" != "$before" ] || { log "redis snapshot did not complete"; exit 1; }
  RDB_DIR=$(redis-cli CONFIG GET dir | tail -1); RDB_FILE=$(redis-cli CONFIG GET dbfilename | tail -1)
  cp "$RDB_DIR/$RDB_FILE" "$TMP/redis.rdb"

  {
    echo "utc=$STAMP"
    echo "git=$(git -C "$REPO" rev-parse --short HEAD)"
    echo "mongo_bytes=$(stat -c%s "$TMP/mongo.archive")"
    echo "redis_bytes=$(stat -c%s "$TMP/redis.rdb")"
  } >"$TMP/meta.txt"
  tar -C "$TMP" -cf - mongo.archive redis.rdb meta.txt | age -r "$AGE_RECIPIENT" >"$OUT"
  rm -f "$TMP/mongo.archive" "$TMP/redis.rdb"
else
  BUNDLE=$TMP/box
  mkdir -p "$BUNDLE"
  cp "$REPO/be/.env" "$BUNDLE/be.env"
  cp "$HOME"/.config/systemd/user/cocono-*.service "$BUNDLE/" 2>/dev/null || true
  cp -r "$HOME/.acme.sh" "$BUNDLE/acme.sh" 2>/dev/null || true
  redis-cli CONFIG GET dir >"$BUNDLE/redis-facts.txt" 2>/dev/null || true
  redis-cli CONFIG GET dbfilename >>"$BUNDLE/redis-facts.txt" 2>/dev/null || true
  grep -h ExecStart "$HOME"/.config/systemd/user/cocono-mongo.service >"$BUNDLE/mongo-facts.txt" 2>/dev/null || true
  echo "utc=$STAMP git=$(git -C "$REPO" rev-parse --short HEAD)" >"$BUNDLE/meta.txt"
  tar -C "$TMP" -cf - box | age -r "$AGE_RECIPIENT" >"$OUT"
  rm -rf "$BUNDLE"
fi

SIZE=$(stat -c%s "$OUT")
[ "$SIZE" -gt 1024 ] || { log "suspiciously small archive ($SIZE bytes) — treating as failure"; exit 1; }
log "encrypted archive: $OUT ($SIZE bytes)"

# ---- retention (local mirror) ----
mapfile -t all < <(ls -1 "$BACKUP_DIR/$MODE"/cocono-$MODE-*.tar.age 2>/dev/null | sort)
keep=24; [ "$MODE" = daily ] && keep=14
if [ "${#all[@]}" -gt "$keep" ]; then
  printf '%s\n' "${all[@]:0:${#all[@]}-keep}" | xargs -r rm -f --
  log "pruned local copies to the newest $keep"
fi

# ---- off-box via rclone ----
if [ -n "${RCLONE_DEST:-}" ]; then
  RREMOTE=${RCLONE_DEST%%:*}
  if rclone listremotes | grep -qx "$RREMOTE:"; then
    rclone copy "$OUT" "$RCLONE_DEST/$MODE/" --checksum
    # remote retention by age: hourlies older than 2 days, dailies 15 days
    rclone delete "$RCLONE_DEST/$MODE" --min-age $([ "$MODE" = hourly ] && echo 36h || echo 15d) --include 'cocono-*.tar.age' || true
    STATUS_DETAIL="$OUT + rclone"
    log "synced to $RCLONE_DEST/$MODE"
  else
    log "WARNING: remote '$RREMOTE' not in rclone config — local-only backup!"
  fi
else
  log "RCLONE_DEST unset — local-only backup!"
fi
STATUS_DETAIL=${STATUS_DETAIL:-$OUT}
log "done"
