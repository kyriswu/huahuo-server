import copy
import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("verify_candidate", Path(__file__).with_name("verify-candidate.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

OLD = "registry.example/huahuo/server@sha256:" + "1" * 64
NEW = "registry.example/huahuo/server@sha256:" + "2" * 64
ROLES = ("worker", "scheduler", "api", "admin")


class FakeCluster:
    def __init__(self):
        self.events = []
        self.dry_run_failure = None
        self.dry_run_drift = None
        self.worker_exit_code = None
        self.worker_poll_count = 0
        self.live = {role: self.deployment(role) for role in ROLES}

    def deployment(self, role):
        labels = {"app.kubernetes.io/name": "huahuo-server", "app.kubernetes.io/component": role}
        pod = {"serviceAccountName": "sa-huahuo-server", "containers": [{
            "name": role,
            "image": OLD,
            "env": [{"name": "APP_ENV", "value": "test"},
                    {"name": "SERVICE_ROLE", "value": "api-server" if role == "api" else role}],
        }]}
        return {"kind": "Deployment", "metadata": {"name": f"huahuo-{role}", "uid": role,
                                                     "namespace": release.NAMESPACE, "generation": 1},
                "spec": {"replicas": 1, "selector": {"matchLabels": labels},
                         "template": {"spec": pod},
                         "strategy": {"type": "Recreate" if role == "scheduler" else "RollingUpdate"}},
                "status": {"observedGeneration": 1, "replicas": 1, "updatedReplicas": 1, "availableReplicas": 1}}

    def candidate(self, role):
        deployment = self.deployment(role)
        deployment["spec"]["template"]["spec"]["containers"][0]["image"] = NEW
        if role == "migrate":
            deployment["kind"] = "Job"
        return deployment

    def pod(self, role, current, deleting=False):
        suffix = "new" if current else "old"
        metadata = {"name": f"{role}-{suffix}", "uid": f"{role}-pod-{suffix}", "namespace": release.NAMESPACE,
                    "ownerReferences": [{"kind": "ReplicaSet", "uid": f"{role}-rs-{suffix}", "controller": True}]}
        if deleting:
            metadata["deletionTimestamp"] = "2026-11-22T06:00:00Z"
        state = {"running": {}}
        if deleting and self.worker_exit_code is not None:
            state = {"terminated": {"exitCode": self.worker_exit_code}}
        return {"kind": "Pod", "metadata": metadata,
                "spec": {"containers": [{"name": role, "image": NEW if current else OLD}]},
                "status": {"conditions": [{"type": "Ready", "status": "False" if deleting else "True"}],
                           "containerStatuses": [{"name": role, "state": state}]}}

    def replica_set(self, role, suffix):
        return {"kind": "ReplicaSet", "metadata": {"uid": f"{role}-rs-{suffix}",
                 "namespace": release.NAMESPACE,
                 "ownerReferences": [{"kind": "Deployment", "uid": role, "controller": True}]}}

    def kubectl(self, context, operation, *arguments, **kwargs):
        assert context == "test-ack"
        command, resource, *_ = arguments
        if command == "get" and resource == "service/huahuo-api":
            return json.dumps({"spec": {"type": "ClusterIP", "ports": [{"port": 3000, "targetPort": "http"}],
                "selector": self.live["api"]["spec"]["selector"]["matchLabels"]}})
        if command == "get" and resource == "serviceaccount/sa-huahuo-server":
            return resource
        if resource == "replicasets,pods":
            role = arguments[3].split("app.kubernetes.io/component=")[1].split(",")[0]
            current = self.live[role]["spec"]["template"]["spec"]["containers"][0]["image"] == NEW
            items = [self.replica_set(role, "new" if current else "old"), self.pod(role, current)]
            if current and role == "worker" and self.live[role]["metadata"]["generation"] == 2:
                self.worker_poll_count += 1
                if self.worker_poll_count == 1:
                    items += [self.replica_set(role, "old"), self.pod(role, False, deleting=True)]
                    self.events.append("old-worker-visible")
                else:
                    self.events.append("old-worker-gone")
            return json.dumps({"items": items})
        role = resource.removeprefix("deployment/huahuo-")
        if command == "get":
            return json.dumps(self.live[role])
        assert command == "patch"
        operations = json.loads(arguments[arguments.index("--patch") + 1])
        self.assert_patch(operations, role)
        if "--dry-run=server" in arguments:
            self.events.append(f"dry:{role}")
            if self.dry_run_failure == role:
                raise release.VerificationError("dry run rejected")
        else:
            self.events.append(f"patch:{role}")
        updated = copy.deepcopy(self.live[role])
        updated["metadata"]["generation"] = 2
        updated["status"]["observedGeneration"] = 2
        updated["spec"]["template"]["spec"]["containers"][0]["image"] = NEW
        if "--dry-run=server" not in arguments:
            self.live[role] = updated
        elif self.dry_run_drift == role:
            updated["spec"]["template"]["spec"]["serviceAccountName"] = "unexpected"
        return json.dumps(updated)

    def assert_patch(self, operations, role):
        assert operations[-1] == {"op": "replace", "path": "/spec/template/spec/containers/0/image", "value": NEW}
        assert {"op": "test", "path": "/metadata/uid", "value": role} in operations
        assert {"op": "test", "path": "/metadata/generation", "value": 1} in operations
        assert all(operation["op"] == "test" for operation in operations[:-1])


class ExistingRolloutTest(unittest.TestCase):
    def run_rollout(self, cluster, *, block_gate=False, concurrent_change=False):
        arguments = ["verify-candidate.py", "--context", "test-ack", "--image", NEW, "--rollout-existing",
                     "--expected-db-host", "db.test.invalid", "--expected-database", "huahuo-test", "--rollout-timeout", "30"]

        def check(context, role, stage, pod, *args, **kwargs):
            cluster.events.append(f"gate:{role}/{stage}")
            self.assertEqual(pod["containers"][0]["image"], NEW)
            if block_gate and stage == "db-preflight":
                raise release.VerificationError("database has pending migrations")
            if concurrent_change and (role, stage) == ("admin", "runtime"):
                cluster.live["scheduler"]["metadata"]["generation"] += 1

        with (patch.object(release.sys, "argv", arguments),
              patch.object(release, "kubectl", cluster.kubectl),
              patch.object(release, "read_workload", lambda context, role, image: cluster.candidate(role)),
              patch.object(release, "check", check),
              patch.object(release.time, "sleep")):
            return release.main()

    def test_waits_for_old_worker_even_when_deployment_status_already_looks_ready(self):
        cluster = FakeCluster()
        self.assertEqual(self.run_rollout(cluster), 0)
        self.assertEqual(cluster.events[:4], [f"dry:{role}" for role in ROLES])
        self.assertIn("gate:admin/runtime", cluster.events[:cluster.events.index("patch:worker")])
        self.assertEqual([event for event in cluster.events if event.startswith("patch:")],
                         [f"patch:{role}" for role in ROLES])
        self.assertLess(cluster.events.index("old-worker-visible"), cluster.events.index("old-worker-gone"))
        self.assertLess(cluster.events.index("old-worker-gone"), cluster.events.index("patch:scheduler"))

    def test_observed_forced_worker_exit_stops_scheduler_and_api_changes(self):
        cluster = FakeCluster()
        cluster.worker_exit_code = 124
        self.assertEqual(self.run_rollout(cluster), 1)
        self.assertEqual([event for event in cluster.events if event.startswith("patch:")], ["patch:worker"])

    def test_rejected_last_dry_run_or_migration_gate_never_patches_any_role(self):
        for blocked in ("dry-run", "admission-drift", "db-preflight", "changed-after-preflight"):
            with self.subTest(blocked=blocked):
                cluster = FakeCluster()
                if blocked == "dry-run":
                    cluster.dry_run_failure = "admin"
                if blocked == "admission-drift":
                    cluster.dry_run_drift = "admin"
                self.assertEqual(self.run_rollout(cluster, block_gate=blocked == "db-preflight",
                                                 concurrent_change=blocked == "changed-after-preflight"), 1)
                self.assertFalse(any(event.startswith("patch:") for event in cluster.events))

    def test_ready_deployments_at_requested_digest_are_not_restarted(self):
        cluster = FakeCluster()
        for deployment in cluster.live.values():
            deployment["spec"]["template"]["spec"]["containers"][0]["image"] = NEW
        self.assertEqual(self.run_rollout(cluster), 0)
        self.assertFalse(any(event.startswith("patch:") for event in cluster.events))


if __name__ == "__main__":
    unittest.main()
