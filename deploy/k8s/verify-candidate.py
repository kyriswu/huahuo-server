#!/usr/bin/env python3
"""Verify a candidate Server image and optionally release it to test ACK."""

import argparse
import copy
import json
import re
import subprocess
import sys
import time
from pathlib import Path

NAMESPACE = "ns-applications"
RUNTIME_ROLES = ("api", "worker", "scheduler", "admin")
ROLES = (*RUNTIME_ROLES, "migrate")
JOB_DEADLINE_SECONDS = 120
JOB_WAIT_SECONDS = 150
COMMAND_TIMEOUT_SECONDS = 15
LOG_LIMIT_BYTES = 16384
ROLLOUT_SECONDS = 180
MAX_ROLLOUT_SECONDS = 3900
RELEASE_ORDER = ("worker", "scheduler", "api", "admin")
DB_ROLES = {role: "huahuo_normal" for role in RUNTIME_ROLES} | {"migrate": "huahuo_migrator"}
TARGET_GUARD = """
import {spawnSync} from 'node:child_process';
import {loadConfig} from './dist/config/config.js';
import {poolFor} from './dist/plugins/dependencies.js';

try {
  const [host, port, database, expectedRole, action] = process.argv.slice(1);
  const config = loadConfig(process.env.SERVICE_ROLE);
  const url = new URL(config.databaseUrl);
  if (config.appEnv !== 'test' || url.hostname.toLowerCase() !== host.toLowerCase()
      || (url.port || '5432') !== port || url.search || url.hash
      || decodeURIComponent(url.pathname.slice(1)) !== database
      || decodeURIComponent(url.username) !== expectedRole) throw new Error();
  if (['api-server', 'worker'].includes(config.role) && config.storageDriver === 'local') throw new Error();

  url.port = port;
  const pool = poolFor({...config, databaseUrl: url.href});
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      const {rows: [target]} = await client.query(`SELECT current_database() AS database_name,
        current_user AS role_name, NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
          AND c.relkind IN ('r','p','v','m','S','f')
      ) AS empty`);
      if (!target || target.database_name !== database || target.role_name !== expectedRole
          || target.empty !== (action !== 'rollout-config')) throw new Error();
      await client.query('ROLLBACK');
    } finally { client.release(); }
  } finally { await pool.end(); }

  const args = action === 'migrate' ? process.argv.slice(6) : ['dist/entrypoints/release-gate.js', 'config'];
  if (!args.length) throw new Error();
  const child = spawnSync(process.execPath, args, {
    stdio: 'inherit', env: {...process.env, DATABASE_URL: url.href},
  });
  process.exitCode = child.status ?? 1;
} catch {
  console.error(JSON.stringify({status: 'failed', code: 'RELEASE_BOOTSTRAP_TARGET_INVALID'}));
  process.exitCode = 1;
}
"""


class VerificationError(Exception):
    pass


def run(command, operation, *, source=None, timeout=COMMAND_TIMEOUT_SECONDS):
    try:
        completed = subprocess.run(
            command, input=source, capture_output=True, text=True, check=True, timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError, UnicodeError):
        raise VerificationError(f"{operation} failed") from None
    return completed.stdout


def parse_object(source, operation):
    try:
        result = json.loads(source)
    except (ValueError, RecursionError):
        raise VerificationError(f"{operation} returned invalid JSON") from None
    if not isinstance(result, dict):
        raise VerificationError(f"{operation} returned an invalid object")
    return result


def kubectl(context, operation, *arguments, source=None, timeout=COMMAND_TIMEOUT_SECONDS):
    return run(
        ["kubectl", "--context", context, "--namespace", NAMESPACE, *arguments],
        operation, source=source, timeout=timeout,
    )


