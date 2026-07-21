#!/usr/bin/env python3
"""Phase A -- package correctness and reproducible-artifact verification.

For each of the three Harness Pack Skills this phase drives the *verifiable*
half of the distribution chain, offline and deterministically:

    package validates
      -> two independent builds are byte-identical (reproducible)
        -> the artifact merges into a Catalog
          -> `verify_artifact.py` walks Catalog -> bytes -> manifest -> payload
            -> the shipped payload carries no secret and no absolute path

Boundary (stated out loud, per the suite's charter): CommandMate's
install-into-worktree, the receipt it writes and the uninstall that consumes it
are *not* reimplemented here -- there is no such code in this repository, and the
real install/discovery is CommandMate-side (#1242) exercised by the live UAT
(#1458). What a receipt is verified *against* -- the Catalog checksum, the
manifest/file set, the effective risk and the compatibility block -- is exactly
the chain this phase proves end to end with the real release CLIs.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

from harness_lib import (
    HARNESS_PACK_SKILLS,
    REPO_ROOT,
    SCRIPTS_DIR,
    SYNTHETIC_COMMIT,
    Reporter,
    find_absolute_paths,
    find_secret_shapes,
    import_cmate_skills,
    sha256_hex,
)

REPOSITORY = "Kewton/commandmate-skills"
PUBLISHED_AT = "2026-01-02T03:04:05Z"

#: Markers that would betray the build machine if they reached a shipped file.
_ARTIFACT_PATH_MARKERS = (str(REPO_ROOT), str(Path.home()), "/Users/", "/private/tmp/", "/var/folders/")


def _run_script(script: str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / script), *args],
        capture_output=True,
        text=True,
    )


def _build(skill_id: str, out_dir: Path) -> subprocess.CompletedProcess[str]:
    return _run_script(
        "build_release.py",
        "--skill", skill_id,
        "--repository", REPOSITORY,
        "--ref", f"{skill_id}-harness",
        "--commit", SYNTHETIC_COMMIT,
        "--out", str(out_dir),
    )


def run(reporter: Reporter, workdir: Path) -> None:
    cmate = import_cmate_skills()
    from cmate_skills.package import read_package
    from cmate_skills.repo import PayloadFile, check_package, scan_for_secrets
    from cmate_skills.schema import compute_risk, resolve_effective_risk

    catalog_path = workdir / "catalog.json"

    for skill_id in HARNESS_PACK_SKILLS:
        reporter.section(f"package/artifact: {skill_id}")
        directory = REPO_ROOT / "skills" / skill_id

        # 1. the package validates under the same check the release pipeline runs.
        check = check_package(directory, REPO_ROOT)
        reporter.check(not check.findings, f"{skill_id}: package validates ({'; '.join(str(f) for f in check.findings[:2])})")
        if check.manifest is None:
            continue
        version = check.manifest["version"]

        # 2. two independent builds, byte-identical -> reproducible across
        #    processes, not just within one (build_release already checks within).
        out_a, out_b = workdir / f"{skill_id}-a", workdir / f"{skill_id}-b"
        build_a, build_b = _build(skill_id, out_a), _build(skill_id, out_b)
        if not reporter.check(build_a.returncode == 0 and build_b.returncode == 0, f"{skill_id}: build_release.py succeeded ({build_a.stderr.strip()[:120]})"):
            continue

        asset = f"{skill_id}-{version}.tar.gz"
        bytes_a, bytes_b = (out_a / asset).read_bytes(), (out_b / asset).read_bytes()
        reporter.check(bytes_a == bytes_b, f"{skill_id}: two builds are byte-identical")
        record_a = json.loads((out_a / f"{skill_id}-{version}.build.json").read_text())
        reporter.check(record_a["sha256"] == sha256_hex(bytes_a), f"{skill_id}: build record sha256 matches the bytes")
        reporter.check(record_a["reproducible"] is True, f"{skill_id}: build record marks reproducible")

        # 3. merge the artifact into a Catalog (append-only, real CLI).
        merge = _run_script(
            "build_catalog.py",
            "--record", str(out_a / f"{skill_id}-{version}.build.json"),
            "--catalog", str(catalog_path),
            "--published-at", PUBLISHED_AT,
            "--changelog", "harness integration build",
        )
        if not reporter.check(merge.returncode == 0, f"{skill_id}: build_catalog.py merged the record ({merge.stderr.strip()[:160]})"):
            continue

        # 4. keyless verification walks the whole chain to the payload bytes.
        verify = _run_script(
            "verify_artifact.py",
            "--catalog", str(catalog_path),
            "--skill", skill_id,
            "--version", version,
            "--artifact", str(out_a / asset),
        )
        reporter.check(verify.returncode == 0, f"{skill_id}: verify_artifact.py ACCEPTs the chain")
        reporter.check("VERDICT: ACCEPT" in verify.stdout, f"{skill_id}: verifier prints ACCEPT verdict")

        # 5. the shipped payload carries no secret and no machine-absolute path.
        table = read_package(bytes_a, skill_id, version)
        secret_hits: list[str] = []
        abspath_hits: list[str] = []
        payload = []
        for entry in table.files:
            text = entry.data.decode("utf-8", errors="replace")
            secret_hits.extend(f"{entry.path}:{hit}" for hit in find_secret_shapes(text))
            abspath_hits.extend(f"{entry.path}:{hit}" for hit in find_absolute_paths(text, _ARTIFACT_PATH_MARKERS))
            payload.append(PayloadFile(entry.path, entry.data, entry.executable))
        reporter.check(not secret_hits, f"{skill_id}: no credential shape in the artifact ({secret_hits[:2]})")
        reporter.check(not abspath_hits, f"{skill_id}: no absolute path in the artifact ({abspath_hits[:2]})")
        # cross-check with the repository's own secret scanner on the packed bytes.
        findings: list[Any] = []
        scan_for_secrets(payload, findings)
        reporter.check(not findings, f"{skill_id}: repo secret scanner is clean on the artifact")

        # 6. effective risk and compatibility are what the chain publishes.
        computed = compute_risk(
            executable_paths=[f["path"] for f in check.manifest["files"] if f["executable"]],
            script_paths=[f["path"] for f in check.manifest["files"] if f["script"]],
            network_hosts=check.manifest["requirements"]["network_hosts"],
            declared_permissions=check.manifest["declared_permissions"],
        )
        effective = resolve_effective_risk(check.manifest["declared_risk"], computed)
        reporter.check(effective in ("low", "moderate", "high"), f"{skill_id}: effective risk resolves ({effective})")
        reporter.check(bool(check.manifest["compatibility"]["agents"]), f"{skill_id}: manifest declares agent compatibility")

    # The Catalog the phase built is a schema-valid document carrying all three.
    if catalog_path.is_file():
        from cmate_skills.schema import validate_catalog

        document = json.loads(catalog_path.read_text())
        catalog, findings = validate_catalog(document)
        reporter.check(catalog is not None and not findings, "catalog: the assembled Catalog validates")
        if catalog is not None:
            ids = {entry["id"] for entry in catalog["entries"]}
            reporter.check(set(HARNESS_PACK_SKILLS) <= ids, f"catalog: all three Skills are listed ({sorted(ids)})")
