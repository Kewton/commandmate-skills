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
6. a `SKILL_VERSION` constant shipped in `scripts/lib.mjs` agrees with the
   manifest version;
7. `SKILL.md` is small enough for CommandMate's slash-command palette to load;
8. the artifact the package builds into is accepted by the strict reader;
9. building it twice produces byte-identical output.

Exit status is 0 only when every package passes all nine.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

import _bootstrap  # noqa: F401  (path setup)
from cmate_skills.constants import SKILL_MD_FILENAME
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
VERSION_CONSTANT_MISMATCH = "SKILLS_VERSION_CONSTANT_MISMATCH"
SKILL_MD_TOO_LARGE = "SKILLS_SKILL_MD_TOO_LARGE"

#: The one payload file a package may state its own version in a second time.
SKILL_LIB_PATH = "scripts/lib.mjs"

#: Ceiling on a shipped `SKILL.md`, in bytes.
#:
#: CommandMate's slash-command palette reads every installed `SKILL.md` through
#: `parseSkillFile()`, which stats the file first and returns `null` above
#: `MAX_SKILL_FILE_SIZE_BYTES` (65536). The Skill still installs, the skills API
#: still lists it, and the agent still reads it — only the palette entry is gone,
#: with nothing but a `logger.warn` to say why (Issue #135, measured on
#: `cmate-orchestrate` 0.20.0 at 71,383 bytes).
#:
#: That constant belongs to upstream, so this one deliberately sits below it: a
#: package that is growing is stopped here, while there is still room to land the
#: fix, rather than at the cliff edge where the next paragraph breaks the palette.
SKILL_MD_MAX_SIZE = 60_000

#: What to do about it. `SKILL.md` answers "when do I use this, how do I call it,
#: how do I read the output, what do I do when it stops"; everything else belongs
#: in `references/` behind a one-way link. That split is the package convention
#: since 0.14.0 — see the `references/release-notes.md` entry that introduced it.
SKILL_MD_REMEDY = (
    "move the mechanism detail into references/ and link to it one-way "
    "(the 0.14.0 convention; see references/release-notes.md)"
)

#: `export const SKILL_VERSION = '0.17.0';` as it stands in that file. Quotes and
#: spacing are loose because the constant is authored by hand, but the name is
#: exact: a `SKILL_VERSION_FALLBACK` must not be mistaken for the declaration.
SKILL_VERSION_DECLARATION = re.compile(
    r"^\s*export\s+const\s+SKILL_VERSION\s*=\s*(['\"])(?P<version>[^'\"]*)\1",
    re.MULTILINE,
)

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


def check_version_constant(check, out: list[Finding]) -> None:
    """Require a shipped `SKILL_VERSION` constant to equal the manifest version.

    A package whose runners are Node scripts stamps this constant into the
    reports it writes, so the constant — not the manifest — is what a bug report
    is triaged by. Left behind by a release, it names a version the user never
    installed, and nothing else in the pipeline can see the disagreement: the
    constant is payload text, and the manifest digest over it is happy either
    way. Bumping a package therefore has to touch both, and this is what says so.

    The comparison is against `check.manifest`, already parsed under the safe
    YAML profile, and against `check.payload`, already read as the bytes the
    build will pack — so neither side can be a file this run never validated.

    A package with no `scripts/lib.mjs`, or one whose `lib.mjs` declares no such
    constant, has nothing to disagree with and passes silently.
    """
    if check.manifest is None or check.payload is None:
        return

    entry = next((f for f in check.payload if f.path == SKILL_LIB_PATH), None)
    if entry is None:
        return

    # Payload bytes are not guaranteed to be UTF-8 here; a byte that is not is
    # not a version digit either, so it is replaced rather than raised on.
    match = SKILL_VERSION_DECLARATION.search(entry.data.decode("utf-8", "replace"))
    if match is None:
        return

    declared = match.group("version")
    if declared != check.manifest["version"]:
        out.append(
            Finding(
                VERSION_CONSTANT_MISMATCH,
                SKILL_LIB_PATH,
                "SKILL_VERSION does not match the manifest version",
                {"lib": declared, "manifest": check.manifest["version"]},
            )
        )


def check_skill_md_size(check, out: list[Finding]) -> None:
    """Require the shipped `SKILL.md` to stay under `SKILL_MD_MAX_SIZE`.

    An oversized `SKILL.md` fails in the one place nothing else looks: the
    package validates, builds, installs and runs, and the only symptom is that
    the slash command never appears in the palette. Nobody notices until someone
    goes looking for it, which is what happened with `cmate-orchestrate` 0.20.0.
    So the check runs here, where `.commandmate/verify.yaml` and both CI jobs
    already run it, and where a release therefore cannot get past it — the same
    shape as the `SKILL_VERSION` check above.

    The measurement is `len(entry.data)` over `check.payload`, the bytes the
    build will pack, rather than a `stat()` of the working tree: the two agree
    today, but only the former is the file a user ends up installing.

    A package whose tree could not be read has no payload to measure and is
    already failing on that; `SKILL.md` itself being absent is reported by
    `check_package`.
    """
    if check.payload is None:
        return

    entry = next((f for f in check.payload if f.path == SKILL_MD_FILENAME), None)
    if entry is None:
        return

    size = len(entry.data)
    if size > SKILL_MD_MAX_SIZE:
        out.append(
            Finding(
                SKILL_MD_TOO_LARGE,
                SKILL_MD_FILENAME,
                f"SKILL.md is too large for the slash-command palette to load: {SKILL_MD_REMEDY}",
                {"size": size, "maxSize": SKILL_MD_MAX_SIZE, "over": size - SKILL_MD_MAX_SIZE},
            )
        )


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
        check_version_constant(check, findings)
        check_skill_md_size(check, findings)

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
