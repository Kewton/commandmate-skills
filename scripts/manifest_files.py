#!/usr/bin/env python3
"""Print the `files:` block for a Skill package's manifest.

    python3 scripts/manifest_files.py skills/<skill-id>

Digest, size, kind, script flag and executable bit all have to match the bytes on
disk exactly, and hand-maintaining them is how a package ends up failing CI for a
reason that has nothing to do with what changed. Regenerate the block with this
and paste it over the `files:` key.

The output is deliberately paste-ready YAML rather than an in-place rewrite: a
manifest carries review-relevant prose (`risk_rationale`, `capabilities`) that no
tool should be free to reformat.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import _bootstrap  # noqa: F401  (path setup)
from cmate_skills.constants import SKILL_MANIFEST_FILENAME
from cmate_skills.errors import Finding
from cmate_skills.package import sha256_hex
from cmate_skills.repo import derive_file_kind, is_script_payload, read_tree


#: Characters that need no quoting in a YAML plain scalar. Anything else — most
#: importantly ` #`, which would otherwise start a comment and silently truncate
#: the path — is emitted single-quoted.
_PLAIN_SAFE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]*$")


def _yaml_scalar(value: str) -> str:
    if _PLAIN_SAFE.match(value):
        return value
    return "'" + value.replace("'", "''") + "'"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", help="Skill package directory")
    args = parser.parse_args()

    directory = Path(args.directory)
    if not directory.is_dir():
        print(f"error: no directory at {directory}", file=sys.stderr)
        return 1

    findings: list[Finding] = []
    payload = read_tree(directory, findings)
    if payload is None:
        for finding in findings:
            print(f"error: {finding}", file=sys.stderr)
        return 1

    print("files:")
    for entry in sorted(payload, key=lambda item: item.path):
        if entry.path == SKILL_MANIFEST_FILENAME:
            # The manifest never declares a digest for itself: the artifact's own
            # SHA-256 lives in the Catalog, so a self-digest would be circular.
            continue
        kind = derive_file_kind(entry.path, entry.data)
        script = is_script_payload(entry.path, entry.data)
        print(f"  - path: {_yaml_scalar(entry.path)}")
        print(f"    sha256: {sha256_hex(entry.data)}")
        print(f"    size: {len(entry.data)}")
        print(f"    kind: {kind}")
        print(f"    executable: {str(entry.executable).lower()}")
        print(f"    script: {str(script).lower()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
