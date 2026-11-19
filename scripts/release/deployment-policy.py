"""Small host-side checks; no deployment, config writes, or rollback operation."""
import os
import re
import subprocess


class ReleasePolicyError(RuntimeError):
    pass


def selected_roles(services, known_roles):
    if (not isinstance(services, list) or not services
            or any(not isinstance(role, str) or role not in known_roles for role in services)
            or len(set(services)) != len(services)):
        raise ReleasePolicyError("RELEASE_SERVICES_INVALID")
    return tuple(role for role in known_roles if role in services)


def successful_images(state, roles):
    images = state.get("roleImages")
    if not isinstance(images, dict) or set(images) != set(roles):
        raise ReleasePolicyError("RELEASE_IMAGE_RECORD_INVALID")
    for image in images.values():
        if (not isinstance(image, dict) or set(image) != {"image", "imageId"}
                or not isinstance(image["image"], str) or not re.fullmatch(r"huahuo-server:[0-9a-f]{40}", image["image"])
                or not isinstance(image["imageId"], str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", image["imageId"])):
            raise ReleasePolicyError("RELEASE_IMAGE_RECORD_INVALID")
    return {role: dict(images[role]) for role in roles}


def require_forward(repository, current_sha, candidate_sha):
    if any(not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{40}", value)
           for value in (current_sha, candidate_sha)):
        raise ReleasePolicyError("RELEASE_REVISION_INVALID")
    if current_sha == candidate_sha:
        return "verify-current"
    try:
        result = subprocess.run(
            ["git", "-C", str(repository), "merge-base", "--is-ancestor", current_sha, candidate_sha],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15, check=False,
            env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "GIT_OPTIONAL_LOCKS": "0",
                 "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull})
    except (OSError, subprocess.TimeoutExpired):
        raise ReleasePolicyError("RELEASE_HISTORY_UNAVAILABLE") from None
    if result.returncode == 1:
        raise ReleasePolicyError("RELEASE_NOT_FORWARD")
    if result.returncode != 0:
        raise ReleasePolicyError("RELEASE_HISTORY_UNAVAILABLE")
    return "deploy"


def require_unchanged_state(expected, actual):
    if not isinstance(expected, bytes) or not expected or expected != actual:
        raise ReleasePolicyError("RELEASE_STATE_CHANGED")


def require_same_runtime(expected_image, actual_image, expected_env, actual_env):
    if not isinstance(expected_image, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", expected_image):
        raise ReleasePolicyError("RELEASE_IMAGE_INVALID")
    if expected_image != actual_image:
        raise ReleasePolicyError("RELEASE_RUNNING_IMAGE_MISMATCH")
    if not isinstance(expected_env, dict) or not expected_env or not isinstance(actual_env, dict):
        raise ReleasePolicyError("RELEASE_RUNNING_CONFIGURATION_MISMATCH")
    if any(not isinstance(key, str) or not isinstance(value, str)
           for values in (expected_env, actual_env) for key, value in values.items()) or expected_env != actual_env:
        raise ReleasePolicyError("RELEASE_RUNNING_CONFIGURATION_MISMATCH")
