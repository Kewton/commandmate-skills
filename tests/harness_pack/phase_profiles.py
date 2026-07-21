#!/usr/bin/env python3
"""Phase C -- the Node/CommandMate and Rust/CommandAgent profile matrix.

The ADR (#1447) forbids hardcoding branch, base, path or baseline: every such
value is resolved from the repository profile, and the two verified profiles are
Node/CommandMate and Rust/CommandAgent. This phase proves that swapping the
profile swaps the resolved values across all three Skills:

- orchestrate: the real runner emits a plan whose profile carries the selected
  profile's repository, base and baseline -- and refuses an unverified profile
  unless it is explicitly allowed.
- setup: the reference driver detects node vs rust from the signal file and
  resolves a *different* branch template, directory and baseline for each; a
  second run over the same issue collides and overwrites nothing; a base override
  that escapes the repository is refused.
- cleanup: the reference driver measures its proof against the profile's base
  branch (develop vs main), never a hardcoded default.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

from harness_lib import REPO_ROOT, Git, MiniSchema, Reporter, init_repo
from profiles import CLEANUP_PROFILES, ORCHESTRATE_PROFILE_FACTS, SETUP_PROFILES
from reference_cleanup import cleanup_run
from reference_setup import setup_run

ORCH = REPO_ROOT / "skills" / "cmate-orchestrate" / "scripts" / "orchestrate.mjs"
ISSUES_FIXTURE = REPO_ROOT / "tests" / "fixtures" / "cmate-orchestrate" / "cases" / "02-explicit-dependency" / "issues.json"
UNVERIFIED_PROFILE = REPO_ROOT / "tests" / "fixtures" / "cmate-orchestrate" / "profiles" / "unverified-example.json"

SETUP_SCHEMA = MiniSchema(json.loads((REPO_ROOT / "skills" / "cmate-worktree-setup" / "schemas" / "worktree-setup.result.v1.json").read_text()))
CLEANUP_RESULT_SCHEMA = MiniSchema(json.loads((REPO_ROOT / "skills" / "cmate-worktree-cleanup" / "schemas" / "cleanup-result.v1.json").read_text()))


def _orchestrate(profile: str, runs_dir: Path) -> subprocess.CompletedProcess[str]:
    args = ["node", str(ORCH), "200", "201", "--profile", profile, "--run-id", "plan", "--issue-json", str(ISSUES_FIXTURE), "--runs-dir", str(runs_dir)]
    return subprocess.run(args, capture_output=True, text=True)


def _orchestrate_json(runs_dir: Path, extra: list[str]) -> subprocess.CompletedProcess[str]:
    args = ["node", str(ORCH), "200", "201", "--run-id", "plan", "--issue-json", str(ISSUES_FIXTURE), "--runs-dir", str(runs_dir), *extra]
    return subprocess.run(args, capture_output=True, text=True)


def _matrix_orchestrate(reporter: Reporter, workdir: Path) -> None:
    reporter.section("profile matrix: orchestrate plan parity")
    plans: dict[str, dict[str, Any]] = {}
    for profile, facts in ORCHESTRATE_PROFILE_FACTS.items():
        proc = _orchestrate(profile, workdir / f"orch-{profile}-1")
        if not reporter.check(proc.returncode == 0, f"{profile}: runner exited 0 ({proc.stderr.strip()[:100]})"):
            continue
        plan = json.loads(proc.stdout)["plan"]
        plans[profile] = plan
        prof = plan["profile"]
        reporter.check(prof["repository"] == facts["repository"], f"{profile}: repository resolved from profile ({prof['repository']})")
        reporter.check(prof["base"] == facts["base"], f"{profile}: base resolved from profile ({prof['base']})")
        reporter.check(any(facts["baseline_contains"] in step for step in prof["baseline"]), f"{profile}: baseline resolved from profile ({prof['baseline']})")
        reporter.check(prof["verified"] is True, f"{profile}: profile is verified")
        # determinism: a second run yields a byte-identical plan.
        again = _orchestrate(profile, workdir / f"orch-{profile}-2")
        reporter.check(again.returncode == 0 and json.loads(again.stdout)["plan"] == plan, f"{profile}: plan is deterministic across runs")

    # The two profiles are genuinely distinct -- "resolved from the profile", not
    # "the same string every time".
    if len(plans) == 2:
        node, rust = plans["node-commandmate"]["profile"], plans["rust-commandagent"]["profile"]
        reporter.check(node["repository"] != rust["repository"], "node and rust resolve different repositories")
        reporter.check(node["baseline"] != rust["baseline"], "node and rust resolve different baselines")

    # An unverified profile is refused unless explicitly allowed.
    refused = _orchestrate_json(workdir / "orch-unv", ["--profile-json", str(UNVERIFIED_PROFILE)])
    envelope = json.loads(refused.stdout)
    reporter.check(refused.returncode == 3 and envelope["status"] == "failure", f"unverified profile is refused ({envelope['status']})")
    reporter.check(any(e["code"] == "unverified_profile" for e in envelope["errors"]), "refusal names unverified_profile")
    allowed = _orchestrate_json(workdir / "orch-unv-ok", ["--profile-json", str(UNVERIFIED_PROFILE), "--allow-unverified"])
    allowed_plan = json.loads(allowed.stdout).get("plan")
    if reporter.check(allowed_plan is not None, "an explicitly-allowed unverified profile plans"):
        factors = {f["code"] for f in allowed_plan["risk"]["factors"]}
        reporter.check("unverified_profile" in factors and allowed_plan["risk"]["level"] == "high", "allowing an unverified profile forces high risk")


def _setup_repo(workdir: Path, name: str, signal_file: str) -> Git:
    repo = workdir / name
    git = init_repo(repo)
    (repo / signal_file).write_text("fixture\n", encoding="utf-8")
    (repo / ".gitignore").write_text(".worktrees/\n", encoding="utf-8")
    git.run("add", signal_file, ".gitignore")
    git.run("commit", "-q", "-m", "signal")
    return git


def _matrix_setup(reporter: Reporter, workdir: Path) -> None:
    reporter.section("profile matrix: setup resolves node vs rust")
    node_git = _setup_repo(workdir, "node-repo", SETUP_PROFILES["node"]["signal_file"])
    rust_git = _setup_repo(workdir, "rust-repo", SETUP_PROFILES["rust"]["signal_file"])

    node_res = setup_run(node_git, issue_numbers=[42], issue_titles={42: "widget"})
    rust_res = setup_run(rust_git, issue_numbers=[42], issue_titles={42: "widget"})

    for label, res, expected in (("node", node_res, "node"), ("rust", rust_res, "rust")):
        reporter.check(not SETUP_SCHEMA.errors(res), f"{label}: setup result conforms to schema ({SETUP_SCHEMA.errors(res)[:1]})")
        reporter.check(res["profile"]["selected"] == expected, f"{label}: detected the {expected} profile")

    nprof, rprof = node_res["profile"], rust_res["profile"]
    reporter.check(nprof["branch_template"] != rprof["branch_template"], "node and rust resolve different branch templates")
    reporter.check(nprof["baseline_command"] != rprof["baseline_command"], "node and rust resolve different baselines")
    reporter.check(nprof["directory_template"] != rprof["directory_template"], "node and rust resolve different worktree directories")
    reporter.check(nprof["baseline_command"] == "node --version", f"node baseline is the node profile's, not a hardcoded default ({nprof['baseline_command']})")

    # A mixed re-run: issue 42 already exists (collision), issue 43 is new. The
    # new one is created, the existing one is skipped and nothing is overwritten,
    # so the run is honestly partial rather than rounded to success.
    reporter.section("profile matrix: setup collision overwrites nothing")
    branch = node_res["worktrees"][0]["branch"]
    sha_before = node_git.out("rev-parse", branch)
    collide = setup_run(node_git, issue_numbers=[42, 43], issue_titles={42: "widget", 43: "gadget"})
    reporter.check(not SETUP_SCHEMA.errors(collide), f"collision result conforms to schema ({SETUP_SCHEMA.errors(collide)[:1]})")
    reporter.check(collide["status"] == "partial", f"a partly-colliding run is honestly partial ({collide['status']})")
    reporter.check(any(c["issue_number"] == 42 for c in collide["collisions"]), "the collision on issue 42 is recorded")
    created_now = {w["issue_number"]: w["created"] for w in collide["worktrees"]}
    reporter.check(created_now.get(42) is False, "the colliding issue was not created")
    reporter.check(created_now.get(43) is True, "the new issue was created alongside the collision")
    reporter.check(node_git.out("rev-parse", branch) == sha_before, "the existing branch was not moved")
    overwrite_check = {c["id"]: c["passed"] for c in collide["completion_check"]["checks"]}
    reporter.check(overwrite_check.get("no_implicit_overwrite") is True, "completion check: no_implicit_overwrite")

    # A base override that escapes the repository is refused (ADR security rule).
    reporter.section("profile matrix: setup refuses a path-escaping base")
    escape = setup_run(node_git, issue_numbers=[42], issue_titles={42: "widget"}, base_override="/etc/passwd")
    reporter.check(not SETUP_SCHEMA.errors(escape), f"escape refusal conforms to schema ({SETUP_SCHEMA.errors(escape)[:1]})")
    reporter.check(escape["status"] == "failure", f"a path-escaping base override is refused ({escape['status']})")
    reporter.check(any("path_escape" in r for r in escape["blocking_reasons"]), "refusal names path_escape_rejected")


def _cleanup_repo(workdir: Path, name: str, base_branch: str) -> Git:
    repo = workdir / name
    repo.mkdir(parents=True)
    git = Git(repo)
    git.run("init", "-q", "-b", base_branch)
    (repo / "README.md").write_text("fixture\n", encoding="utf-8")
    (repo / ".gitignore").write_text(".worktrees/\n", encoding="utf-8")
    git.run("add", "README.md", ".gitignore")
    git.run("commit", "-q", "-m", "initial")
    # one unmerged worktree so the run has a candidate to reason about.
    git.run("branch", "feature/issue-9-open", base_branch)
    git.run("worktree", "add", "-q", ".worktrees/issue-9", "feature/issue-9-open")
    (repo / ".worktrees/issue-9" / "x.txt").write_text("open\n", encoding="utf-8")
    git.run("-C", str(repo / ".worktrees/issue-9"), "add", "x.txt")
    git.run("-C", str(repo / ".worktrees/issue-9"), "commit", "-q", "-m", "open")
    return git


def _matrix_cleanup(reporter: Reporter, workdir: Path) -> None:
    reporter.section("profile matrix: cleanup base resolves from the profile")
    for key, base in (("commandmate", "develop"), ("commandagent", "main")):
        git = _cleanup_repo(workdir, f"cleanup-{key}", base)
        _, result = cleanup_run(git, profile=CLEANUP_PROFILES[key], selection_mode="all_eligible", targets=[], mode="dry_run")
        reporter.check(not CLEANUP_RESULT_SCHEMA.errors(result), f"{key}: cleanup result conforms to schema ({CLEANUP_RESULT_SCHEMA.errors(result)[:1]})")
        reporter.check(result["profile"]["base"] == base, f"{key}: proof base resolved from profile ({result['profile']['base']})")
        reporter.check(result["profile"]["name"] == key, f"{key}: profile name recorded ({result['profile']['name']})")
        reporter.check(not result["removed"], f"{key}: a dry run deletes nothing")
    # The two profiles resolve genuinely different bases.
    reporter.check(CLEANUP_PROFILES["commandmate"]["base"] != CLEANUP_PROFILES["commandagent"]["base"], "the two cleanup profiles resolve different base branches")


def run(reporter: Reporter, workdir: Path) -> None:
    _matrix_orchestrate(reporter, workdir)
    _matrix_setup(reporter, workdir)
    _matrix_cleanup(reporter, workdir)
