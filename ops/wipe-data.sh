#!/usr/bin/env bash
# cocono-chat devbox: wipe ALL user data (dev reset).
#
#   ./ops/wipe-data.sh            # DRY RUN — shows exactly what would drop
#   ./ops/wipe-data.sh confirm    # actually wipes (refuses otherwise)
#
# What gets dropped:
#   * EVERY Mongo collection that is auto-discovered in the DB pointed at by
#     MONGO_URL (be/.env), minus the KEEP list below. Auto-discovery is the
#     maintenance contract: features that add a collection are covered
#     WITHOUT editing this script — only add to KEEP when a collection is
#     NOT user data.
#   * FLUSHDB on the app's Redis DB only (never FLUSHALL — db 15 belongs to
#     the test suite): presence keys, login nonces, pairing state, rate
#     limits, push gates.
#   * Restart of cocono-be + cocono-admin so live WS sessions drop and both
#     services come up against the clean state.
#
# Safety rails:
#   - requires the literal word `confirm`
#   - takes a fresh ops/backup.sh hourly run FIRST and aborts if it fails
#     (mirror lives in ~/backups/hourly; restore with ops/restore.sh)
#   - never touches: be/.env secrets, backups, certs, the KEEP list.
#
# NOT covered (impossible from here): client-side state in users' browsers —
# IndexedDB transcripts / identities stay on each device until the app
# re-pairs; the wiped server will simply refuse the old identities.
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/bin:/usr/bin"
REPO="$HOME/cocono-chat"

# Collections that are NOT user data (kept across wipes):
KEEP='["settings"]'   # 'settings' holds app config — but see KEEP_DOCS below
# Inside settings, only branding is app-level config. Every OTHER settings
# doc is ops/user-derived state that a wipe must reset:
#   'limits'  → per-user limit overrides (keyed by username / user:device)
#   'traffic' → the server-wide rate-limit KILL SWITCH (must not survive
#               wiped, or a wiped box keeps running with no limits!)
# Future features: put durable app config under a new KEEP_DOCS id, or it
# gets wiped (safe by default).
KEEP_DOCS='["branding"]'

url_from_env() { # $1 = KEY, $2 = default
  local v
  v=$(sed -n "s/^$1=//p" "$REPO/be/.env" 2>/dev/null || true)
  echo "${v:-$2}"
}
MONGO_URL=$(url_from_env MONGO_URL 'mongodb://127.0.0.1:27017/cocono-chat')
REDIS_URL=$(url_from_env REDIS_URL 'redis://127.0.0.1:6379/0')

echo "== cocono-chat WIPE ALL USER DATA =="
echo "   mongo: $MONGO_URL"

if [ "${1:-}" != "confirm" ]; then
  echo "   --- DRY RUN (rerun with the argument 'confirm' to wipe) ---"
  mongosh "$MONGO_URL" --quiet --eval "
    const keep = new Set(JSON.parse('$KEEP'));
    for (const c of db.getCollectionNames()) {
      if (c.startsWith('system.')) continue;
      const n = db.getCollection(c).countDocuments();
      print('   ' + (keep.has(c) ? 'KEEP' : 'DROP') + '  ' + c + '  (' + n + ' docs)');
    }
    const prune = db.settings.find({ _id: { \$nin: JSON.parse('$KEEP_DOCS') } }, { _id: 1 })
      .toArray().map(d => d._id);
    if (prune.length) print('   PRUNE settings docs: ' + prune.join(', ') + ' (per-user limit overrides, rate-limit kill switch -> defaults)');
  "
  echo "   redis: FLUSHDB $REDIS_URL"
  echo "   then:  systemctl --user restart cocono-be cocono-admin"
  exit 0
fi

echo "== pre-wipe backup (abort on failure) =="
"$REPO/ops/backup.sh" hourly

echo "== dropping collections =="
mongosh "$MONGO_URL" --quiet --eval "
  const keep = new Set(JSON.parse('$KEEP'));
  for (const c of db.getCollectionNames()) {
    if (c.startsWith('system.')) continue;
    if (keep.has(c)) {
      if (c === 'settings') {
        const r = db.settings.deleteMany({ _id: { \$nin: JSON.parse('$KEEP_DOCS') } });
        print('   pruned   settings (' + r.deletedCount + ' docs removed; kept: ' + JSON.parse('$KEEP_DOCS').join(',') + ')');
      } else print('   kept   ' + c);
      continue;
    }
    db.getCollection(c).drop();
    print('   dropped  ' + c);
  }
"

# parse redis URL (redis-cli wants host/port/db separately; FLUSHDB = one db)
rest=${REDIS_URL#redis://}
hostport=${rest%%/*}
dbpart=${rest#*/}; [ "$dbpart" = "$rest" ] && dbpart=0
host=${hostport%%:*}
port=${hostport#*:}; [ "$port" = "$hostport" ] && port=6379
echo "== flushing redis db $dbpart of $host:$port =="
redis-cli -h "$host" -p "$port" -n "$dbpart" FLUSHDB

echo "== restarting services =="
systemctl --user restart cocono-be cocono-admin

echo "== verify =="
mongosh "$MONGO_URL" --quiet --eval "
  let total = 0;
  for (const c of db.getCollectionNames()) {
    if (c.startsWith('system.')) continue;
    const n = db.getCollection(c).countDocuments();
    total += n;
    print('   ' + c + ': ' + n);
  }
  const strays = db.settings.find({ _id: { \$nin: JSON.parse('$KEEP_DOCS') } }).toArray().map(d => d._id);
  if (strays.length) { print('   !! settings docs survived: ' + strays.join(',')); quit(1); }
  if (total > JSON.parse('$KEEP_DOCS').length) { print('   !! non-KEEP collections still hold documents'); quit(1); }
  print('   user data: none left (badges/awards went with users; limits & kill switch reset to defaults)');
"
echo "done — devbox user data wiped (backups + secrets untouched)."