def read_workload(context, role, image):
    renderer = Path(__file__).with_name("render.py")
    manifest = run([sys.executable, str(renderer), role, "--image", image], f"render {role}")
    operation = f"parse {role} workload"
    parsed = kubectl(
        context, operation, "create", "--dry-run=client", "--validate=false", "-o", "json", "-f", "-",
        source=manifest,
    )
    workload = parse_object(parsed, operation)
    try:
        kind = "Job" if role == "migrate" else "Deployment"
        metadata = workload["metadata"]
        if (workload["kind"] != kind or metadata["namespace"] != NAMESPACE
                or (kind == "Deployment" and metadata["name"] != f"huahuo-{role}")):
            raise ValueError
        pod = workload["spec"]["template"]["spec"]
        container, = pod["containers"]
        expected_role = "api-server" if role == "api" else role
        env = {entry["name"]: entry.get("value") for entry in container["env"]}
        if (pod.get("initContainers") or container["image"] != image
                or env.get("APP_ENV") != "test" or env.get("SERVICE_ROLE") != expected_role):
            raise ValueError
    except (KeyError, ValueError, AttributeError, TypeError):
        raise VerificationError(f"unexpected manifest for {role}") from None
    return workload


def target_command(role, target, action):
    host, port, database = target
    return ["node", "--input-type=module", "-e", TARGET_GUARD, host, str(port), database, DB_ROLES[role], action]


def submit_job(context, job):
    operation = "create release Job"
    prefix = job["metadata"]["generateName"]
    response = parse_object(kubectl(context, operation, "create", "-f", "-", "-o", "json", source=json.dumps(job)), operation)
    metadata = response.get("metadata")
    name = metadata.get("name") if isinstance(metadata, dict) else None
    if not isinstance(name, str) or re.fullmatch(re.escape(prefix) + r"[a-z0-9]{1,15}", name) is None:
        raise VerificationError("create release Job returned an invalid name")
    return f"job/{name}"


def create_job(context, role, stage, workload_pod, target=None, *, rollout=False):
    container = dict(workload_pod["containers"][0])
    for key in ("args", "lifecycle", "livenessProbe", "readinessProbe", "startupProbe", "ports"):
        container.pop(key, None)
    container.update(command=["node", "dist/entrypoints/release-gate.js", stage], imagePullPolicy="Always")
    if target is not None:
        container["command"] = target_command(role, target, "rollout-config" if rollout else "config")
    pod = {
        **workload_pod,
        "containers": [container],
        "restartPolicy": "Never",
        "terminationGracePeriodSeconds": 10,
    }
    labels = {"app.kubernetes.io/name": "huahuo-server-verifier", "app.kubernetes.io/component": role}
    prefix = f"huahuo-verify-{role}-{stage}-"
    job = {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {"generateName": prefix, "namespace": NAMESPACE, "labels": labels},
        "spec": {
            "backoffLimit": 0,
            "activeDeadlineSeconds": JOB_DEADLINE_SECONDS,
            "ttlSecondsAfterFinished": 3600,
            "template": {"metadata": {"labels": labels}, "spec": pod},
        },
    }
    return submit_job(context, job)


def wait_for_job(context, job, timeout=JOB_WAIT_SECONDS):
    deadline = time.monotonic() + timeout
    while (remaining := deadline - time.monotonic()) > 0:
        operation = "read verifier Job status"
        raw = kubectl(context, operation, "get", job, "-o", "json", timeout=min(COMMAND_TIMEOUT_SECONDS, remaining))
        try:
            conditions = parse_object(raw, operation).get("status", {}).get("conditions", [])
            completed = {item["type"] for item in conditions if item.get("status") == "True"}
        except (KeyError, AttributeError, TypeError):
            raise VerificationError("invalid verifier Job status") from None
        if "Failed" in completed:
            return False
        if "Complete" in completed:
            return True
        time.sleep(min(1, max(0, deadline - time.monotonic())))
    raise VerificationError("timed out waiting for verifier Job")


