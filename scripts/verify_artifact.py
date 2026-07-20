#!/usr/bin/env python3
"""Keyless verification of a published artifact against the Catalog.

    python3 scripts/verify_artifact.py \
        --catalog catalog/v1/catalog.json \
        --skill <skill-id> --version <x.y.z> \
        --artifact ./downloaded.tar.gz

There is no signature and no PKI in this phase, on purpose (see `SECURITY.md`).
What replaces them is a chain anyone can walk with a checksum tool:

    Catalog `versions[].artifact.sha256`
      -> the bytes of the release asset
        -> `commandmate.skill.yaml` inside it
          -> every payload file's own digest

This script walks that chain and prints each link's verdict. It reads local
files only; downloading is the operator's step, so the tool never becomes a way
to fetch and trust something in one motion.

Exit status is 0 only when every link holds.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import _bootstrap  # noqa: F401  (path setup)
from cmate_skills.constants import (
    SKILL_ARTIFACT_CONTENT_TYPE,
    SKILL_MANIFEST_FILENAME,
    SKILL_MD_FILENAME,
    build_skill_asset_name,
)
from cmate_skills.errors import ContractError
from cmate_skills.package import read_package, sha256_hex
from cmate_skills.repo import derive_file_kind, is_script_payload
from cmate_skills.safe_yaml import SkillYamlError, parse_skill_yaml
from cmate_skills.schema import (
    compute_risk,
    resolve_effective_risk,
    validate_catalog,
    validate_manifest,
    validate_manifest_file_set,
)


class Report:
    def __init__(self) -> None:
        self.failed = False

    def check(self, label: str, ok: bool, detail: str = "") -> bool:
        mark = "ok  " if ok else "FAIL"
        suffix = f"  {detail}" if detail else ""
        print(f"[{mark}] {label}{suffix}")
        if not ok:
            self.failed = True
        return ok


def _find_version(catalog: dict[str, Any], skill_id: str, version: str) -> dict[str, Any] | None:
    for entry in catalog["entries"]:
        if entry["id"] != skill_id:
            continue
        for candidate in entry["versions"]:
            if candidate["version"] == version:
                return candidate
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--skill", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--artifact", required=True, help="path to the downloaded release asset")
    args = parser.parse_args()

    report = Report()

    try:
        catalog_document = json.loads(Path(args.catalog).read_text(encoding="utf-8"))
        artifact = Path(args.artifact).read_bytes()
    except (OSError, json.JSONDecodeError) as error:
        # Read both inputs up front: a verification that fails halfway through
        # because a path was mistyped reads exactly like one that failed because
        # the bytes were wrong, and those are very different situations.
        print(f"[FAIL] cannot read an input: {error}")
        return 1

    catalog, findings = validate_catalog(catalog_document)
    if catalog is None:
        print("[FAIL] catalog does not satisfy the contract")
        for finding in findings:
            print(f"       {finding}")
        return 1
    report.check("catalog satisfies schema_version 1", True)

    published = _find_version(catalog, args.skill, args.version)
    if published is None:
        print(f"[FAIL] catalog has no {args.skill} {args.version}")
        return 1
    report.check("catalog lists the requested version", True, f"commit {published['source']['commit']}")

    digest = sha256_hex(artifact)

    report.check(
        "artifact sha256 matches the Catalog",
        digest == published["artifact"]["sha256"],
        digest,
    )
    report.check(
        "artifact size matches the Catalog",
        len(artifact) == published["artifact"]["size"],
        f"{len(artifact)} bytes",
    )
    report.check(
        "asset name follows the contract",
        published["artifact"]["asset_name"] == build_skill_asset_name(args.skill, args.version),
        published["artifact"]["asset_name"],
    )
    report.check(
        "content type is the fixed artifact media type",
        published["artifact"]["content_type"] == SKILL_ARTIFACT_CONTENT_TYPE,
    )
    if report.failed:
        print("\nVERDICT: REJECT — the bytes are not what the Catalog published.")
        return 1

    try:
        table = read_package(artifact, args.skill, args.version)
    except ContractError as error:
        print(f"[FAIL] archive rejected: {error.code}: {error}")
        print("\nVERDICT: REJECT")
        return 1
    report.check(
        "archive parses under the strict reader",
        True,
        f"root={table.root_name or '(none)'}, {len(table.files)} files",
    )
    # CommandMate also accepts a rootless archive and a `<skill-id>-<version>`
    # root, but this repository's build only ever emits `<skill-id>/`. An
    # official artifact shaped any other way was not produced by this pipeline,
    # which is exactly what an audit tool should say out loud.
    report.check(
        "archive root is the skill id",
        table.root_name == args.skill,
        f"root={table.root_name or '(none)'}",
    )

    for required in (SKILL_MD_FILENAME, SKILL_MANIFEST_FILENAME):
        report.check(f"required entry {required} present", table.find(required) is not None)

    manifest_entry = table.find(SKILL_MANIFEST_FILENAME)
    if manifest_entry is None:
        print("\nVERDICT: REJECT")
        return 1

    try:
        document = parse_skill_yaml(manifest_entry.data)
    except SkillYamlError as error:
        print(f"[FAIL] manifest rejected by the safe YAML profile: {error}")
        print("\nVERDICT: REJECT")
        return 1
    manifest, manifest_findings = validate_manifest(document)
    if manifest is None:
        print("[FAIL] manifest does not satisfy the contract")
        for finding in manifest_findings:
            print(f"       {finding}")
        print("\nVERDICT: REJECT")
        return 1
    report.check("manifest satisfies schema_version 1", True)

    report.check("manifest id matches the Catalog", manifest["id"] == args.skill)
    report.check("manifest version matches the Catalog", manifest["version"] == args.version)

    set_findings = validate_manifest_file_set(manifest, [entry.path for entry in table.files])
    report.check("manifest file set matches the archive exactly", not set_findings)
    for finding in set_findings:
        print(f"       {finding}")

    declared_by_path = {entry["path"]: entry for entry in manifest["files"]}
    mismatches: list[str] = []
    for entry in table.files:
        if entry.path == SKILL_MANIFEST_FILENAME:
            continue
        declared = declared_by_path.get(entry.path)
        if declared is None:
            continue
        if declared["sha256"] != entry.sha256:
            mismatches.append(f"{entry.path}: digest")
        if declared["size"] != entry.size:
            mismatches.append(f"{entry.path}: size")
        if declared["executable"] != entry.executable:
            mismatches.append(f"{entry.path}: executable bit")
        if is_script_payload(entry.path, entry.data) and not declared["script"]:
            mismatches.append(f"{entry.path}: undeclared script")
        if (derive_file_kind(entry.path, entry.data) == "skill_md") != (declared["kind"] == "skill_md"):
            mismatches.append(f"{entry.path}: kind")
    report.check("every payload file matches its declaration", not mismatches)
    for mismatch in mismatches:
        print(f"       {mismatch}")

    computed = compute_risk(
        executable_paths=[f["path"] for f in manifest["files"] if f["executable"]],
        script_paths=[f["path"] for f in manifest["files"] if f["script"]],
        network_hosts=manifest["requirements"]["network_hosts"],
        declared_permissions=manifest["declared_permissions"],
    )
    effective = resolve_effective_risk(manifest["declared_risk"], computed)
    report.check(
        "Catalog declared_risk matches the manifest",
        published["declared_risk"] == manifest["declared_risk"],
    )

    print()
    print(f"skill            {manifest['id']} {manifest['version']}")
    print(f"provider         {manifest['provider']['name']}  license {manifest['license']}")
    print(f"source commit    {published['source']['commit']}")
    print(f"declared risk    {manifest['declared_risk']}")
    print(f"computed risk    {computed}")
    print(f"effective risk   {effective}")
    print(f"permissions      {', '.join(manifest['declared_permissions']) or '(none)'}")
    print("                 declared by the publisher; not sandbox enforcement")
    scripts = [f['path'] for f in manifest["files"] if f["script"]]
    executables = [f['path'] for f in manifest["files"] if f["executable"]]
    print(f"scripts          {', '.join(scripts) or '(none)'}")
    print(f"executables      {', '.join(executables) or '(none)'}")
    print()

    if report.failed:
        print("VERDICT: REJECT")
        return 1
    print("VERDICT: ACCEPT — every link from the Catalog to the payload bytes holds.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
