#!/usr/bin/env python3
"""Render a single release workload with an immutable OCI image reference."""

import argparse
import json
import re
import sys
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("role", choices=("api", "worker", "scheduler", "admin", "migrate"))
    parser.add_argument("--image", required=True)
    args = parser.parse_args()

    image_pattern = (
        r"[a-z0-9][a-z0-9.:-]*/[a-z0-9][a-z0-9._/-]*"
        r"(?::[A-Za-z0-9_.-]+)?@sha256:[0-9a-f]{64}"
    )
    if re.fullmatch(image_pattern, args.image) is None:
        parser.error("--image must be a registry/repository reference pinned to a sha256 digest")

    filename = "migrate-job.yaml" if args.role == "migrate" else f"{args.role}.yaml"
    root = Path(__file__).resolve().parent
    template = (root / "manifests" / filename).read_text(encoding="utf-8")
    placeholder = "huahuo-server:replace-me"
    if template.count(placeholder) != 1:
        parser.exit(1, f"{filename} must have exactly one image placeholder\n")
    template = template.replace(placeholder, args.image)
    if args.role == "migrate":
        program = (root / "migrate-with-runtime-grants.mjs").read_text(encoding="utf-8")
        grants = (root / "shared-runtime-grants.sql").read_text(encoding="utf-8")
        program_placeholder = "__HUAHUO_ACK_MIGRATE_COMMAND__"
        grants_placeholder = '"__HUAHUO_RUNTIME_GRANTS_SQL__"'
        if template.count(program_placeholder) != 1 or program.count(grants_placeholder) != 1:
            parser.exit(1, "migrate Job must include its command and SQL placeholders exactly once\n")
        program = program.replace(grants_placeholder, json.dumps(grants))
        command = json.dumps(["node", "--input-type=module", "-e", program])
        template = template.replace(program_placeholder, command)
    sys.stdout.write(template)


if __name__ == "__main__":
    main()
