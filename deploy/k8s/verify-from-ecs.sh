#!/usr/bin/env bash
set -euo pipefail
umask 077
started_at=$(date +%s)

if [[ $# -lt 1 || $# -gt 2 || ! "$1" =~ ^[a-f0-9]{40}$ || ( $# == 2 && "$2" != --rollout ) ]]; then
  printf '%s\n' 'Usage: bash verify-from-ecs.sh TEST_COMMIT_SHA [--rollout]' >&2
  exit 2
fi

sha=$1
digest=
result=passed
rollout=${2:-}
exec 3>&1
report() {
  local status=$?
  trap - EXIT
  if ((status == 0)); then
    printf '{"version":1,"sha":"%s","status":"%s","digest":"%s"}\n' "$sha" "$result" "$digest" >&3
  else
    printf '{"version":1,"sha":"%s","status":"failed"}\n' "$sha" >&3
  fi
  exit "$status"
}
trap report EXIT

state_dir=${HUAHUO_TEST_ACK_STATE_DIR:-/var/lib/huahuo-test-ack}
mkdir -p -- "$state_dir"
log_file=$(mktemp "$state_dir/verify.$sha.XXXXXX")
exec >>"$log_file" 2>&1

control_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source_dir=${HUAHUO_TEST_SOURCE_CHECKOUT:?Set the dedicated Server Git checkout}
repository=${HUAHUO_TEST_ACR_REPOSITORY:?Set the authorized ACR VPC repository}
context=${HUAHUO_TEST_ACK_CONTEXT:?Set the test ACK kubeconfig context}

exec 9>"$state_dir/verify.lock"
flock -n 9

bootstrap=${HUAHUO_TEST_ACK_BOOTSTRAP_EMPTY_DB:-false}
verification_args=(--context "$context")
db_target() {
  verification_args+=(--expected-db-host "${HUAHUO_TEST_ACK_EXPECTED_DB_HOST:?Set the designated test database host}"
    --expected-db-port "${HUAHUO_TEST_ACK_EXPECTED_DB_PORT:-5432}"
    --expected-database "${HUAHUO_TEST_ACK_EXPECTED_DATABASE:?Set the designated test database name}")
}
case "$bootstrap" in
  false) ;;
  true)
    if [[ -n "$rollout" || -e "$state_dir/first-release.json" ]]; then
      printf '%s\n' 'The first ACK release is already recorded.'
      exit 1
    fi
    verification_args+=(--bootstrap-empty-db)
    db_target
    ;;
  *) printf '%s\n' 'The ACK bootstrap setting must be true or false.'; exit 1 ;;
esac

# The fixed caller has already verified a successful push CI for this test SHA.
# Recheck the tip on the build host and use only the committed Git archive.
verify_test_tip() {
  git -C "$source_dir" fetch --quiet --no-tags origin refs/heads/test
  if [[ "$(git -C "$source_dir" rev-parse --verify FETCH_HEAD)" != "$sha" ]]; then
    printf '%s\n' 'The requested candidate is no longer the test tip.'
    exit 1
  fi
}
verify_test_tip

gateway=https://test-api.huahuoai.net
gateway_smoke() {
  local path response status
  for path in live ready; do
    curl --silent --show-error --fail --max-time 5 --noproxy '*' \
      --resolve test-api.huahuoai.net:443:127.0.0.1 "$gateway/health/$path" |
      jq -e --arg status "$path" '.success==true and .data.service=="api-server" and .data.status==$status' >/dev/null
  done
  response=$(mktemp "$state_dir/anonymous.XXXXXX")
  status=$(curl --silent --show-error --max-time 5 --noproxy '*' \
    --resolve test-api.huahuoai.net:443:127.0.0.1 -o "$response" -w '%{http_code}' "$gateway/api/v1/me/status") || status=000
  if [[ "$status" != 401 ]] || ! jq -e '.success==false and .error.code=="UNAUTHORIZED"' "$response" >/dev/null; then
    rm -f -- "$response"
    printf '%s\n' 'The test gateway did not reject an anonymous request as expected.' >&2
    return 1
  fi
  rm -f -- "$response"
}

if [[ -n "$rollout" ]]; then
  last_release=$state_dir/last-release.json
  if [[ ! -e "$last_release" ]]; then last_release=$state_dir/first-release.json; fi
  deployed_sha=$(jq -er 'select(.status=="deployed") | .sha | select(test("^[a-f0-9]{40}$"))' "$last_release")
  deployed_digest=$(jq -er '.digest | select(test("^sha256:[a-f0-9]{64}$"))' "$last_release")
  database_baseline=$(git -C "$source_dir" show "$sha:scripts/release/plan.json" | jq -er '.baseRevision')
  if [[ "$sha" != "$deployed_sha" && "$database_baseline" != "$deployed_sha" ]]; then
    printf '%s\n' 'The candidate plan must use the last successfully deployed ACK revision as its base.' >&2
    exit 1
  fi
  baseline_matches() {
    kubectl --context "$context" --namespace ns-applications --request-timeout=8s \
      get deployment huahuo-worker huahuo-scheduler huahuo-api huahuo-admin -o json |
      jq -e --arg image "$repository@$deployed_digest" \
        '[.items[] | .spec.template.spec.containers[0].image] | length==4 and all(.[]; .==$image)' >/dev/null
  }
  baseline_matches || { printf '%s\n' 'Reconcile the actual Deployments with the last successful ACK release first.' >&2; exit 1; }
  gateway_smoke
  verification_args+=(--rollout-existing --rollout-deadline "$((started_at + 5100))")
  db_target
fi

cd -- "$source_dir"
image=$(bash "$control_dir/build-and-push.sh" "$sha" "$repository" "${HUAHUO_TEST_BUILD_PLATFORM:-}")
digest=${image##*@}
if [[ "$image" != "$repository@$digest" || ! "$digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  printf '%s\n' 'Build did not return an immutable digest for the configured repository.'
  exit 1
fi
printf 'Candidate %s -> %s\n' "$sha" "$digest"
if [[ "$bootstrap" == true || -n "$rollout" ]]; then
  verify_test_tip
fi
if [[ -n "$rollout" ]]; then baseline_matches; fi
python3 "$control_dir/verify-candidate.py" "${verification_args[@]}" --image "$image"
if [[ -n "$rollout" ]]; then
  gateway_smoke
  if [[ -n "${HUAHUO_TEST_ACK_SMOKE_ENV:-}" ]]; then
    docker run --rm --network host --add-host test-api.huahuoai.net:127.0.0.1 \
      --env-file "$HUAHUO_TEST_ACK_SMOKE_ENV" --env "SMOKE_BASE_URL=$gateway" \
      --mount "type=bind,src=$control_dir/../../scripts/release/smoke.mjs,dst=/tmp/release-smoke.mjs,readonly" \
      "$image" node /tmp/release-smoke.mjs
  fi
  result=deployed
fi
if [[ "$bootstrap" == true || -n "$rollout" ]]; then
  record_name=first-release.json
  if [[ -n "$rollout" ]]; then record_name=last-release.json; fi
  release_record=$(mktemp "$state_dir/release.$sha.XXXXXX")
  printf '{"version":1,"sha":"%s","status":"deployed","digest":"%s"}\n' "$sha" "$digest" >"$release_record"
  mv -- "$release_record" "$state_dir/$record_name"
fi
