#!/usr/bin/env python3
"""Merge a build record into the versioned Catalog.

    python3 scripts/build_catalog.py \
        --record dist/<skill-id>-<version>.build.json \
        --changelog-file dist/changelog.md \
        --published-at 2026-07-20T09:30:00Z \
        --catalog catalog/v1/catalog.json \
        --snapshot-out dist/

The Catalog is *append-only per version*. Re-publishing a version that already
exists is refused rather than overwritten: CommandMate pins an install to
`versions[].artifact.sha256`, so silently changing the bytes behind a published
version would break every receipt already written against it.

Two artifacts come out of this step:

- `catalog/v1/catalog.json`, committed, carrying the full version history. This
  is what CommandMate fetches.
- `catalog-<skill-id>-<version>.json`, an immutable snapshot uploaded next to the
  release asset, so the Catalog state at the moment of a release stays
  retrievable even after later versions land.
"""

from __future__ import annotations

import argparse
import json
import sys
from functools import cmp_to_key
from pathlib import Path
from typing import Any

import _bootstrap  # noqa: F401  (path setup)
from cmate_skills.constants import (
    RFC3339_UTC_PATTERN,
    SKILL_CHANGELOG_MAX_LENGTH,
    SKILL_SCHEMA_VERSION,
    build_skill_asset_name,
)
from cmate_skills.schema import validate_catalog
from cmate_skills.semver import compare_semver, is_valid_semver, parse_semver

#: Where a GitHub release asset is served from. The Catalog stores the resolved
#: download URL so CommandMate never has to guess a hosting layout.
ASSET_URL_TEMPLATE = "https://github.com/{repository}/releases/download/{ref}/{asset_name}"


def fail(message: str) -> int:
    print(f"error: {message}", file=sys.stderr)
    return 1


def _version_entry(record: dict[str, Any], changelog: str, published_at: str) -> dict[str, Any]:
    manifest = record["manifest"]
    source = record["source"]
    return {
        "version": record["version"],
        "changelog": changelog,
        "published_at": published_at,
        "source": {
            "repository": source["repository"],
            "ref": source["ref"],
            # Resolved SHA, never the tag: a tag can be moved after review.
            "commit": source["commit"],
        },
        "artifact": {
            "asset_name": record["asset_name"],
            "url": ASSET_URL_TEMPLATE.format(
                repository=source["repository"], ref=source["ref"], asset_name=record["asset_name"]
            ),
            "sha256": record["sha256"],
            "size": record["size"],
            "content_type": record["content_type"],
            "format": record["format"],
        },
        "compatibility": manifest["compatibility"],
        "declared_risk": manifest["declared_risk"],
    }


def _entry_shell(record: dict[str, Any]) -> dict[str, Any]:
    manifest = record["manifest"]
    entry: dict[str, Any] = {
        "id": record["skill_id"],
        "name": manifest["name"],
        "summary": manifest["summary"],
        "provider": manifest["provider"],
        "license": manifest["license"],
    }
    if manifest.get("homepage"):
        entry["homepage"] = manifest["homepage"]
    if manifest.get("keywords"):
        entry["keywords"] = manifest["keywords"]
    entry["latest"] = record["version"]
    entry["versions"] = []
    return entry