def verify_result(source, success, role, stage):
    if not success:
        if source == {"status": "failed", "code": "RELEASE_DATABASE_NOT_INITIALIZED"}:
            raise VerificationError("database is uninitialized; initialize the test database separately")
        if isinstance(source, dict) and source.get("status") == "failed":
            code = source.get("code")
            if isinstance(code, str) and re.fullmatch(r"(?:RELEASE_|DATABASE_|MIGRATION_|INVALID_CONFIG:)[A-Z0-9_:]{1,96}", code):
                raise VerificationError(code)
        raise VerificationError("verifier Job failed")
    expected_role = "api-server" if role == "api" else role
    if (set(source) != {"status", "stage", "role", "automaticReleaseReady", "result"}
            or source["status"] != "passed" or source["stage"] != stage or source["role"] != expected_role
            or not isinstance(source["result"], dict)):
        raise VerificationError("verifier Job returned an invalid result")
    if source["automaticReleaseReady"] is not True:
        raise VerificationError("candidate did not pass the automatic release compatibility checks")
    result = source["result"]
    if stage == "db-preflight":
        pending = result.get("pending")
        if not isinstance(pending, list):
            raise VerificationError("database preflight returned an invalid pending migration list")
        if pending:
            raise VerificationError("database has pending migrations; this check does not run them")
        current, target = result.get("current"), result.get("target")
        if type(current) is not int or type(target) is not int or current < 1 or current != target:
            raise VerificationError("database preflight returned inconsistent schema versions")
        return f"schema={current}, pending=0"
    if stage == "db-verify":
        count = result.get("assertionCount")
        if type(count) is not int or not 1 <= count <= 201:
            raise VerificationError("database verification returned an invalid assertion count")
        return f"assertions={count}, custom={count - 1}"
    if stage in ("config", "external"):
        count = result.get("checkCount")
        if type(count) is not int or count < 0:
            raise VerificationError("verifier Job returned an invalid check count")
        return f"declared_checks={count}"
    return "dependencies and runtime settings ready"


def check(context, role, stage, pod, target=None, *, rollout=False):
    job = None
    try:
        job = create_job(context, role, stage, pod, target, rollout=rollout)
        success = wait_for_job(context, job)
        try:
            operation = "read verifier Job result"
            raw = kubectl(context, operation, "logs", job, f"--limit-bytes={LOG_LIMIT_BYTES}")
            source = parse_object(raw, operation)
        except VerificationError:
            if success:
                raise
            source = None
        evidence = verify_result(source, success, role, stage)
    except VerificationError as error:
        location = f" ({job})" if job else ""
        raise VerificationError(f"{role}/{stage}{location}: {error}") from None
    print(f"Verified {role}/{stage} ({job}): {evidence}", flush=True)


def check_shared_resources(context, workloads):
    service = parse_object(kubectl(context, "read existing API Service", "get", "service/huahuo-api", "-o", "json"), "read API Service")
    selector = workloads["api"]["spec"]["selector"]["matchLabels"]
    spec = service.get("spec", {})
    if (spec.get("type") not in ("ClusterIP", "NodePort") or spec.get("externalIPs")
            or spec.get("selector") != selector or not any(
                port.get("port") == 3000 and port.get("targetPort") == "http"
                for port in spec.get("ports", []))):
        raise VerificationError("existing API Service does not match the test API Deployment")
    kubectl(context, "read workload ServiceAccount", "get", "serviceaccount/sa-huahuo-server", "-o", "name")


def check_initial_cluster(context, workloads):
    check_shared_resources(context, workloads)
    for role in RUNTIME_ROLES:
        if kubectl(context, "check for existing application Deployment", "get", f"deployment/huahuo-{role}",
                   "--ignore-not-found", "-o", "name").strip():
            raise VerificationError("the first release requires no existing Server Deployments")
    if kubectl(context, "check for existing Server Pods", "get", "pods", "-l", "app.kubernetes.io/name=huahuo-server", "-o", "name").strip():
        raise VerificationError("existing Server or migration Pods require inspection before a first release")


def migrate_empty_database(context, workload, target):
    container = workload["spec"]["template"]["spec"]["containers"][0]
    container["command"] = [*target_command("migrate", target, "migrate"), *container["command"][1:]]
    job = submit_job(context, workload)
    if not wait_for_job(context, job, 915):
        raise VerificationError(f"first database migration failed ({job}); inspect before retrying")
    result = parse_object(kubectl(context, "read migration Job result", "logs", job, f"--limit-bytes={LOG_LIMIT_BYTES}"), "read migration result")
    current = result.get("current")
    if (result.get("service") != "migrate" or result.get("status") != "complete"
            or type(current) is not int or not 1 <= current <= 9999
            or result.get("applied") != list(range(1, current + 1))):
        raise VerificationError(f"first database migration did not report a complete fresh history ({job})")
    print(f"Initialized test database with migrations 1–{current} ({job})", flush=True)


