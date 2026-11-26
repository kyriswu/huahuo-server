#!/usr/bin/env python3
"""Wait for the test Worker revision to take over a shared BullMQ queue."""

import argparse
import json
import re
import subprocess
import sys
import time


NAMESPACE = "ns-applications"
DEPLOYMENT = "huahuo-worker"
CONTAINER = "worker"
SELECTOR = "app.kubernetes.io/name=huahuo-server,app.kubernetes.io/component=worker"
REVISION = "deployment.kubernetes.io/revision"
METRIC = re.compile(r"^application_draining(?:\{[^}\r\n]*\})?[ \t]+([^ \t\r\n]+)$", re.MULTILINE)
SCRAPE = """
fetch('http://127.0.0.1:9464/metrics', {signal: AbortSignal.timeout(2000)})
  .then(response => {
    if (!response.ok) throw new Error(`metrics HTTP ${response.status}`);
    return response.text();
  })
  .then(text => process.stdout.write(text))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
"""


class Pending(Exception):
    pass


class Refused(Exception):
    pass


def kubectl(context, deadline, *arguments):
    timeout = min(10, deadline - time.monotonic())
    if timeout <= 0:
        raise Pending("No time remains for another observation")
    command = ["kubectl", "--context", context, "--namespace", NAMESPACE,
               "--request-timeout=10s", *arguments]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        raise Pending("A kubectl observation timed out") from error
    if result.returncode:
        message = result.stderr.strip().splitlines()
        detail = message[0][:240] if message else f"kubectl exited {result.returncode}"
        if "Forbidden" in detail or "Unauthorized" in detail:
            raise Refused(detail)
        raise Pending(detail)
    return result.stdout


def ready(resource):
    return any(condition["type"] == "Ready" and condition["status"] == "True"
               for condition in resource.get("status", {}).get("conditions", []))


def owner(resource, kind):
    for reference in resource["metadata"].get("ownerReferences", []):
        if reference.get("controller") and reference["kind"] == kind:
            return reference["uid"]
    return None


def image_in(pod_spec):
    return next((item["image"] for item in pod_spec["containers"]
                 if item["name"] == CONTAINER), None)


