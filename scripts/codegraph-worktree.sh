#!/bin/sh
set -eu

root=$(git rev-parse --show-toplevel)
cd "$root"

# A linked worktree shares the CLI installation with the main checkout.
# The index and all source reads use the current checkout.
if command -v codegraph >/dev/null 2>&1; then
  codegraph_bin=codegraph
else
  common_dir=$(git rev-parse --path-format=absolute --git-common-dir)
  codegraph_bin="${common_dir%/*}/.local/codegraph/codegraph"
  if [ ! -x "$codegraph_bin" ]; then
    printf '%s\n' 'CodeGraph CLI was not found in PATH or the main checkout.' >&2
    exit 1
  fi
fi

if [ ! -f .codegraph/codegraph.db ]; then
  "$codegraph_bin" init --yes --local-only "$root" >&2
fi

exec "$codegraph_bin" "$@"
