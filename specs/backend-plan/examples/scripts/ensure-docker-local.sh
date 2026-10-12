#!/usr/bin/env bash
# Only checks/optionally starts the user's already-installed LOCAL Docker Desktop.
# Does not install, switch contexts, pull/build images, stop/remove containers or prune.
set -eu
START=false
case "${1:-}" in
  '') ;;
  --start) START=true ;;
  --help) printf '%s\n' 'Usage: bash ensure-docker-local.sh [--start]' 'Default: check only. --start: explicitly allow starting installed local Docker Desktop.'; exit 0 ;;
  *) printf '%s\n' 'Unknown option; use --help.' >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then printf '%s\n' 'Too many arguments.' >&2; exit 2; fi

# Bound CLI waits without requiring GNU timeout on macOS.
run_bounded() {
  local limit="$1" pid elapsed status
  shift
  "$@" &
  pid=$!
  elapsed=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$elapsed" -ge "$limit" ]; then
      kill -TERM "$pid" 2>/dev/null || :
      sleep 1
      kill -KILL "$pid" 2>/dev/null || :
      wait "$pid" 2>/dev/null || :
      return 124
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  if wait "$pid"; then return 0; else status=$?; return "$status"; fi
}
if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' 'Docker CLI not found. Check existing installation/PATH; nothing was installed.' >&2
  exit 2
fi
if ! run_bounded 10 docker compose version >/dev/null 2>&1; then
  printf '%s\n' 'Docker Compose CLI unavailable. Check existing installation; nothing was installed.' >&2
  exit 2
fi
context=$(docker context show 2>/dev/null) || {
  printf '%s\n' 'Cannot inspect current Docker context; request appropriate access.' >&2; exit 2;
}
endpoint=$(docker context inspect "$context" --format '{{(index .Endpoints "docker").Host}}' 2>/dev/null) || {
  printf '%s\n' 'Cannot inspect context endpoint; no context change performed.' >&2; exit 2;
}
# DOCKER_CONTEXT takes precedence over DOCKER_HOST in Docker CLI selection.
if [ -z "${DOCKER_CONTEXT:-}" ] && [ -n "${DOCKER_HOST:-}" ]; then endpoint="$DOCKER_HOST"; fi
case "$endpoint" in
  unix://*) ;;
  *) printf '%s\n' 'Context is not verified as a local Unix socket. Refusing daemon/start actions; no context switch.' >&2; exit 2 ;;
esac
if run_bounded 10 docker info >/dev/null 2>&1; then
  printf '%s\n' 'Local Docker daemon is reachable. No start/restart performed.'
  exit 0
fi
if [ "$START" != true ]; then
  printf '%s\n' 'Local Docker daemon is not reachable. Check permissions/socket, or rerun with --start after local start is authorized.' >&2
  exit 3
fi
if [ "$(uname -s)" != Darwin ]; then
  printf '%s\n' '--start is limited here to macOS Docker Desktop. No sudo/service changes attempted.' >&2
  exit 2
fi
printf '%s\n' 'Attempting to start the already-installed local Docker Desktop. System dialogs require user action.'
if docker desktop start --help >/dev/null 2>&1; then
  if docker desktop start --help 2>/dev/null | grep -q -- '--timeout'; then
    if ! run_bounded 125 docker desktop start --timeout 120; then
      printf '%s\n' 'Desktop start did not report success; checking daemon next. Do not bypass permissions.' >&2
    fi
  elif ! run_bounded 120 docker desktop start; then
    printf '%s\n' 'Desktop start timed out/failed; checking daemon next.' >&2
  fi
elif command -v open >/dev/null 2>&1; then
  if ! open -a Docker; then
    printf '%s\n' 'Could not open installed Docker.app. Nothing was reinstalled or reset.' >&2
    exit 3
  fi
else
  printf '%s\n' 'No supported local Desktop start method; open the installed app manually.' >&2
  exit 3
fi
attempt=0
while [ "$attempt" -lt 12 ]; do
  if run_bounded 5 docker info >/dev/null 2>&1; then
    printf '%s\n' 'Local Docker daemon is ready. No project containers have been created by this script.'
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 5
done
printf '%s\n' 'Docker is still not reachable. Check Desktop dialogs/context/socket permissions; no reinstall/reset attempted.' >&2
exit 3