def deploy_first(context, workloads):
    for role in RELEASE_ORDER:
        kubectl(context, f"create {role} Deployment", "create", "-f", "-", source=json.dumps(workloads[role]))
        kubectl(context, f"wait for {role} readiness", "rollout", "status", f"deployment/huahuo-{role}",
                f"--timeout={ROLLOUT_SECONDS}s", timeout=ROLLOUT_SECONDS + 5)
    print("Created four test Server Deployments and verified their readiness", flush=True)


def get_deployment(context, role, *, timeout=COMMAND_TIMEOUT_SECONDS):
    operation = f"read {role} Deployment"
    return parse_object(kubectl(context, operation, "get", f"deployment/huahuo-{role}", "-o", "json",
                                timeout=timeout), operation)


def deployment_ready(deployment):
    desired = deployment["spec"]["replicas"]
    status = deployment.get("status", {})
    return (status.get("observedGeneration") == deployment["metadata"]["generation"]
            and all(status.get(key) == desired for key in ("replicas", "updatedReplicas", "availableReplicas")))


def patch_image(context, role, deployment, image, *, dry_run=False, timeout=COMMAND_TIMEOUT_SECONDS):
    metadata = deployment["metadata"]
    image_path = "/spec/template/spec/containers/0/image"
    operations = [
        {"op": "test", "path": "/metadata/uid", "value": metadata["uid"]},
        {"op": "test", "path": "/metadata/generation", "value": metadata["generation"]},
        {"op": "test", "path": "/spec/template/spec/containers/0/name", "value": role},
        {"op": "replace", "path": image_path, "value": image},
    ]
    operation = f"{'dry run image update for' if dry_run else 'update image for'} {role}"
    options = ["--dry-run=server"] if dry_run else []
    updated = parse_object(kubectl(context, operation, "patch", f"deployment/huahuo-{role}", "--type=json",
                                    "--patch", json.dumps(operations), *options, "-o", "json",
                                    timeout=timeout), operation)
    expected_spec = copy.deepcopy(deployment["spec"])
    expected_spec["template"]["spec"]["containers"][0]["image"] = image
    if updated["metadata"]["uid"] != metadata["uid"] or updated["spec"] != expected_spec:
        raise VerificationError(f"{role} image update returned an unexpected Deployment")
    return updated


def prepare_rollout(context, workloads, image):
    check_shared_resources(context, workloads)
    deployments = {}
    pods = {}
    for role in RELEASE_ORDER:
        deployment = get_deployment(context, role)
        spec = deployment["spec"]
        metadata = deployment["metadata"]
        template = spec["template"]["spec"]
        candidate = workloads[role]["spec"]
        containers = template["containers"]
        env = {entry["name"]: entry.get("value") for entry in containers[0]["env"]}
        expected_role = "api-server" if role == "api" else role
        if (deployment["kind"] != "Deployment" or metadata["namespace"] != NAMESPACE
                or metadata["name"] != f"huahuo-{role}" or not metadata["uid"] or metadata.get("deletionTimestamp")
                or type(metadata["generation"]) is not int or type(spec["replicas"]) is not int or spec["replicas"] < 1
                or spec["selector"] != candidate["selector"] or spec["strategy"] != candidate["strategy"]
                or (role == "scheduler" and spec["replicas"] != 1)
                or template["serviceAccountName"] != candidate["template"]["spec"]["serviceAccountName"]
                or template.get("initContainers") or len(containers) != 1 or containers[0]["name"] != role
                or env.get("APP_ENV") != "test" or env.get("SERVICE_ROLE") != expected_role
                or not re.fullmatch(r"[^@\s]+@sha256:[a-f0-9]{64}", containers[0]["image"])
                or not deployment_ready(deployment)):
            raise VerificationError(f"existing {role} is not a ready test Deployment matching the release controls")
        deployments[role] = deployment
        # An image-only patch preserves the live configuration. Verify against that same configuration.
        pods[role] = {**template, "containers": [{**containers[0], "image": image}]}
    for role in RELEASE_ORDER:
        patch_image(context, role, deployments[role], image, dry_run=True)
    return deployments, pods


def controller_uid(resource, kind):
    return next((ref["uid"] for ref in resource["metadata"].get("ownerReferences", [])
                 if ref["kind"] == kind and ref.get("controller") is True), None)


