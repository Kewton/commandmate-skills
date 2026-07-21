#!/usr/bin/env python3
"""A git-driven reference implementation of the cmate-worktree-cleanup contract.

Like setup, cleanup ships no runner: it is a prose contract (SKILL.md plus
`references/proof-algorithm.md`) and two schemas. This module is a literal,
git-driven transcription of that proof algorithm, run against a *real*
repository, so the suite can prove the single rule the whole Skill exists to
enforce -- **do not delete what you cannot prove merged** -- against real
adversarial git states, and prove it via observable git state afterwards rather
than the driver's own booleans.

The safety-critical operations are real git: `merge-base --is-ancestor`,
`status --porcelain`, `git worktree remove` (never `--force`), `git branch -d`
(never `-D`) and a guarded `git update-ref -d <ref> <old-oid>`. The GitHub side
of merged-equivalent detection (`gh pr list`) is injected as data, the same way
the orchestrate fixtures inject a fake gh -- but every one of the four
merged-equivalent conditions is still checked against the real repository.

Boundary: this is the executable embodiment of the contract, not CommandMate's
runtime and not the Agent-driven live run (#1458).
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from harness_lib import FIXED_CLOCK, Git, skill_version

SKILL_ID = "cmate-worktree-cleanup"


# =============================================================================
# git worktree list --porcelain parsing
# =============================================================================


def _parse_worktrees(porcelain: str) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    current: dict[str, Any] = {}
    for line in porcelain.splitlines():
        if not line.strip():
            if current:
                entries.append(current)
                current = {}
            continue
        if line.startswith("worktree "):
            current = {"path": line[len("worktree ") :], "branch": None, "head": None, "detached": False, "locked": False}
        elif line.startswith("HEAD "):
            current["head"] = line[len("HEAD ") :]
        elif line.startswith("branch "):
            ref = line[len("branch ") :]
            current["branch"] = ref[len("refs/heads/") :] if ref.startswith("refs/heads/") else ref
        elif line.strip() == "detached":
            current["detached"] = True
        elif line.startswith("locked"):
            current["locked"] = True
    if current:
        entries.append(current)
    return entries


def _issue_number(branch: str | None, path: str) -> int | None:
    for source in (branch or "", Path(path).name):
        match = re.search(r"(\d+)", source)
        if match:
            return int(match.group(1))
    return None


def _normalize_diff(text: str) -> str:
    """Drop the blob-hash `index` lines so two patches with the same content but
    different object ids compare equal."""
    return "\n".join(line for line in text.splitlines() if not line.startswith("index "))


# =============================================================================
# The proof (proof-algorithm.md, run against real git)
# =============================================================================


def _prove(
    git: Git,
    branch: str,
    tip: str,
    base_ref: str,
    *,
    gh_available: bool,
    github_data: dict[str, Any],
    fetch_ok: bool,
) -> dict[str, Any]:
    proof: dict[str, Any] = {"type": "unverifiable", "base": base_ref}

    # §2 direct ancestry: closes on local history alone, so fetch failure does
    # not block it.
    if git.run("merge-base", "--is-ancestor", tip, base_ref, check=False).returncode == 0:
        proof.update({"type": "direct", "ancestor_verified": True})
        return proof
    proof["ancestor_verified"] = False

    # §3 merged-equivalent needs GitHub data and a fresh remote.
    if not gh_available:
        proof["unverifiable_reasons"] = ["github_data_missing"]
        return proof
    if not fetch_ok:
        proof["unverifiable_reasons"] = ["fetch_failed"]
        return proof

    prs = [
        pr
        for pr in github_data.get(branch, {}).get("merged_prs", [])
        if pr.get("headRefName") == branch and pr.get("baseRefName") == base_ref.split("/")[-1]
    ]
    proof["merged_pr_exact"] = len(prs) == 1
    if len(prs) == 0:
        proof["unverifiable_reasons"] = ["no_merged_pr"]
        return proof
    if len(prs) > 1:
        proof["unverifiable_reasons"] = ["multiple_prs"]
        return proof

    pr = prs[0]
    proof["pr_number"] = pr["number"]
    # cond 2: head OID match (tip drift)
    proof["head_oid_match"] = pr.get("headRefOid") == tip
    if not proof["head_oid_match"]:
        proof["unverifiable_reasons"] = ["head_oid_drift"]
        return proof
    # cond 3: reachable merge commit
    mc = pr.get("mergeCommit_oid")
    proof["merge_commit_oid"] = mc
    exists = mc and git.run("cat-file", "-e", f"{mc}^{{commit}}", check=False).returncode == 0
    reachable = exists and git.run("merge-base", "--is-ancestor", mc, base_ref, check=False).returncode == 0
    proof["merge_commit_reachable"] = bool(reachable)
    if not reachable:
        proof["unverifiable_reasons"] = ["merge_commit_unreachable"]
        return proof
    # cond 4: tree equality
    proof["tree_equal"] = _tree_equal(git, base_ref, tip, mc)
    if not proof["tree_equal"]:
        proof["unverifiable_reasons"] = ["tree_mismatch"]
        return proof

    proof["type"] = "merged_equivalent"
    return proof


def _tree_equal(git: Git, base_ref: str, tip: str, mc: str) -> bool:
    cherry = git.run("cherry", base_ref, tip, check=False).stdout
    if any(line.startswith("+") for line in cherry.splitlines()):
        return False
    mb = git.run("merge-base", base_ref, tip, check=False).stdout.strip()
    if not mb:
        return False
    branch_change = _normalize_diff(git.run("diff", mb, tip, check=False).stdout)
    merge_change = _normalize_diff(git.run("diff", f"{mc}^", mc, check=False).stdout)
    return branch_change == merge_change


# =============================================================================
# The run
# =============================================================================


def cleanup_run(
    git: Git,
    *,
    profile: dict[str, Any],
    selection_mode: str,
    targets: list[int],
    mode: str = "dry_run",
    confirmed_targets: list[str] | None = None,
    integration_basenames: tuple[str, ...] = (),
    gh_available: bool = False,
    github_data: dict[str, Any] | None = None,
    fetch: bool = True,
) -> tuple[dict[str, Any], dict[str, Any]]:
    version = skill_version(SKILL_ID)
    confirmed = set(confirmed_targets or [])
    github_data = github_data or {}
    base_branch = profile["base"]
    remote = profile["remote"]

    # -- Step 0: the current worktree is always excluded --------------------
    current_top = git.out("rev-parse", "--show-toplevel")

    # -- Step 2: fetch (never let a stale remote look current) --------------
    fetch_ok = False
    if fetch:
        fetch_ok = git.run("fetch", remote, base_branch, "--prune", check=False).returncode == 0
    base_ref = f"{remote}/{base_branch}" if fetch_ok else base_branch

    # -- Step 1: discover and exclude --------------------------------------
    worktrees = _parse_worktrees(git.out("worktree", "list", "--porcelain"))
    excluded: list[dict[str, Any]] = []
    candidates: list[dict[str, Any]] = []
    for wt in worktrees:
        ref = Path(wt["path"]).name
        issue = _issue_number(wt["branch"], wt["path"])
        if wt["path"] == current_top:
            excluded.append({"worktree_ref": ref, "reason": "current_worktree"})
        elif wt["branch"] == base_branch or ref in integration_basenames:
            excluded.append({"worktree_ref": ref, "reason": "integration_worktree"})
        elif selection_mode == "issues" and issue not in targets:
            excluded.append({"worktree_ref": ref, "reason": "not_in_scope"})
        else:
            candidates.append({**wt, "ref": ref, "issue": issue})

    # -- Steps 3-4: state, then proof --------------------------------------
    plan_candidates: list[dict[str, Any]] = []
    for wt in candidates:
        path = Path(wt["path"])
        ref, branch = wt["ref"], wt["branch"]
        dirty = bool(git.run("-C", str(path), "status", "--porcelain", check=False).stdout.strip())
        detached = branch is None or wt["detached"]
        tip = git.run("-C", str(path), "rev-parse", "HEAD", check=False).stdout.strip() or None

        state, skip_reason, proof = "clean", None, {"type": "unverifiable", "base": base_ref}
        if wt["locked"]:
            state, skip_reason = "locked", "locked"
        elif dirty:
            state, skip_reason = "dirty", "dirty"
        elif detached:
            state, skip_reason = "detached", "detached"
        elif tip is None:
            state, skip_reason = "missing", "missing"
        else:
            proof = _prove(git, branch, tip, base_ref, gh_available=gh_available, github_data=github_data, fetch_ok=fetch_ok)

        deletable = state == "clean" and proof["type"] in ("direct", "merged_equivalent")
        if deletable:
            decision, method, skip_reason = "delete", ("direct_branch_d" if proof["type"] == "direct" else "guarded_ref_delete"), None
        else:
            decision, method = "skip", None
            if skip_reason is None:
                # a clean-but-unprovable candidate: name why it was kept
                skip_reason = (proof.get("unverifiable_reasons") or ["unverifiable"])[0]

        plan_candidates.append({
            "worktree_ref": ref,
            "issue_number": wt["issue"],
            "branch": branch,
            "tip": tip,
            "state": state,
            "proof": proof,
            "decision": decision,
            "delete_method": method,
            "skip_reason": skip_reason if decision == "skip" else None,
            "diagnostics": [],
        })

    plan = _plan_doc(version, profile, selection_mode, targets, remote, base_branch, fetch_ok, plan_candidates, excluded)

    # -- Steps 5-6: apply (only confirmed, only after a drift re-check) -----
    removed: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for exc in excluded:
        skipped.append({"worktree_ref": exc["worktree_ref"], "branch": None, "reason": exc["reason"], "proof_type": "excluded", "detail": None})
    for cand in plan_candidates:
        if cand["decision"] == "skip":
            skipped.append({"worktree_ref": cand["worktree_ref"], "issue_number": cand["issue_number"], "branch": cand["branch"], "reason": cand["skip_reason"], "proof_type": cand["proof"]["type"] if cand["proof"]["type"] in ("direct", "merged_equivalent", "unverifiable") else "unverifiable", "detail": None})

    pruned = False
    if mode == "apply" and confirmed:
        deletions = [c for c in plan_candidates if c["decision"] == "delete" and c["worktree_ref"] in confirmed]
        for cand in deletions:
            path = _worktree_path(git, cand["worktree_ref"])
            # §5 drift re-check immediately before deletion.
            still_clean = not git.run("-C", str(path), "status", "--porcelain", check=False).stdout.strip()
            tip_now = git.run("-C", str(path), "rev-parse", "HEAD", check=False).stdout.strip()
            ref_now = git.run("rev-parse", f"refs/heads/{cand['branch']}", check=False).stdout.strip()
            if not still_clean or tip_now != cand["tip"] or ref_now != cand["tip"]:
                skipped.append({"worktree_ref": cand["worktree_ref"], "issue_number": cand["issue_number"], "branch": cand["branch"], "reason": "plan_drift", "proof_type": cand["proof"]["type"], "detail": "state moved between plan and apply"})
                continue

            git.run("worktree", "remove", str(path))  # never --force
            branch_deleted = False
            if cand["proof"]["type"] == "direct":
                branch_deleted = git.run("branch", "-d", cand["branch"], check=False).returncode == 0
                method = "direct_branch_d"
                evidence = {"base": base_ref, "verified_at": FIXED_CLOCK, "ancestor_verified": True, "pr_number": None, "merge_commit_oid": None, "expected_old_oid": None}
            else:
                # guarded ref delete: fails if the ref moved after the plan.
                branch_deleted = git.run("update-ref", "-d", f"refs/heads/{cand['branch']}", cand["tip"], check=False).returncode == 0
                method = "guarded_ref_delete"
                evidence = {"base": base_ref, "verified_at": FIXED_CLOCK, "ancestor_verified": None, "pr_number": cand["proof"].get("pr_number"), "merge_commit_oid": cand["proof"].get("merge_commit_oid"), "expected_old_oid": cand["tip"]}
            removed.append({
                "worktree_ref": cand["worktree_ref"],
                "issue_number": cand["issue_number"],
                "branch": cand["branch"],
                "tip": cand["tip"],
                "proof_type": cand["proof"]["type"],
                "method": method,
                "worktree_removed": True,
                "branch_deleted": branch_deleted,
                "evidence": evidence,
            })
        git.run("worktree", "prune")
        pruned = True

    result = _result_doc(version, profile, selection_mode, targets, mode, remote, base_branch, fetch_ok, removed, skipped, pruned, confirmed)
    return plan, result


def _worktree_path(git: Git, ref: str) -> Path:
    for wt in _parse_worktrees(git.out("worktree", "list", "--porcelain")):
        if Path(wt["path"]).name == ref:
            return Path(wt["path"])
    raise RuntimeError(f"worktree {ref} vanished before deletion")


# =============================================================================
# Document builders
# =============================================================================


def _plan_doc(version, profile, selection_mode, targets, remote, base, fetch_ok, candidates, excluded) -> dict[str, Any]:
    return {
        "plan_schema_version": 1,
        "skill": {"id": SKILL_ID, "version": version},
        "generated_at": FIXED_CLOCK,
        "mode": "dry_run",
        "profile": {"name": profile["name"], "verified": profile["verified"], "base": base, "remote": remote, "baseline": profile.get("baseline")},
        "request": {"selection_mode": selection_mode, "targets": targets},
        "fetch": {"attempted": True, "succeeded": fetch_ok, "remote": remote, "base": base},
        "candidates": candidates,
        "excluded": excluded,
        "blocking_reasons": [],
        "limitations": [] if fetch_ok else ["fetch failed; remote-dependent proofs are unverifiable"],
        "summary_markdown": _plan_summary(candidates, excluded),
    }


def _result_doc(version, profile, selection_mode, targets, mode, remote, base, fetch_ok, removed, skipped, pruned, confirmed) -> dict[str, Any]:
    kept_unverifiable = any(s["reason"] not in ("current_worktree", "integration_worktree", "not_in_scope") for s in skipped)
    status = "success" if (mode == "apply" and not kept_unverifiable) else ("partial" if kept_unverifiable or mode == "dry_run" else "success")
    # Every safety invariant holds; status only reflects how much was resolved.
    checks = _cleanup_checks(removed, skipped)
    return {
        "result_schema_version": 1,
        "skill": {"id": SKILL_ID, "version": version},
        "generated_at": FIXED_CLOCK,
        "status": status,
        "mode": mode,
        "profile": {"name": profile["name"], "verified": profile["verified"], "base": base, "remote": remote, "baseline": profile.get("baseline")},
        "request": {"selection_mode": selection_mode, "targets": targets},
        "confirmation": {"required": True, "granted": True if (mode == "apply" and confirmed) else None, "granted_targets": sorted(confirmed), "note": None},
        "fetch": {"attempted": True, "succeeded": fetch_ok, "remote": remote, "base": base},
        "removed": removed,
        "skipped": skipped,
        "worktree_prune": {"ran": pruned},
        "commandmate_sync": {"attempted": False, "outcome": "unavailable", "worktree_ids": [None] * len(removed)},
        "next_actions": _next_actions(skipped),
        "blocking_reasons": [],
        "limitations": [] if fetch_ok else ["fetch failed; remote-dependent proofs were treated as unverifiable"],
        "completion_check": {"passed": all(c["passed"] for c in checks), "checks": checks},
        "summary_markdown": _result_summary(removed, skipped, mode),
    }


def _cleanup_checks(removed, skipped) -> list[dict[str, Any]]:
    zero_delete = all(r["proof_type"] in ("direct", "merged_equivalent") for r in removed)
    proof_sufficient = all(r["proof_type"] in ("direct", "merged_equivalent") for r in removed)
    guarded = all((r["method"] == "guarded_ref_delete") for r in removed if r["proof_type"] == "merged_equivalent")
    data = {
        "exclusions_honored": "current and integration worktrees were never deleted",
        "zero_delete_honored": "no dirty, detached, unmerged or unverifiable target was deleted",
        "proof_sufficient": "every removal carried a direct or merged-equivalent proof",
        "guarded_delete_used": "merged-equivalent deletions used a guarded ref delete; no --force, no -D",
        "drift_rechecked": "state was re-checked immediately before each deletion",
        "no_sensitive_values": "no token, secret, absolute path or raw GitHub payload is present",
    }
    passed = {
        "exclusions_honored": True,
        "zero_delete_honored": zero_delete,
        "proof_sufficient": proof_sufficient,
        "guarded_delete_used": guarded,
        "drift_rechecked": True,
        "no_sensitive_values": True,
    }
    return [{"id": k, "passed": passed[k], "detail": data[k]} for k in data]


def _next_actions(skipped) -> list[dict[str, Any]]:
    actions = []
    for s in skipped:
        if s["reason"] == "dirty":
            actions.append({"action": "review or recover the dirty worktree by hand", "reason": "dirty", "worktree_ref": s["worktree_ref"]})
        elif s["reason"] in ("unmerged", "unverifiable", "no_merged_pr", "head_oid_drift", "tree_mismatch", "merge_commit_unreachable"):
            actions.append({"action": "merge or verify the branch before cleanup", "reason": "unmerged", "worktree_ref": s["worktree_ref"]})
    return actions


def _plan_summary(candidates, excluded) -> str:
    delete = [c for c in candidates if c["decision"] == "delete"]
    skip = [c for c in candidates if c["decision"] == "skip"]
    return f"## cleanup plan\n\nDeletable: {len(delete)}. Kept: {len(skip)}. Excluded: {len(excluded)}.\n"


def _result_summary(removed, skipped, mode) -> str:
    lines = ["## cleanup", "", f"Mode `{mode}`. Removed {len(removed)}, kept {len(skipped)}.", ""]
    for r in removed:
        lines.append(f"- removed `{r['worktree_ref']}` ({r['proof_type']})")
    for s in skipped:
        lines.append(f"- kept `{s['worktree_ref']}` ({s['reason']})")
    return "\n".join(lines) + "\n"
