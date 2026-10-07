#!/usr/bin/env bash
# cocono-chat PRODUCTION restore from a backup archive (the panic button).
#
#   ops/restore.sh ~/backups/hourly/cocono-hourly-<stamp>.tar.age [--yes]
#
# OVERWRITES the live database and queue with the backup state. Everything
# written after the backup's stamp is LOST. The app is taken down for the
# duration. Refuses to run without an explicit confirmation.
set -uo pipefail
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin"
REPO=$HOME/cocono-chat
IDENTITY=$HOME/.config/cocono-backup/identity.age
BACKUP_DIR=$HOME/backups
LOCK=$BACKUP_DIR/.ops.lock
ARCHIVE=${1:?usage: restore.sh <archive.tar.age> [--yes]}
CONFIRM=${2:-}

# ---- de-bounce lock (shared with backup.sh / drill) ----
exec 9>"$LOCK"
if ! flock -n 9; then echo "[restore] another ops run is active — refusing to overlap" >&2; exit 20; fi
printf '%s|%s|%s\n' "$$" restore "$(date -u +%Y%m%dT%H%M%SZ)" > "$BACKUP_DIR/.ops.pid"
mkdir -p "$BACKUP_DIR/status"
STARTED=$(date -u +%FT%TZ); START_EPOCH=$(date +%s); RESTORE_DETAIL="aborted"
on_exit() {
  local rc=$?
  printf '{"mode":"restore","startedAt":"%s","finishedAt":"%s","code":%d,"durationSec":%d,"detail":"%s"}\n' \
    "$STARTED" "$(date -u +%FT%TZ)" "$rc" "$(( $(date +%s) - START_EPOCH ))" "$RESTORE_DETAIL" > "$BACKUP_DIR/status/restore.json"
  rm -f "$BACKUP_DIR/.ops.pid"
}
trap on_exit EXIT

[ -f "$ARCHIVE" ] || { echo "no such archive: $ARCHIVE" >&2; exit 1; }
[ -f "$IDENTITY" ] || { echo "need the age identity at $IDENTITY to decrypt" >&2; exit 1; }
MONGO_URL=$(grep -m1 '^MONGO_URL=' "$REPO/be/.env" | cut -d= -f2-)
RDB_DIR=$(redis-cli CONFIG GET dir 2>/dev/null | tail -1)
[ -n "$MONGO_URL" ] && [ -n "$RDB_DIR" ] || { echo "could not read prod mongo/redis config" >&2; exit 1; }

if [ "$CONFIRM" != "--yes" ]; then
  echo "This will REPLACE production data with: $(basename "$ARCHIVE")"
  echo "Anything newer than that backup is destroyed."
  read -r -p "Type exactly 'RESTORE' to continue: " ans
  [ "$ans" = "RESTORE" ] || { echo "aborted"; exit 1; }
fi

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
age -d -i "$IDENTITY" "$ARCHIVE" | tar -x -C "$TMP" || { echo "decrypt failed" >&2; exit 1; }
[ -f "$TMP/mongo.archive" ] || { echo "not an hourly (data) archive — daily bundles restore config; see ops/backup-drill.sh notes" >&2; exit 1; }

echo "[restore] stopping services..."
systemctl --user stop cocono-be cocono-redis
echo "[restore] restoring mongo..."
mongorestore --uri "$MONGO_URL" --archive="$TMP/mongo.archive" --drop || { echo "mongorestore FAILED" >&2; exit 1; }
echo "[restore] restoring redis queue snapshot..."
mv "$RDB_DIR/dump.rdb" "$RDB_DIR/dump.rdb.pre-restore.$(date +%s)" 2>/dev/null || true
cp "$TMP/redis.rdb" "$RDB_DIR/dump.rdb"
systemctl --user start cocono-redis
sleep 1
echo "[restore] starting app..."
systemctl --user start cocono-be
sleep 2
systemctl --user is-active --quiet cocono-be || { echo "app did not come up — journalctl --user -u cocono-be" >&2; exit 1; }
curl -sf https://dev.co.co.no/api/app-info >/dev/null && echo "[restore] ✅ app answers; verify login + history, then: systemctl --user stop cocono-backup.timer temporarily if the drill could race this." || echo "[restore] WARNING: app 'active' but app-info not reachable"
RESTORE_DETAIL="restored $(basename "$ARCHIVE")"
