#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'build-and-push: %s\n' "$*" >&2
  exit 1
}

if [[ $# -lt 2 || $# -gt 3 ]]; then
  fail 'usage: bash deploy/k8s/build-and-push.sh FULL_SHA ACR_REPO [linux/amd64|linux/arm64] (run inside the huahuo-server Git checkout)'
fi

sha=$1
repository=$2
platform=${3-}

[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail 'FULL_SHA must be the full lowercase commit SHA'
[[ "$repository" =~ ^[a-z0-9][a-z0-9.-]*(:[0-9]+)?/[a-z0-9][a-z0-9._/-]*$ ]] ||
  fail 'ACR_REPO must be the registry and repository path, without scheme, tag or digest'
case "$platform" in
  ''|linux/amd64|linux/arm64) ;;
  *) fail 'PLATFORM must be linux/amd64 or linux/arm64' ;;
esac

for dependency in git docker jq; do
  command -v "$dependency" >/dev/null || fail "$dependency is required"
done

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || fail 'run inside the huahuo-server Git checkout'
commit_type=$(git -C "$repo_root" cat-file -t "$sha" 2>/dev/null) || fail 'commit is not present locally'
[[ "$commit_type" == commit ]] || fail 'FULL_SHA must refer to a commit'
git -C "$repo_root" cat-file -e "$sha:Dockerfile" 2>/dev/null || fail 'commit does not contain the Dockerfile'

metadata_file=$(mktemp "${TMPDIR:-/tmp}/huahuo-image-metadata.XXXXXX") || fail 'cannot create a metadata file'
trap 'rm -f -- "$metadata_file"' EXIT

build_args=(buildx build --progress=plain --push --metadata-file "$metadata_file"
  --tag "$repository:$sha" --label "org.opencontainers.image.revision=$sha")
if [[ -n "$platform" ]]; then
  build_args+=(--platform "$platform")
fi
if [[ -n "${HUAHUO_TEST_ACK_NODE_IMAGE:-}" ]]; then
  node_image=$HUAHUO_TEST_ACK_NODE_IMAGE
  registry=${repository%%/*}
  [[ "$node_image" == "$registry/"* && "$node_image" =~ ^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$ ]] ||
    fail 'NODE_IMAGE must be pinned by digest in the configured ACR registry'
  build_args+=(--build-arg "NODE_IMAGE=$node_image")
fi

# Use the committed build context and keep the selected Buildx builder's cache.
git -C "$repo_root" archive --format=tar "$sha" |
  docker "${build_args[@]}" - >&2 || fail 'image build or push failed'

digest=$(jq -er '."containerimage.digest" | select(type == "string" and test("^sha256:[0-9a-f]{64}$"))' "$metadata_file") ||
  fail 'Buildx did not return an OCI image digest'
printf '%s@%s\n' "$repository" "$digest"