def _resolve_latest(versions: list[dict[str, Any]]) -> str:
    """Highest release version, falling back to the highest prerelease.

    A prerelease never becomes `latest` while a stable release exists, so
    publishing a release candidate cannot move every user onto it.
    """
    parsed = [(v["version"], parse_semver(v["version"])) for v in versions]
    stable = [name for name, semver in parsed if semver is not None and not semver.prerelease]
    candidates = stable or [name for name, semver in parsed if semver is not None]
    best = candidates[0]
    for candidate in candidates[1:]:
        if (compare_semver(candidate, best) or 0) > 0:
            best = candidate
    return best


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--record", required=True, help="build record from build_release.py")
    parser.add_argument("--catalog", default="catalog/v1/catalog.json")
    parser.add_argument("--repo-root", default=str(_bootstrap.REPO_ROOT))
    parser.add_argument("--changelog-file", help="file holding this version's changelog text")
    parser.add_argument("--changelog", help="changelog text, if not read from a file")
    parser.add_argument("--published-at", required=True, help="RFC 3339 UTC instant, `Z` suffix")
    parser.add_argument("--snapshot-out", help="directory to write the immutable Catalog snapshot into")
    args = parser.parse_args()

    repo_root = Path(args.repo_root).resolve()
    try:
        record = json.loads(Path(args.record).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return fail(f"cannot read the build record at {args.record}: {error}")

    if not record.get("reproducible"):
        return fail("build record is not marked reproducible; refusing to publish it")
    if not RFC3339_UTC_PATTERN.match(args.published_at):
        return fail("--published-at must be an RFC 3339 UTC instant such as 2026-07-20T09:30:00Z")

    if args.changelog_file:
        changelog = Path(args.changelog_file).read_text(encoding="utf-8").strip()
    elif args.changelog:
        changelog = args.changelog.strip()
    else:
        return fail("one of --changelog-file or --changelog is required")
    if not changelog:
        return fail("changelog must not be empty: a version nobody can describe is not reviewable")
    if len(changelog) > SKILL_CHANGELOG_MAX_LENGTH:
        return fail(f"changelog exceeds {SKILL_CHANGELOG_MAX_LENGTH} characters")

    # Checked before anything downstream reads it: `_resolve_latest` and the
    # duplicate check both order by SemVer precedence, and a version they cannot
    # parse would surface as a traceback rather than a refusal — in the publish
    # job, that happens *after* the release is already public.
    if not is_valid_semver(record.get("version")):
        return fail(f"build record version {record.get('version')!r} is not SemVer 2.0")
    expected_asset = build_skill_asset_name(record["skill_id"], record["version"])
    if record["asset_name"] != expected_asset:
        return fail(f"build record asset name is {record['asset_name']}, expected {expected_asset}")

    catalog_path = Path(args.catalog)
    if not catalog_path.is_absolute():
        catalog_path = repo_root / catalog_path

    if catalog_path.is_file():
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
        # The Catalog being merged into is validated before it is trusted. A
        # hand-edited or half-written file would otherwise be carried forward
        # into a published document, and every field read below (versions,
        # SemVer precedence) assumes it already satisfies the contract.
        _, existing_findings = validate_catalog(catalog)
        if existing_findings:
            print(f"existing Catalog at {catalog_path} is not valid:", file=sys.stderr)
            for finding in existing_findings:
                print(f"  {finding}", file=sys.stderr)
            return fail("refusing to merge into an invalid Catalog")
    else:
        catalog = {"schema_version": SKILL_SCHEMA_VERSION, "entries": []}

    entries: list[dict[str, Any]] = catalog["entries"]
    entry = next((item for item in entries if item["id"] == record["skill_id"]), None)
    if entry is None:
        entry = _entry_shell(record)
        entries.append(entry)
    else:
        # Presentation fields follow the newest manifest; identity does not.
        manifest = record["manifest"]
        entry["name"] = manifest["name"]
        entry["summary"] = manifest["summary"]
        entry["provider"] = manifest["provider"]
        entry["license"] = manifest["license"]
        if manifest.get("homepage"):
            entry["homepage"] = manifest["homepage"]
        if manifest.get("keywords"):
            entry["keywords"] = manifest["keywords"]

    # Compared by precedence, not by string: `1.0.0` and `1.0.0+build.2` are
    # different strings but the same version to anyone resolving a range, so
    # publishing both would put two different artifacts behind one version.
    clash = next(
        (
            version["version"]
            for version in entry["versions"]
            if compare_semver(version["version"], record["version"]) == 0
        ),
        None,
    )
    if clash is not None:
        return fail(
            f"{record['skill_id']} {record['version']} collides with {clash} already in the "
            "Catalog; published versions are immutable, bump the version instead"
        )

    entry["versions"].append(_version_entry(record, changelog, args.published_at))
    # SemVer precedence, not string order: "1.10.0" must follow "1.9.0".
    entry["versions"].sort(
        key=cmp_to_key(lambda a, b: compare_semver(a["version"], b["version"]) or 0)
    )
    entry["latest"] = _resolve_latest(entry["versions"])
    entries.sort(key=lambda item: item["id"])

    validated, findings = validate_catalog(catalog)
    if validated is None:
        print("generated Catalog does not satisfy the contract:", file=sys.stderr)
        for finding in findings:
            print(f"  {finding}", file=sys.stderr)
        return fail("refusing to write an invalid Catalog")

    serialized = json.dumps(catalog, indent=2, ensure_ascii=False) + "\n"
    catalog_path.parent.mkdir(parents=True, exist_ok=True)
    catalog_path.write_text(serialized, encoding="utf-8")
    print(f"catalog      {catalog_path}")

    if args.snapshot_out:
        snapshot_dir = Path(args.snapshot_out)
        if not snapshot_dir.is_absolute():
            snapshot_dir = repo_root / snapshot_dir
        snapshot_dir.mkdir(parents=True, exist_ok=True)
        snapshot = snapshot_dir / f"catalog-{record['skill_id']}-{record['version']}.json"
        snapshot.write_text(serialized, encoding="utf-8")
        print(f"snapshot     {snapshot}")

    print(f"skill        {record['skill_id']}")
    print(f"version      {record['version']} (latest: {entry['latest']})")
    print(f"artifact     {record['asset_name']} sha256 {record['sha256']}")
    print(f"commit       {record['source']['commit']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
