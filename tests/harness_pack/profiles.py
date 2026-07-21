#!/usr/bin/env python3
"""Repository profiles for the setup/cleanup reference drivers and the matrix.

The Harness Pack ADR (#1447) fixes two verified profiles -- Node/CommandMate and
Rust/CommandAgent -- and forbids hardcoding `develop`, `feature/...`, npm or Cargo
anywhere in a Skill. Every branch, base, path and baseline value comes from the
profile in effect.

These dictionaries encode that convention for the two Skills that carry no
runner (setup and cleanup): the reference drivers resolve every repository-shaped
value out of the profile passed to them, and the profile-matrix phase proves that
swapping the profile swaps the resolved values -- i.e. nothing is hardcoded.

The values here are deliberately distinct between the two profiles (different
branch templates, different baselines, different bases) so an assertion can tell
"resolved from the profile" apart from "the same string every time".
"""

from __future__ import annotations

# -- cmate-worktree-setup: node vs rust -----------------------------------------
#
# Keyed by the `profile.selected` value the SKILL detects from a signal file
# (package.json -> node, Cargo.toml -> rust). branch/directory/baseline all differ
# so the matrix can prove the driver reads them from here, not from a constant.

SETUP_PROFILES = {
    "node": {
        "selected": "node",
        "verified": True,
        "signal_file": "package.json",
        "integration_branch": "develop",
        "branch_template": "feature/issue-{number}-{slug}",
        "directory_template": ".worktrees/issue-{number}",
        "baseline_command": "node --version",
    },
    "rust": {
        "selected": "rust",
        "verified": True,
        "signal_file": "Cargo.toml",
        "integration_branch": "develop",
        "branch_template": "feat/{number}-worktree",
        "directory_template": ".worktrees/rust-{number}",
        "baseline_command": "cargo --version",
    },
}

#: Detection order: the first profile whose signal file exists wins. A monorepo
#: with both is out of scope for the matrix; the drivers pick the first match and
#: record the ambiguity, exactly as the SKILL prescribes.
SETUP_DETECTION_ORDER = ("node", "rust")


# -- cmate-worktree-cleanup: commandmate vs commandagent ------------------------
#
# The cleanup contract resolves base/remote/baseline from the profile. The two
# verified profiles differ in their base branch (develop vs main) precisely so a
# matrix assertion can show the proof measures against the profile's base rather
# than a hardcoded `main`.

CLEANUP_PROFILES = {
    "commandmate": {
        "name": "commandmate",
        "verified": True,
        "base": "develop",
        "remote": "origin",
        "baseline": None,
    },
    "commandagent": {
        "name": "commandagent",
        "verified": True,
        "base": "main",
        "remote": "origin",
        "baseline": "cargo check",
    },
}


# -- cmate-orchestrate: facts the built-in profiles must exhibit ----------------
#
# The orchestrate runner ships these two verified profiles. The matrix does not
# restate them; it runs the real runner and asserts the emitted plan carries
# these distinguishing values, which is what "resolved from the profile" means.

ORCHESTRATE_PROFILE_FACTS = {
    "node-commandmate": {
        "repository": "Kewton/CommandMate",
        "base": "origin/develop",
        "baseline_contains": "npm",
    },
    "rust-commandagent": {
        "repository": "Kewton/CommandAgent",
        "base": "origin/develop",
        "baseline_contains": "cargo",
    },
}
