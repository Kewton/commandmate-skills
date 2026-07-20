#!/usr/bin/env python3
"""Validate every Skill package and Catalog document in the repository.

Run by `.github/workflows/validate.yml` on every pull request, and by
contributors before opening one:

    python3 scripts/validate.py

What it proves, in the order it proves it:

1. the manifest parses under the safe YAML profile CommandMate uses;
2. the manifest satisfies the `schema_version: 1` contract;
3. the declared file set matches the directory exactly, on path, digest, size,
   kind, script flag and executable bit;
4. nothing in the package is a symlink, a special file or setuid/setgid/sticky;
5. no known credential shape and no plaintext `http://` link ships;
6. the artifact the package builds into is accepted by the strict reader;
7. building it twice produces byte-identical output.

Exit status is 0 only when every package passes all seven.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import _bootstrap  # noqa: F401  (path setup)
from cmate_skills.errors import ContractError, Finding
from cmate_skills.package import sha256_hex
from cmate_skills.repo import build_and_verify, check_package, discover_skill_dirs
from cmate_skills.schema import validate_catalog

#: Revision of `Kewton/CommandMate` whose contract this repository mirrors.
#: Bump it together with any change under `scripts/cmate_skills/`, and record the
#: diff in `docs/design/contract-sync.md`.
CONTRACT_UPSTREAM_REVISION = "22014bb9"

REPRODUCIBILITY_MISMATCH = "SKILLS_REPRODUCIBILITY_MISMATCH"
CATALOG_UNREADABLE = "SKILLS_CATALOG_UNREADABLE"
GOVERNANCE_MISSING = "SKILLS_GOVERNANCE_MISSING"

#: Files that define who reviews what. Their absence is a process failure that
#: CI can see, so it is checked here rather than trusted to stay in place.
REQUIRED_GOVERNANCE_FILES = (
    "LICENSE",
    "SECURITY.md",
    "CONTRIBUTING.md",
    ".github/CODEOWNERS",
)


def _annotation_safe(text: str) -> str:
    """Escape a value for a GitHub Actions workflow command.

    A finding can quote a path chosen by whoever opened the pull request, and git
    permits newlines in filenames. Printed raw, a newline ends the workflow
    command and everything after it is parsed as a new one — `::stop-commands::`
    and friends. `%` must be escaped first or it would corrupt the escapes added
    after it.
    """
    escaped = text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    return "".join(ch if ch.isprintable() or ch == " " else "?" for ch in escaped)


def _emit(scope: str, finding: Finding) -> None:
    """Print a finding, and annotate it in the GitHub UI when running there.

    The annotation is anchored to `scope` — the repo-relative path of the package
    or document — rather than to `finding.path`, which may be a JSON pointer or a
    path relative to the package root. A pointer in the `file=` field silently
    produces an annotation attached to nothing.
    """
    print(f"  {finding}")
    if os.environ.get("GITHUB_ACTIONS") == "true":
        print(
            f"::error file={_annotation_safe(scope)},"
            f"title={_annotation_safe(finding.code)}::{_annotation_safe(str(finding))}"
        )


def check_reproducible(check, out: list[Finding]) -> bytes | None:
    """Build twice and require byte-identical output.

    Two builds in the same process share every input except the moment they run,
    so a difference here is a build that reads something it should not: the
    clock, the environment, or iteration order that is not actually sorted.
    """
    try:
        first = build_and_verify(check)
        second = build_and_verify(check)
    except ContractError as error:
        out.append(error.as_finding(check.directory.name))
        return None

    if first != second:
        out.append(
            Finding(
                REPRODUCIBILITY_MISMATCH,
                check.directory.name,
                "two builds of the same source produced different bytes",
                {"first": sha256_hex(first)[:16], "second": sha256_hex(second)[:16]},
            )
        )
        return None
    return first


def validate_catalogs(catalog_root: Path) -> tuple[int, int]:
    """Validate every Catalog JSON under `catalog/`."""
    failures = 0
    checked = 0
    for path in sorted(catalog_root.rglob("*.json")):
        checked += 1
        relative = path.as_posix()
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            print(f"FAIL {relative}")
            _emit(relative, Finding(CATALOG_UNREADABLE, relative, f"catalog is not readable JSON: {error}"))
            failures += 1
            continue

        catalog, findings = validate_catalog(document)
        if catalog is None or findings:
            print(f"FAIL {relative}")
            for finding in findings:
                _emit(relative, finding)
            failures += 1
            continue
        entries = len(catalog["entries"])
        versions = sum(len(entry["versions"]) for entry in catalog["entries"])
        print(f"OK   {relative} ({entries} entries, {versions} versions)")
    return checked, failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--skills-root",
        action="append",
        default=None,
        help="directory holding Skill packages (repeatable, default: skills/)",
    )
    parser.add_argument(
        "--repo-root",
        default=str(_bootstrap.REPO_ROOT),
        help="repository root (default: the checkout this script lives in)",
    )
    args = parser.parse_args()

    repo_root = Path(args.repo_root).resolve()
    roots = [Path(entry) for entry in (args.skills_root or ["skills"])]
    roots = [root if root.is_absolute() else repo_root / root for root in roots]

    print(f"contract mirror: Kewton/CommandMate@{CONTRACT_UPSTREAM_REVISION}")
    print(f"repository root: {repo_root}")
    print()

    failures = 0

    print("== governance ==")
    for name in REQUIRED_GOVERNANCE_FILES:
        if (repo_root / name).is_file():
            print(f"OK   {name}")
        else:
            print(f"FAIL {name}")
            _emit(name, Finding(GOVERNANCE_MISSING, name, "required governance file is missing"))
            failures += 1
    print()

    print("== skill packages ==")
    packages = [directory for root in roots for directory in discover_skill_dirs(root)]
    if not packages:
        print("(no Skill packages found; only placeholder directories)")
    for directory in packages:
        # `--skills-root` may point outside the checkout (the release job builds
        # from a staged copy), so a path that is not under the repo root is
        # reported by its own path rather than crashing the run.
        try:
            relative = directory.relative_to(repo_root).as_posix()
        except ValueError:
            relative = directory.as_posix()
        check = check_package(directory, repo_root)
        findings = list(check.findings)

        artifact = None
        if check.manifest is not None and not findings:
            artifact = check_reproducible(check, findings)

        if findings:
            print(f"FAIL {relative}")
            for finding in findings:
                _emit(relative, finding)
            failures += 1
            continue

        assert artifact is not None and check.manifest is not None
        print(
            f"OK   {relative} "
            f"v{check.manifest['version']} "
            f"({len(check.manifest['files'])} declared files, "
            f"{len(artifact)} bytes, sha256 {sha256_hex(artifact)[:16]}…, reproducible)"
        )
    print()

    print("== catalog ==")
    checked, catalog_failures = validate_catalogs(repo_root / "catalog")
    if checked == 0:
        print("(no Catalog document published yet)")
    failures += catalog_failures
    print()

    if failures:
        print(f"FAILED: {failures} check(s) did not pass")
        return 1
    print("PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
