#!/usr/bin/env python3
"""Phase B -- the cross-skill lifecycle over one real repository.

This is the new core of the suite. On a single temporary git repository, with a
deterministic clock and a fake CommandMate/gh/git CLI, it runs the three Skills
as one flow and asserts the ADR contracts against *real* git state:

    cmate-worktree-setup   creates isolation worktrees for an issue set
      -> cmate-orchestrate  plans that same issue set, then its dispatch ->
         merge -> uat contract is proven by the existing 36-case fixture suite
         (reused, never reimplemented)
      -> cmate-worktree-cleanup  proves-and-prunes the worktrees whose work
         landed, and keeps every dirty / unmerged / unverifiable one (zero-delete)

What is proven here, and where the rest lives:

- setup: no existing branch/dir/worktree overwritten; base pinned to a resolved
  SHA; the integration worktree is never dirtied.
- orchestrate: the wave barrier, bounded parallelism, no-auto-response on a
  prompt, and the approval + CI gates on PR/merge are the subject of
  `tests/fixtures/cmate-orchestrate/run_tests.mjs`; this phase runs that suite
  as the dispatch/merge/uat leg of the lifecycle.
- cleanup: dirty / unmerged / unverifiable worktrees are kept (zero-delete);
  removals carry a direct or guarded merged-equivalent proof; `--force` and
  `git branch -D` are impossible by construction and absent from the audit log.
- across the whole flow: no secret, token or absolute path survives into any
  document, and no temporary residue is left behind.
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any

from harness_lib import (
    REPO_ROOT,
    Git,
    MiniSchema,
    Reporter,
    find_absolute_paths,
    find_secret_shapes,
    init_repo,
)
from profiles import CLEANUP_PROFILES
from reference_cleanup import cleanup_run
from reference_setup import setup_run

ORCH = REPO_ROOT / "skills" / "cmate-orchestrate" / "scripts" / "orchestrate.mjs"
RUN_TESTS = REPO_ROOT / "tests" / "fixtures" / "cmate-orchestrate" / "run_tests.mjs"
ISSUES_FIXTURE = REPO_ROOT / "tests" / "fixtures" / "cmate-orchestrate" / "cases" / "02-explicit-dependency" / "issues.json"

SETUP_SCHEMA = MiniSchema(json.loads((REPO_ROOT / "skills" / "cmate-worktree-setup" / "schemas" / "worktree-setup.result.v1.json").read_text()))
CLEANUP_RESULT_SCHEMA = MiniSchema(json.loads((REPO_ROOT / "skills" / "cmate-worktree-cleanup" / "schemas" / "cleanup-result.v1.json").read_text()))
CLEANUP_PLAN_SCHEMA = MiniSchema(json.loads((REPO_ROOT / "skills" / "cmate-worktree-cleanup" / "schemas" / "cleanup-plan.v1.json").read_text()))
PLAN_SCHEMA = MiniSchema(json.loads((REPO_ROOT / "skills" / "cmate-orchestrate" / "schemas" / "execution-plan.v1.json").read_text()))

ISSUE_TITLES = {201: "add base configuration loader", 200: "add a session store"}


def _build_repo(workdir: Path) -> Git:
    """A repository with a real bare origin, on develop, ready for setup."""
    origin = workdir / "origin.git"
    origin.mkdir(parents=True)
    Git(origin).run("init", "-q", "--bare", "-b", "develop")

    repo = workdir / "repo"
    git = init_repo(repo)
    # A node signal so setup detects the node profile, plus an ignore rule so the
    # worktrees we place under .worktrees/ never dirty the integration worktree.
    (repo / "package.json").write_text('{"name":"fixture","version":"0.0.0"}\n', encoding="utf-8")
    (repo / ".gitignore").write_text(".worktrees/\n", encoding="utf-8")
    git.run("add", "package.json", ".gitignore")
    git.run("commit", "-q", "-m", "node signal")
    git.run("remote", "add", "origin", str(origin))
    git.run("push", "-q", "-u", "origin", "develop")
    return git


def _commit_in(git: Git, directory: str, filename: str, content: str, message: str) -> None:
    path = git.root / directory
    (path / filename).write_text(content, encoding="utf-8")
    git.run("-C", str(path), "add", filename)
    git.run("-C", str(path), "commit", "-q", "-m", message)


def _no_leak(reporter: Reporter, label: str, document: dict[str, Any], workdir: Path) -> None:
    blob = json.dumps(document, ensure_ascii=False)
    markers = (str(workdir), str(Path.home()), "/Users/", "/private/", "/var/folders/")
    reporter.check(not find_absolute_paths(blob, markers), f"{label}: no absolute path in the document")
    reporter.check(not find_secret_shapes(blob), f"{label}: no secret shape in the document")


def run(reporter: Reporter, workdir: Path) -> None:
    git = _build_repo(workdir)
    base_at_setup = git.out("rev-parse", "develop")

    # =========================================================================
    # 1. setup: create isolation worktrees for the issue set
    # =========================================================================
    reporter.section("lifecycle: setup creates isolation worktrees")
    setup_result = setup_run(
        git,
        issue_numbers=[201, 200],
        issue_titles=ISSUE_TITLES,
        profile_override=None,
        sync_available=False,
    )
    reporter.check(not SETUP_SCHEMA.errors(setup_result), f"setup result conforms to schema ({SETUP_SCHEMA.errors(setup_result)[:2]})")
    reporter.check(setup_result["status"] == "success", f"setup succeeded ({setup_result['status']})")
    reporter.check(setup_result["profile"]["selected"] == "node", "setup detected the node profile")

    created = {w["issue_number"]: w for w in setup_result["worktrees"] if w["created"]}
    reporter.check(set(created) == {201, 200}, f"setup created both worktrees ({sorted(created)})")
    for number, entry in created.items():
        reporter.check(bool(re.fullmatch(r"[0-9a-f]{40}", entry["base_sha"] or "")), f"issue {number}: base recorded as a resolved SHA")
        wt = git.root / entry["directory"]
        reporter.check(wt.is_dir(), f"issue {number}: worktree exists on disk")
        reporter.check(git.out("-C", str(wt), "branch", "--show-current") == entry["branch"], f"issue {number}: on the resolved branch")
        reporter.check(git.out("-C", str(wt), "rev-parse", "HEAD") == entry["base_sha"], f"issue {number}: created from the re-confirmed base SHA")
    # No implicit overwrite: the integration worktree is untouched and clean.
    reporter.check(not git.out("status", "--porcelain"), "setup left the integration worktree clean")
    reporter.check(git.out("rev-parse", "develop") == base_at_setup, "setup did not move the integration branch")
    _no_leak(reporter, "setup", setup_result, workdir)

    # =========================================================================
    # 2. orchestrate: plan the same issue set (setup -> plan handoff)
    # =========================================================================
    reporter.section("lifecycle: orchestrate plans the same issue set")
    runs_dir = workdir / "orchestrate-runs"
    plan_proc = subprocess.run(
        ["node", str(ORCH), "200", "201", "--profile", "node-commandmate", "--max-parallel", "2", "--run-id", "plan", "--issue-json", str(ISSUES_FIXTURE), "--runs-dir", str(runs_dir)],
        capture_output=True, text=True,
    )
    reporter.check(plan_proc.returncode == 0, f"orchestrate plan runner exited 0 ({plan_proc.stderr.strip()[:120]})")
    envelope = json.loads(plan_proc.stdout)
    plan = envelope.get("plan")
    reporter.check(envelope["status"] == "success" and plan is not None, "orchestrate produced a plan")
    if plan is not None:
        reporter.check(not PLAN_SCHEMA.errors(plan), f"plan conforms to execution-plan schema ({PLAN_SCHEMA.errors(plan)[:2]})")
        reporter.check(plan["waves"] == [[201], [200]], f"plan honours the dependency into two waves ({plan['waves']})")
        reporter.check(all(len(w) <= plan["max_parallel"] for w in plan["waves"]), "no wave exceeds max_parallel")
        # setup and orchestrate agree on the issue set they operate over.
        planned = {i["number"] for i in plan["issues"]}
        reporter.check(planned == {200, 201}, f"orchestrate planned the setup issue set ({sorted(planned)})")

    # =========================================================================
    # 3. dispatch -> merge -> uat contract (reuse the 36-case fixture suite)
    # =========================================================================
    reporter.section("lifecycle: orchestrate dispatch/merge/uat contract (reused suite)")
    fixture = subprocess.run(["node", str(RUN_TESTS)], capture_output=True, text=True)
    tail = (fixture.stdout.strip().splitlines() or ["(no output)"])[-1]
    reporter.check(fixture.returncode == 0, f"run_tests.mjs passed ({tail})")
    reporter.note(tail)

    # =========================================================================
    # 4. the work lands; build the cleanup scenario on the real repository
    # =========================================================================
    reporter.section("lifecycle: cleanup proves-and-prunes, keeping the unprovable")
    b201 = created[201]["branch"]
    b200 = created[200]["branch"]
    # Two branches whose work merges into develop -> direct-ancestor removals.
    _commit_in(git, created[201]["directory"], "base.ts", "export const base = 1\n", "feat: base loader")
    git.run("merge", "--no-ff", "--no-edit", b201)
    _commit_in(git, created[200]["directory"], "store.ts", "export const store = 1\n", "feat: session store")
    git.run("merge", "--no-ff", "--no-edit", b200)

    # A squash-merged branch -> merged-equivalent removal via a guarded ref delete.
    squash_branch = "feature/issue-303-demo"
    git.run("branch", squash_branch, "develop")
    git.run("worktree", "add", "-q", ".worktrees/issue-303", squash_branch)
    _commit_in(git, ".worktrees/issue-303", "extra.ts", "export const extra = 3\n", "feat: extra")
    squash_tip = git.out("-C", str(git.root / ".worktrees/issue-303"), "rev-parse", "HEAD")
    git.run("merge", "--squash", squash_branch)
    git.run("commit", "-q", "-m", "squash: issue 303")
    merge_commit = git.out("rev-parse", "develop")

    # A dirty worktree and an unmerged worktree -> both must be kept (zero-delete).
    git.run("branch", "feature/issue-777-wip", "develop")
    git.run("worktree", "add", "-q", ".worktrees/issue-777", "feature/issue-777-wip")
    (git.root / ".worktrees/issue-777" / "scratch.txt").write_text("uncommitted\n", encoding="utf-8")
    git.run("branch", "feature/issue-888-open", "develop")
    git.run("worktree", "add", "-q", ".worktrees/issue-888", "feature/issue-888-open")
    _commit_in(git, ".worktrees/issue-888", "open.ts", "export const open = 8\n", "feat: not merged")

    git.run("push", "-q", "origin", "develop")

    github_data = {squash_branch: {"merged_prs": [{"number": 303, "headRefName": squash_branch, "baseRefName": "develop", "headRefOid": squash_tip, "mergeCommit_oid": merge_commit}]}}
    confirmed = ["issue-201", "issue-200", "issue-303"]

    before = set(git.worktree_basenames())
    plan_doc, result = cleanup_run(
        git,
        profile=CLEANUP_PROFILES["commandmate"],
        selection_mode="all_eligible",
        targets=[],
        mode="apply",
        confirmed_targets=confirmed,
        gh_available=True,
        github_data=github_data,
    )

    reporter.check(not CLEANUP_PLAN_SCHEMA.errors(plan_doc), f"cleanup plan conforms to schema ({CLEANUP_PLAN_SCHEMA.errors(plan_doc)[:2]})")
    reporter.check(not CLEANUP_RESULT_SCHEMA.errors(result), f"cleanup result conforms to schema ({CLEANUP_RESULT_SCHEMA.errors(result)[:2]})")

    removed_refs = {r["worktree_ref"] for r in result["removed"]}
    kept_refs = {s["worktree_ref"] for s in result["skipped"]}
    proof_by_ref = {r["worktree_ref"]: r["proof_type"] for r in result["removed"]}
    reporter.check(removed_refs == {"issue-201", "issue-200", "issue-303"}, f"only the provably-merged worktrees were removed ({sorted(removed_refs)})")
    reporter.check(proof_by_ref.get("issue-303") == "merged_equivalent", "the squash-merged worktree was removed via merged-equivalent proof")
    reporter.check(proof_by_ref.get("issue-201") == "direct" and proof_by_ref.get("issue-200") == "direct", "the ancestor worktrees were removed via direct proof")

    # Zero-delete: dirty and unmerged worktrees are kept, in the document *and*
    # on disk.
    reporter.check({"issue-777", "issue-888"} <= kept_refs, f"dirty and unmerged worktrees are kept ({sorted(kept_refs)})")
    dirty_skip = next((s for s in result["skipped"] if s["worktree_ref"] == "issue-777"), {})
    unmerged_skip = next((s for s in result["skipped"] if s["worktree_ref"] == "issue-888"), {})
    reporter.check(dirty_skip.get("reason") == "dirty", f"issue-777 kept as dirty ({dirty_skip.get('reason')})")
    reporter.check(unmerged_skip.get("reason") in ("unverifiable", "no_merged_pr", "github_data_missing"), f"issue-888 kept as unverifiable ({unmerged_skip.get('reason')})")

    now = set(git.worktree_basenames())
    reporter.check({"issue-201", "issue-200", "issue-303"} & now == set(), "removed worktrees are gone from git worktree list")
    reporter.check({"issue-777", "issue-888"} <= now, "kept worktrees remain in git worktree list")
    for gone in ("issue-201", "issue-200", "issue-303"):
        reporter.check(not (git.root / ".worktrees" / gone).exists(), f"{gone} directory removed from disk")
    for kept in ("issue-777", "issue-888"):
        reporter.check((git.root / ".worktrees" / kept).exists(), f"{kept} directory retained on disk")

    # The integration worktree is never a candidate, whatever the input.
    reporter.check(git.root.name in now, "the integration/current worktree was never removed")
    branches = set(git.local_branches())
    reporter.check(b201 not in branches and b200 not in branches and squash_branch not in branches, "merged branches were deleted")
    reporter.check({"feature/issue-777-wip", "feature/issue-888-open"} <= branches, "unmerged/dirty branches were kept")

    # No destructive flag was ever attempted (guard + audit log).
    reporter.check(not git.used_forbidden_flag(), "no --force and no git branch -D appears in the git audit log")

    # Safety completion checks and honest status.
    checks = {c["id"]: c["passed"] for c in result["completion_check"]["checks"]}
    reporter.check(checks.get("zero_delete_honored") is True, "completion check: zero_delete_honored")
    reporter.check(checks.get("guarded_delete_used") is True, "completion check: guarded_delete_used")
    reporter.check(checks.get("exclusions_honored") is True, "completion check: exclusions_honored")
    reporter.check(result["completion_check"]["passed"] is True, "cleanup completion_check passed")
    reporter.check(result["status"] == "partial", f"cleanup honestly reports partial (kept unverifiable) ({result['status']})")

    _no_leak(reporter, "cleanup plan", plan_doc, workdir)
    _no_leak(reporter, "cleanup result", result, workdir)

    # =========================================================================
    # 5. residue: nothing lives outside the phase's workdir
    # =========================================================================
    reporter.section("lifecycle: no temporary residue")
    reporter.check(str(git.root).startswith(str(workdir)), "the whole lifecycle repository lives under the phase workdir")
    stray = [p for p in (before - now) if p in {"issue-777", "issue-888", git.root.name}]
    reporter.check(not stray, "no kept worktree was accidentally removed")
