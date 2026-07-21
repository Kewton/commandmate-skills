#!/usr/bin/env python3
"""Phase 0 -- negative controls for the suite's own instruments.

A green run only means something if the instruments that produce it can fail. A
schema validator that accepts everything, a git guard that blocks nothing, or a
secret scanner that never fires would let every later phase pass for the wrong
reason. This phase proves each instrument rejects what it must, before any real
phase trusts it -- the same discipline the per-Skill graders apply with their
`--selftest` negative samples.
"""

from __future__ import annotations

from pathlib import Path

from harness_lib import (
    ForbiddenGitOperation,
    Git,
    MiniSchema,
    Reporter,
    find_absolute_paths,
    find_secret_shapes,
    init_repo,
)


def _schema_controls(reporter: Reporter) -> None:
    reporter.section("selftest: the schema validator rejects violations")
    schema = MiniSchema({
        "type": "object",
        "additionalProperties": False,
        "required": ["v", "name", "kind"],
        "properties": {
            "v": {"const": 1},
            "name": {"type": "string", "minLength": 1, "pattern": "^[a-z]+$"},
            "kind": {"enum": ["a", "b"]},
            "count": {"type": "integer", "minimum": 0, "maximum": 3},
        },
    })
    good = {"v": 1, "name": "ok", "kind": "a", "count": 2}
    reporter.check(schema.errors(good) == [], "a conforming document validates clean")
    cases = {
        "wrong const": {"v": 2, "name": "ok", "kind": "a"},
        "missing required": {"v": 1, "kind": "a"},
        "unexpected property": {"v": 1, "name": "ok", "kind": "a", "extra": 1},
        "enum violation": {"v": 1, "name": "ok", "kind": "c"},
        "pattern violation": {"v": 1, "name": "NOPE", "kind": "a"},
        "type violation": {"v": 1, "name": 5, "kind": "a"},
        "above maximum": {"v": 1, "name": "ok", "kind": "a", "count": 9},
    }
    for label, doc in cases.items():
        reporter.check(bool(schema.errors(doc)), f"validator rejects: {label}")
    # A boolean must not satisfy an integer field (Python's True == 1 trap).
    reporter.check(bool(schema.errors({"v": 1, "name": "ok", "kind": "a", "count": True})), "validator rejects a boolean where an integer is required")


def _git_guard_controls(reporter: Reporter, workdir: Path) -> None:
    reporter.section("selftest: the git guard blocks destructive flags")
    git = init_repo(workdir / "guard-repo")
    git.run("branch", "throwaway")
    for label, args in (
        ("git branch -D", ["branch", "-D", "throwaway"]),
        ("git worktree remove --force", ["worktree", "remove", "--force", "somewhere"]),
        ("git clean", ["clean", "-fdx"]),
        ("--force anywhere", ["push", "--force"]),
    ):
        raised = False
        try:
            git.run(*args, check=False)
        except ForbiddenGitOperation:
            raised = True
        reporter.check(raised, f"guard raises on: {label}")
    # A safe delete is allowed, so the guard is not just blocking everything.
    ok = git.run("branch", "-d", "throwaway", check=False)
    reporter.check(ok.returncode == 0, "guard allows a safe git branch -d")


def _scanner_controls(reporter: Reporter) -> None:
    reporter.section("selftest: the redaction scanners fire on real leaks")
    reporter.check(bool(find_secret_shapes("token=ghp_" + "a" * 30)), "secret scanner flags a GitHub token shape")
    reporter.check(bool(find_secret_shapes("AKIA" + "A" * 16)), "secret scanner flags an AWS key shape")
    reporter.check(find_secret_shapes("just some prose about a token") == [], "secret scanner does not flag ordinary prose")
    reporter.check(bool(find_absolute_paths("/Users/someone/secret")), "path scanner flags a home-directory path")
    reporter.check(find_absolute_paths("relative/repo/path.ts") == [], "path scanner does not flag a repo-relative path")
    reporter.check(find_absolute_paths("https://github.com/Kewton/CommandMate") == [], "path scanner does not flag an https URL")


def run(reporter: Reporter, workdir: Path) -> None:
    _schema_controls(reporter)
    _git_guard_controls(reporter, workdir)
    _scanner_controls(reporter)
