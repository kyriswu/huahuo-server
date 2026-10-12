#!/usr/bin/env bash
set -eu
SERVER_ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
cd "$SERVER_ROOT"
bash scripts/ensure-docker-local.sh
if ! docker image inspect huahuo-server-tooling:p01 >/dev/null 2>&1; then
  docker build --target tooling -t huahuo-server-tooling:p01 .
fi
# Only Server is mounted. App reference and Docker orchestration run on the host.
exec docker run --rm -v "$SERVER_ROOT:/app" huahuo-server-tooling:p01 pnpm "$@"
