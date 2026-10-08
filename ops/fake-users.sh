#!/usr/bin/env bash
# cocono-chat fake-user generator (devbox only) — see fake-users/index.mjs
# for scenarios and flags. Loads be/.env for MONGO_URL / REDIS_URL / ADMIN_TOKEN.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node --env-file-if-exists=be/.env ops/fake-users/index.mjs "$@"
