#!/usr/bin/env python3
"""Harness Pack integration suite -- single entry point.

    python3 tests/harness_pack/run.py            # run every phase
    python3 tests/harness_pack/run.py --keep     # keep the temp workdir for triage

Three phases, all offline, deterministic and stdlib-only:

  A. package/artifact  -- the three Skills validate, build reproducibly, merge
     into a Catalog and pass keyless verification, with no secret or absolute
     path in the shipped bytes. (phase_package.py)
  B. lifecycle         -- setup -> orchestrate(plan -> dispatch/merge/uat) ->
     cleanup over one real temporary git repository, asserting the ADR contracts
     against real git state. (phase_lifecycle.py)
  C. profile matrix    -- Node/CommandMate and Rust/CommandAgent resolution for
     setup, cleanup and orchestrate-plan. (phase_profiles.py)

Scope boundary (see README.md): this suite verifies package correctness,
artifact reproducibility and the three Skills' behavioural contracts against a
fake CLI. It deliberately does NOT reimplement CommandMate's install-into-
worktree E2E (that is CommandMate's own, #1242) and is not the live Agent UAT
(#1458). Where a phase cannot exercise a real Agent or a real install, it says so
rather than passing a stub off as coverage.
"""

from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
import traceback
from pathlib import Path

import phase_lifecycle
import phase_package
import phase_profiles
import phase_selftest
from harness_lib import Reporter

PHASES = (
    ("0. self-test (negative controls)", phase_selftest),
    ("A. package / reproducible artifact", phase_package),
    ("B. cross-skill lifecycle", phase_lifecycle),
    ("C. profile matrix", phase_profiles),
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--keep", action="store_true", help="keep the temporary workdir instead of deleting it")
    args = parser.parse_args()

    workroot = Path(tempfile.mkdtemp(prefix="harness-pack-"))
    reporter = Reporter()
    print("Harness Pack integration suite")
    print(f"workdir: {workroot}")
    print()

    try:
        for title, module in PHASES:
            print(f"[{title}]")
            phase_dir = workroot / title.split(".")[0].strip()
            phase_dir.mkdir(parents=True, exist_ok=True)
            try:
                module.run(reporter, phase_dir)
            except Exception:  # a phase crash is a suite failure, not a traceback dump
                reporter.failures.append(f"{title}: phase crashed")
                print(f"    FAIL {title}: phase raised an exception")
                traceback.print_exc()
            print()
    finally:
        if args.keep:
            print(f"kept workdir: {workroot}")
        else:
            shutil.rmtree(workroot, ignore_errors=True)
            # residue-0: the suite leaves nothing behind once it is done.
            print(f"removed workdir (residue-0): {not workroot.exists()}")

    print()
    if reporter.ok():
        print(f"PASSED: {reporter.passed} assertion(s) across {len(PHASES)} phases")
        return 0
    print(f"FAILED: {len(reporter.failures)} assertion(s) did not pass ({reporter.passed} passed)")
    for failure in reporter.failures:
        print(f"  - {failure}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