def snapshot(context, deadline, expected_image):
    nodes = json.loads(kubectl(context, deadline, "get", "nodes", "-o", "json"))["items"]
    if len(nodes) != 1 or not ready(nodes[0]) or nodes[0]["metadata"].get("deletionTimestamp"):
        raise Pending("A single healthy Kubernetes node is required")
    node_name = nodes[0]["metadata"]["name"]
    deployment = json.loads(kubectl(context, deadline, "get", "deployment", DEPLOYMENT, "-o", "json"))
    objects = json.loads(kubectl(context, deadline, "get", "replicasets,pods", "-l", SELECTOR,
                                 "-o", "json"))["items"]
    metadata = deployment["metadata"]
    status = deployment.get("status", {})
    if image_in(deployment["spec"]["template"]["spec"]) != expected_image:
        raise Refused("The Worker Deployment does not specify the requested image digest")
    if status.get("observedGeneration") != metadata["generation"]:
        raise Pending("The controller has not observed the current Worker generation")
    revision = metadata.get("annotations", {}).get(REVISION)
    desired = deployment["spec"]["replicas"]
    if not revision or desired < 1:
        raise Pending("The Worker Deployment has no active target revision")

    replica_sets = [item for item in objects if item["kind"] == "ReplicaSet"]
    if any(owner(item, "Deployment") != metadata["uid"] for item in replica_sets):
        raise Refused("A matching Worker ReplicaSet is owned by another controller")
    candidate = [item for item in replica_sets
                 if item["metadata"].get("annotations", {}).get(REVISION) == revision]
    if len(candidate) != 1 or image_in(candidate[0]["spec"]["template"]["spec"]) != expected_image:
        raise Pending("The target Worker ReplicaSet is not observable yet")
    candidate = candidate[0]
    candidate_uid = candidate["metadata"]["uid"]
    if candidate["spec"]["replicas"] != desired or status.get("updatedReplicas") != desired:
        raise Pending("The target Worker revision has not reached the desired size")
    if any(item["spec"]["replicas"] != 0 for item in replica_sets
           if item["metadata"]["uid"] != candidate_uid):
        raise Pending("An old Worker ReplicaSet can still create a consumer")

    known_owners = {item["metadata"]["uid"] for item in replica_sets}
    old_workers = []
    ready_count = 0
    for pod in (item for item in objects if item["kind"] == "Pod"):
        pod_owner = owner(pod, "ReplicaSet")
        pod_meta = pod["metadata"]
        name = pod_meta["name"]
        if pod_owner not in known_owners:
            raise Refused(f"Matching Worker pod {name} has an unexpected owner")
        if pod["spec"].get("nodeName") != node_name:
            raise Pending(f"Worker pod {name} is not assigned to the healthy node")
        state = next((item["state"] for item in pod.get("status", {}).get("containerStatuses", [])
                      if item["name"] == CONTAINER), {})
        deleting = bool(pod_meta.get("deletionTimestamp"))
        if pod_owner == candidate_uid:
            if image_in(pod["spec"]) != expected_image:
                raise Refused(f"Target Worker pod {name} specifies a different image")
            if not deleting and ready(pod) and "running" in state:
                ready_count += 1
            continue
        if not deleting:
            raise Pending(f"Old Worker pod {name} has not entered termination")
        if "terminated" in state:
            if state["terminated"].get("exitCode") != 0:
                raise Refused(f"Old Worker pod {name} did not exit cleanly")
        elif "running" in state:
            old_workers.append(name)
        else:
            raise Pending(f"Cannot establish the container state of old Worker pod {name}")
    if ready_count != desired:
        raise Pending(f"Target Worker pods ready {ready_count}/{desired}")

    fingerprint = tuple(sorted((item["metadata"]["uid"], item["metadata"]["resourceVersion"])
                               for item in [deployment, *objects]))
    return fingerprint, old_workers, desired


def wait_for_handoff(context, expected_image, timeout):
    deadline = time.monotonic() + timeout
    last_message = "The handoff has not been observed"
    while time.monotonic() < deadline:
        try:
            fingerprint, old_workers, desired = snapshot(context, deadline, expected_image)
            for name in old_workers:
                metrics = kubectl(context, deadline, "exec", name, "-c", CONTAINER,
                                  "--", "node", "-e", SCRAPE)
                if METRIC.findall(metrics) != ["1"]:
                    raise Pending(f"No application drain acknowledgement from old Worker pod {name}")
            current, _, _ = snapshot(context, deadline, expected_image)
            if current != fingerprint:
                raise Pending("Worker objects changed during observation; rechecking")
            print(f"Worker handoff confirmed. Target pods ready {desired}/{desired}. "
                  f"Old live pods reporting drain {len(old_workers)}.")
            return
        except Pending as error:
            message = str(error)
            if message != last_message:
                print(message, file=sys.stderr)
                last_message = message
            time.sleep(min(2, max(0, deadline - time.monotonic())))
    raise Refused(f"Worker handoff timed out. {last_message}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", required=True)
    parser.add_argument("--image", required=True, help="Image reference pinned by sha256 digest")
    parser.add_argument("--timeout", type=int, default=300, metavar="SECONDS")
    args = parser.parse_args()
    if not re.fullmatch(r"[^@\s]+@sha256:[a-f0-9]{64}", args.image):
        parser.error("--image must contain an immutable sha256 digest")
    if args.timeout < 1:
        parser.error("--timeout must be positive")
    try:
        wait_for_handoff(args.context, args.image, args.timeout)
    except (Refused, OSError, ValueError, KeyError) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