def deployment_pods(context, role, deployment, *, timeout=COMMAND_TIMEOUT_SECONDS):
    labels = deployment["spec"]["selector"]["matchLabels"]
    selector = ",".join(f"{key}={value}" for key, value in sorted(labels.items()))
    operation = f"read {role} ReplicaSets and Pods"
    items = parse_object(kubectl(context, operation, "get", "replicasets,pods", "-l", selector, "-o", "json",
                                timeout=timeout), operation)["items"]
    uid = deployment["metadata"]["uid"]
    replica_sets = {item["metadata"]["uid"] for item in items if item["kind"] == "ReplicaSet"
                    and controller_uid(item, "Deployment") == uid}
    pods = [item for item in items if item["kind"] == "Pod"]
    if any(pod["metadata"]["namespace"] != NAMESPACE or controller_uid(pod, "ReplicaSet") not in replica_sets
           for pod in pods):
        raise VerificationError(f"matching {role} Pod has an unexpected controller or namespace")
    return pods


def pod_uses_image(pod, role, image):
    return any(container["name"] == role and container["image"] == image
               for container in pod["spec"]["containers"])


def remaining_rollout_time(deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise VerificationError("ACK rollout deadline expired")
    return min(COMMAND_TIMEOUT_SECONDS, remaining)


def wait_for_rollout(context, role, updated, image, old_uids, deadline):
    expected = updated["metadata"]
    while True:
        deployment = get_deployment(context, role, timeout=remaining_rollout_time(deadline))
        metadata = deployment["metadata"]
        if (metadata["uid"] != expected["uid"] or metadata["generation"] != expected["generation"]
                or not pod_uses_image(deployment["spec"]["template"], role, image)):
            raise VerificationError(f"{role} Deployment changed during rollout")
        progress = deployment.get("status", {})
        if progress.get("observedGeneration") == expected["generation"] and any(
            condition.get("reason") == "ProgressDeadlineExceeded" for condition in progress.get("conditions", [])
        ):
            raise VerificationError(f"{role} Deployment exceeded its progress deadline")
        pods = deployment_pods(context, role, deployment, timeout=remaining_rollout_time(deadline))
        old_count = 0
        ready_count = 0
        for pod in pods:
            pod_meta = pod["metadata"]
            status = pod.get("status", {})
            state = next((container["state"] for container in status.get("containerStatuses", [])
                          if container["name"] == role), {})
            if pod_meta["uid"] in old_uids or not pod_uses_image(pod, role, image):
                old_count += 1
                if "terminated" in state:
                    exit_code = state["terminated"].get("exitCode")
                    if type(exit_code) is not int or exit_code != 0:
                        raise VerificationError(f"old {role} Pod {pod_meta['name']} exited with code {exit_code}")
            elif not pod_meta.get("deletionTimestamp") and "running" in state and any(
                condition["type"] == "Ready" and condition["status"] == "True"
                for condition in status.get("conditions", [])
            ):
                ready_count += 1
        if not old_count and ready_count == deployment["spec"]["replicas"] and deployment_ready(deployment):
            print(f"{role} digest ready; no old {role} Pods remain", flush=True)
            return
        time.sleep(min(2, remaining_rollout_time(deadline)))


def deploy_existing(context, deployments, image, timeout):
    deadline = time.monotonic() + timeout
    # Reconfirm the dry-run targets before the first patch. Each patch tests identity and generation again.
    for role in RELEASE_ORDER:
        current = get_deployment(context, role, timeout=remaining_rollout_time(deadline))
        expected = deployments[role]["metadata"]
        if any(current["metadata"][key] != expected[key] for key in ("uid", "generation")):
            raise VerificationError(f"{role} Deployment changed after preflight")
    updated_deployments = {}
    for role in RELEASE_ORDER:
        deployment = deployments[role]
        old_pods = deployment_pods(context, role, deployment, timeout=remaining_rollout_time(deadline))
        old_uids = {pod["metadata"]["uid"] for pod in old_pods if not pod_uses_image(pod, role, image)}
        updated = deployment
        if not pod_uses_image(deployment["spec"]["template"], role, image):
            updated = patch_image(context, role, deployment, image, timeout=remaining_rollout_time(deadline))
        wait_for_rollout(context, role, updated, image, old_uids, deadline)
        updated_deployments[role] = updated
    for role in RELEASE_ORDER:
        deployment = get_deployment(context, role, timeout=remaining_rollout_time(deadline))
        expected = updated_deployments[role]["metadata"]
        if (any(deployment["metadata"][key] != expected[key] for key in ("uid", "generation"))
                or not deployment_ready(deployment)):
            raise VerificationError(f"{role} Deployment drifted before release completion")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", required=True, help="Explicit test cluster kubeconfig context")
    parser.add_argument("--image", required=True, help="Image pinned by sha256 digest")
    release_mode = parser.add_mutually_exclusive_group()
    release_mode.add_argument("--bootstrap-empty-db", action="store_true", help="Initialize and deploy to an explicitly bound fresh test database")
    release_mode.add_argument("--rollout-existing", action="store_true", help="Verify and update existing test Deployments by digest")
    parser.add_argument("--rollout-timeout", type=int, metavar="SECONDS", help="Total wait for an existing rollout (default and max 3900)")
    parser.add_argument("--rollout-deadline", type=int, metavar="UNIX_TIME", help="Deadline of the caller's release command")
    parser.add_argument("--expected-db-host")
    parser.add_argument("--expected-db-port", type=int)
    parser.add_argument("--expected-database")
    args = parser.parse_args()
    if not args.context.strip():
        parser.error("--context cannot be empty")
    if args.rollout_timeout is not None and (not args.rollout_existing or not 1 <= args.rollout_timeout <= MAX_ROLLOUT_SECONDS):
        parser.error("--rollout-timeout requires --rollout-existing and must be between 1 and 3900 seconds")
    if args.rollout_deadline is not None and not args.rollout_existing:
        parser.error("--rollout-deadline requires --rollout-existing")
    target = None
    if args.bootstrap_empty_db or args.rollout_existing:
        if (not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]{0,252}", args.expected_db_host or "")
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,62}", args.expected_database or "")):
            parser.error("deployment requires an explicit database host and name")
        port = args.expected_db_port if args.expected_db_port is not None else 5432
        if not 1 <= port <= 65535:
            parser.error("database port must be between 1 and 65535")
        target = (args.expected_db_host, port, args.expected_database)
    elif any(value is not None for value in (args.expected_db_host, args.expected_db_port, args.expected_database)):
        parser.error("database target options require --bootstrap-empty-db or --rollout-existing")
    try:
        workloads = {role: read_workload(args.context, role, args.image) for role in ROLES}
        pods = {role: workload["spec"]["template"]["spec"] for role, workload in workloads.items()}
        if args.bootstrap_empty_db:
            check_initial_cluster(args.context, workloads)
        if args.rollout_existing:
            deployments, live_pods = prepare_rollout(args.context, workloads, args.image)
            pods.update(live_pods)
        for role in ROLES:
            check(args.context, role, "config", pods[role], target, rollout=args.rollout_existing)
        if not args.bootstrap_empty_db:
            check(args.context, "migrate", "db-preflight", pods["migrate"])
        check(args.context, "api", "external", pods["api"])
        if args.bootstrap_empty_db:
            migrate_empty_database(args.context, workloads["migrate"], target)
            check(args.context, "migrate", "db-preflight", pods["migrate"])
        for role in ROLES:
            check(args.context, role, "db-verify", pods[role])
        for role in RUNTIME_ROLES:
            check(args.context, role, "runtime", pods[role])
        if args.bootstrap_empty_db:
            deploy_first(args.context, workloads)
        if args.rollout_existing:
            rollout_timeout = args.rollout_timeout or MAX_ROLLOUT_SECONDS
            if args.rollout_deadline is not None and time.time() + rollout_timeout + 60 > args.rollout_deadline:
                raise VerificationError("not enough command time remains for the rollout and gateway check")
            deploy_existing(args.context, deployments, args.image, rollout_timeout)
    except VerificationError as error:
        print(f"verify-candidate: {error}", file=sys.stderr)
        return 1
    except (KeyError, TypeError, IndexError, AttributeError):
        print("verify-candidate: unexpected Kubernetes resource shape", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
