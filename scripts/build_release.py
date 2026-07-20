#!/usr/bin/env python3
"""Build one release artifact reproducibly and record what was built.

    python3 scripts/build_release.py --skill <skill-id> \
        --repository Kewton/commandmate-skills \
        --ref <tag> --commit <40-hex-sha> \
        --out dist/

Produces, under `--out`:

  <skill-id>-<version>.tar.gz          the release asset
  <skill-id>-<version>.tar.gz.sha256   `sha256sum -c` compatible checksum line
  <skill-id>-<version>.build.json      what was built, for the Catalog step

The artifact is built **twice** and the two results are compared byte for byte.
A release that cannot reproduce its own artifact within one job will not
reproduce it for an auditor either, so the mismatch stops the release here
rather than becoming a Catalog entry nobody can verify.

This script never uploads anything and never talks to the network. Publishing is
a separate, explicitly-permissioned step (see `.github/workflows/release.yml`).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import _bootstrap  # noqa: F401  (path setup)
from cmate_skills.constants import (
    GIT_COMMIT_SHA_PATTERN,
    REPOSITORY_SLUG_PATTERN,
    SKILL_ARTIFACT_CONTENT_TYPE,
    SKILL_ARTIFACT_FORMAT,
    SKILL_ID_PATTERN,
    build_skill_asset_name,
)
from cmate_skills.errors import ContractError
from cmate_skills.package import sha256_hex
from cmate_skills.repo import build_and_verify, check_package
from cmate_skills.semver import is_valid_semver


def parse_release_tag(tag: str) -> tuple[str, str] | None:
    """Split a `<skill-id>-v<version>` release tag into its two halves.

    Release tags are per-Skill because official Skills have independent release
    lifecycles: `cmate-issue-refinement-v1.2.0`.

    A skill id may itself contain `-v...`, so every candidate split is tried and
    exactly one must produce a valid id *and* a valid SemVer. An ambiguous tag is
    refused rather than guessed at: guessing here would publish an asset named
    after a version nobody chose.
    """
    matches = [
        (tag[:index], tag[index + 2 :])
        for index in range(len(tag) - 1)
        if tag[index : index + 2] == "-v"
    ]
    valid = [
        (skill, version)
        for skill, version in matches
        if SKILL_ID_PATTERN.match(skill) and is_valid_semver(version)
    ]
    return valid[0] if len(valid) == 1 else None


def fail(message: str) -> int:
    print(f"error: {message}", file=sys.stderr)
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skill", help="skill id (directory name under --skills-root)")
    parser.add_argument(
        "--tag",
        help="release tag in the form <skill-id>-v<version>; implies --skill and --ref",
    )
    parser.add_argument("--skills-root", default="skills")
    parser.add_argument("--repo-root", default=str(_bootstrap.REPO_ROOT))
    parser.add_argument("--out", default="dist", help="output directory (created if absent)")
    parser.add_argument("--repository", required=True, help="owner/name of the source repository")
    parser.add_argument("--ref", help="human-facing git ref (the release tag)")
    parser.add_argument(
        "--commit",
        required=True,
        help="resolved 40-hex commit SHA; a tag alone is not trusted as provenance",
    )
    args = parser.parse_args()

    tag_version: str | None = None
    if args.tag:
        parsed = parse_release_tag(args.tag)
        if parsed is None:
            return fail(f"tag {args.tag!r} is not in the form <skill-id>-v<version>")
        skill, tag_version = parsed
        if args.skill and args.skill != skill:
            return fail(f"--skill {args.skill} disagrees with the tag's skill id {skill}")
        args.skill = skill
        args.ref = args.ref or args.tag
    if not args.skill:
        return fail("one of --skill or --tag is required")
    if not args.ref:
        return fail("--ref is required when --tag is not given")

    repo_root = Path(args.repo_root).resolve()
    skills_root = Path(args.skills_root)
    if not skills_root.is_absolute():
        skills_root = repo_root / skills_root
    directory = skills_root / args.skill

    if not REPOSITORY_SLUG_PATTERN.match(args.repository):
        return fail("--repository must be owner/name")
    if not GIT_COMMIT_SHA_PATTERN.match(args.commit):
        # An abbreviated SHA is ambiguous forever after; a tag can be moved.
        return fail("--commit must be a resolved, lowercase, 40-character commit SHA")
    if not directory.is_dir():
        return fail(f"no Skill package at {directory}")

    check = check_package(directory, repo_root)
    if check.findings:
        print(f"package {args.skill} did not validate:", file=sys.stderr)
        for finding in check.findings:
            print(f"  {finding}", file=sys.stderr)
        return fail("refusing to build an unvalidated package")
    assert check.manifest is not None

    # The tag is what a human typed; the manifest is what will be installed. If
    # they disagree, the release would publish `<skill>-<manifest version>.tar.gz`
    # under a tag naming a different version, and every later audit would have to
    # guess which one was meant.
    if tag_version is not None and tag_version != check.manifest["version"]:
        return fail(
            f"tag says version {tag_version} but the manifest says {check.manifest['version']}"
        )

    try:
        first = build_and_verify(check)
        second = build_and_verify(check)
    except ContractError as error:
        return fail(f"{error.code}: {error}")

    if first != second:
        return fail(
            "reproducibility check failed: two builds of the same source differ "
            f"({sha256_hex(first)} vs {sha256_hex(second)})"
        )

    skill_id = check.manifest["id"]
    version = check.manifest["version"]
    asset_name = build_skill_asset_name(skill_id, version)
    digest = sha256_hex(first)

    out_dir = Path(args.out)
    if not out_dir.is_absolute():
        out_dir = repo_root / out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    artifact_path = out_dir / asset_name
    artifact_path.write_bytes(first)
    (out_dir / f"{asset_name}.sha256").write_text(f"{digest}  {asset_name}\n", encoding="utf-8")

    build_record = {
        "skill_id": skill_id,
        "version": version,
        "asset_name": asset_name,
        "sha256": digest,
        "size": len(first),
        "content_type": SKILL_ARTIFACT_CONTENT_TYPE,
        "format": SKILL_ARTIFACT_FORMAT,
        "reproducible": True,
        "source": {"repository": args.repository, "ref": args.ref, "commit": args.commit},
        "manifest": {
            "name": check.manifest["name"],
            "summary": check.manifest["summary"],
            "provider": check.manifest["provider"],
            "license": check.manifest["license"],
            "homepage": check.manifest.get("homepage"),
            "keywords": check.manifest.get("keywords"),
            "compatibility": check.manifest["compatibility"],
            "declared_risk": check.manifest["declared_risk"],
        },
    }
    record_path = out_dir / f"{asset_name.removesuffix('.tar.gz')}.build.json"
    record_path.write_text(json.dumps(build_record, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    print(f"skill        {skill_id}")
    print(f"version      {version}")
    print(f"asset        {asset_name}")
    print(f"sha256       {digest}")
    print(f"size         {len(first)} bytes")
    print(f"commit       {args.commit}")
    print("reproducible yes (two independent builds, byte-identical)")
    print(f"artifact     {artifact_path}")
    print(f"record       {record_path}")

    # Hand the facts to the workflow rather than making it re-parse this output.
    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a", encoding="utf-8") as handle:
            handle.write(f"skill_id={skill_id}\n")
            handle.write(f"version={version}\n")
            handle.write(f"asset_name={asset_name}\n")
            handle.write(f"sha256={digest}\n")
            handle.write(f"size={len(first)}\n")
            handle.write(f"artifact_path={artifact_path}\n")
            handle.write(f"record_path={record_path}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
