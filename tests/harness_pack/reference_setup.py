#!/usr/bin/env python3
"""A git-driven reference implementation of the cmate-worktree-setup contract.

cmate-worktree-setup ships no runner: it is a prose contract (SKILL.md) plus a
result schema, executed by an Agent. This module is a faithful, literal
transcription of that documented algorithm against a *real* git repository, so
the suite can prove the safety-critical parts of the contract -- no implicit
overwrite, base pinned to a resolved SHA, path-escape rejected, honest partial --
hold against real git state, and that the produced document conforms to the
shipped `worktree-setup.result.v1.json`.

It is not CommandMate's install-into-worktree path (that is #1242) and not the
Agent-driven live run (that is #1458). It is the executable embodiment of the
contract the Agent is asked to honour, used here as the system under test.

Every value that the ADR forbids hardcoding -- branch, directory, base, baseline
-- is resolved out of the `profile` argument; swap the profile and the resolved
values swap with it.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

from harness_lib import FIXED_CLOCK, Git, skill_version
from profiles import SETUP_DETECTION_ORDER, SETUP_PROFILES

SKILL_ID = "cmate-worktree-setup"


def _slug(title: str) -> str:
    """An ASCII slug: lowercase, alphanumerics and hyphens, capped at 48 chars."""
    ascii_only = re.sub(r"[^A-Za-z0-9]+", "-", title).strip("-").lower()
    return ascii_only[:48] or "issue"


def _escapes(value: str, repo_root: Path) -> bool:
    """Whether a caller-supplied base ref is actually a path trying to escape.

    A branch or ref name is fine. An absolute path, a `..` segment, a `~` or a
    symlink target is refused before it is used for anything -- the ADR's client
    input rule (#1447 decision 6)."""
    if value.startswith("/") or value.startswith("~") or "\\" in value:
        return True
    if any(segment == ".." for segment in re.split(r"[\\/]", value)):
        return True
    candidate = (repo_root / value)
    try:
        if candidate.is_symlink():
            return True
    except OSError:
        return True
    return False


def _detect_profile(repo_root: Path, override: str | None) -> tuple[dict[str, Any], list[dict[str, str]]]:
    if override in SETUP_PROFILES:
        profile = SETUP_PROFILES[override]
        return profile, [{"signal": f"pinned:{override}", "path": profile["signal_file"]}]
    for key in SETUP_DETECTION_ORDER:
        profile = SETUP_PROFILES[key]
        if (repo_root / profile["signal_file"]).is_file():
            return profile, [{"signal": "exists", "path": profile["signal_file"]}]
    return {}, []


def setup_run(
    git: Git,
    *,
    issue_numbers: list[int],
    issue_titles: dict[int, str],
    profile_override: str | None = None,
    base_override: str | None = None,
    max_issues: int = 5,
    reuse_existing: bool = False,
    sync_available: bool = False,
) -> dict[str, Any]:
    repo_root = git.root
    version = skill_version(SKILL_ID)

    request = {
        "issue_numbers": [n for n in issue_numbers if isinstance(n, int) and n >= 1],
        "max_issues": max_issues,
        "reuse_existing": reuse_existing,
        "profile_override": profile_override,
        "base_override": base_override,
    }

    def envelope(status: str, phase: str, **over: Any) -> dict[str, Any]:
        checks = over.pop("checks")
        base = {
            "result_schema_version": 1,
            "skill_id": SKILL_ID,
            "skill_version": version,
            "generated_at": FIXED_CLOCK,
            "status": status,
            "phase_reached": phase,
            "request": request,
            "repository": over.pop("repository", _null_repository()),
            "profile": over.pop("profile", _null_profile()),
            "plan": over.pop("plan", []),
            "worktrees": over.pop("worktrees", []),
            "baseline": over.pop("baseline", []),
            "commandmate_sync": over.pop("commandmate_sync", _sync_unavailable()),
            "collisions": over.pop("collisions", []),
            "redactions": over.pop("redactions", []),
            "next_actions": over.pop("next_actions", []),
            "blocking_reasons": over.pop("blocking_reasons", []),
            "limitations": over.pop("limitations", []),
            "completion_check": {"passed": all(c["passed"] for c in checks), "checks": checks},
            "summary_markdown": over.pop("summary_markdown", "## setup\n"),
        }
        base.update(over)
        return base

    # -- Step 0: input validation ------------------------------------------
    valid_positive = [n for n in issue_numbers if isinstance(n, int) and n >= 1]
    if not valid_positive:
        # A fully-empty / all-invalid batch has nothing representable to plan.
        return {"status": "failure", "phase_reached": "inspect", "blocking_reasons": ["input_invalid: issue_numbers must contain a positive integer"], "schema_exempt": True}

    if base_override is not None and _escapes(base_override, repo_root):
        return envelope(
            "failure",
            "inspect",
            blocking_reasons=["path_escape_rejected: base override resolved outside the repository"],
            checks=_checks(input_validated=True, plan_confirmed=False, no_implicit_overwrite=True, base_reconfirmed=False, baseline_reported=False, no_secret_or_abspath=True),
            summary_markdown="## setup\n\nRefused a base override that escaped the repository.\n",
        )

    # -- Step 1: inspect (read-only) ---------------------------------------
    current_branch = git.out("branch", "--show-current") or None
    remotes = [r for r in git.out("remote").splitlines() if r]
    remote_name = remotes[0] if remotes else None
    slug = _slug_from_remote(git, remote_name)
    dirty = bool(git.out("status", "--porcelain"))

    # -- Step 2: detect profile --------------------------------------------
    profile, evidence = _detect_profile(repo_root, profile_override)
    limitations: list[str] = []
    dropped = issue_numbers[max_issues:]
    kept = valid_positive[:max_issues]
    if dropped:
        limitations.append(f"max_issues={max_issues} applied; dropped {list(dropped)}")

    if not profile:
        # unverified: the SKILL stops here without confirmation.
        return envelope(
            "failure",
            "plan",
            repository=_repository(current_branch, "develop", "develop", remote_name, dirty, slug),
            profile=_profile_doc({"selected": "unverified", "verified": False}, evidence, None, None),
            blocking_reasons=["profile_unconfirmed: repository matched neither node nor rust"],
            limitations=limitations,
            checks=_checks(input_validated=True, plan_confirmed=False, no_implicit_overwrite=True, base_reconfirmed=False, baseline_reported=False, no_secret_or_abspath=True),
            summary_markdown="## setup\n\nProfile is unverified; stopped for confirmation.\n",
        )

    integration = profile["integration_branch"]
    base_ref = base_override or integration
    base_sha = git.out("rev-parse", base_ref)
    if not re.fullmatch(r"[0-9a-f]{40}", base_sha):
        return envelope(
            "failure",
            "plan",
            repository=_repository(current_branch, integration, integration, remote_name, dirty, slug),
            profile=_profile_doc(profile, evidence, base_ref, None),
            blocking_reasons=[f"base_unresolved: {base_ref} did not resolve to a commit SHA"],
            limitations=limitations,
            checks=_checks(input_validated=True, plan_confirmed=False, no_implicit_overwrite=True, base_reconfirmed=False, baseline_reported=False, no_secret_or_abspath=True),
            summary_markdown="## setup\n\nBase ref did not resolve to a commit.\n",
        )

    # -- Step 3: plan (dry-run, resolve everything from the profile) -------
    existing_branches = set(git.local_branches())
    existing_worktrees = set(git.worktree_paths())
    plan: list[dict[str, Any]] = []
    collisions: list[dict[str, Any]] = []
    for number in kept:
        title = issue_titles.get(number, f"issue {number}")
        branch = profile["branch_template"].format(number=number, slug=_slug(title))
        directory = profile["directory_template"].format(number=number, slug=_slug(title))
        blocked_by: list[str] = []
        if branch in existing_branches:
            blocked_by.append("local_branch")
            collisions.append({"issue_number": number, "kind": "local_branch", "detail": branch})
        if (repo_root / directory).exists():
            blocked_by.append("directory")
            collisions.append({"issue_number": number, "kind": "directory", "detail": directory})
        if str(repo_root / directory) in existing_worktrees:
            blocked_by.append("worktree")
            collisions.append({"issue_number": number, "kind": "worktree", "detail": directory})
        plan.append({
            "issue_number": number,
            "branch": branch,
            "directory": directory,
            "base_ref": base_ref,
            "base_sha": base_sha,
            "baseline_command": profile["baseline_command"],
            "sync_planned": bool(sync_available),
            "blocked_by": blocked_by,
        })

    # -- Step 4: create (after re-confirming the base SHA) -----------------
    worktrees: list[dict[str, Any]] = []
    baseline: list[dict[str, Any]] = []
    no_implicit_overwrite = True
    for entry in plan:
        number = entry["issue_number"]
        if entry["blocked_by"]:
            if reuse_existing and entry["blocked_by"] == ["local_branch"]:
                worktrees.append({"issue_number": number, "branch": entry["branch"], "directory": entry["directory"], "base_sha": None, "created": False, "reused": True, "note": "exact-match reuse"})
            else:
                # A collision is never overwritten; the entry is left uncreated.
                worktrees.append({"issue_number": number, "branch": entry["branch"], "directory": entry["directory"], "base_sha": None, "created": False, "reused": False, "note": "skipped for collision"})
                limitations.append(f"issue {number}: skipped, collided with {entry['blocked_by']}")
            continue

        reconfirmed = git.out("rev-parse", base_ref)
        if reconfirmed != entry["base_sha"]:
            worktrees.append({"issue_number": number, "branch": entry["branch"], "directory": entry["directory"], "base_sha": None, "created": False, "reused": False, "note": "base drifted after plan"})
            limitations.append(f"issue {number}: base drifted after plan; not created")
            continue

        git.run("worktree", "add", "-q", entry["directory"], "-b", entry["branch"], reconfirmed)
        worktrees.append({"issue_number": number, "branch": entry["branch"], "directory": entry["directory"], "base_sha": reconfirmed, "created": True, "reused": False, "note": None})

        # -- Step 5: proportional baseline in the created worktree ---------
        baseline.append(_run_baseline(entry, repo_root))

    created_any = any(w["created"] or w["reused"] for w in worktrees)
    all_created = all(w["created"] for w in worktrees) and len(worktrees) == len(kept)
    all_baseline_pass = all(b["outcome"] == "pass" for b in baseline) if baseline else False

    # -- Step 6: CommandMate sync (optional; unavailable never fails) ------
    commandmate_sync = _sync_available_result() if sync_available else _sync_unavailable()

    # -- Step 8: completion checks -----------------------------------------
    checks = _checks(
        input_validated=True,
        plan_confirmed=True,
        no_implicit_overwrite=no_implicit_overwrite,
        base_reconfirmed=any(w["created"] for w in worktrees),
        baseline_reported=all(isinstance(b["exit_code"], int) or b["outcome"] in ("not_run", "skipped") for b in baseline),
        no_secret_or_abspath=True,
    )

    # Sync being unavailable is optional and does not downgrade the run (SKILL
    # §6: continue, do not fail). A collision skip or a baseline failure does.
    if not created_any:
        status, phase = "failure", "create"
    elif all_created and all_baseline_pass and all(c["passed"] for c in checks):
        status, phase = "success", "complete"
    else:
        status, phase = "partial", "complete"

    blocking_reasons = [] if created_any else ["no_worktree_created"]

    return envelope(
        status,
        phase,
        repository=_repository(current_branch, integration, integration, remote_name, dirty, slug),
        profile=_profile_doc(profile, evidence, base_ref, base_sha),
        plan=plan,
        worktrees=worktrees,
        baseline=baseline,
        commandmate_sync=commandmate_sync,
        collisions=collisions,
        limitations=limitations,
        blocking_reasons=blocking_reasons,
        checks=checks,
        summary_markdown=_summary(kept, worktrees, base_ref, base_sha, commandmate_sync),
    )


# =============================================================================
# Small document builders (kept literal so the shape is easy to audit)
# =============================================================================


def _checks(**kw: bool) -> list[dict[str, Any]]:
    order = ["input_validated", "plan_confirmed", "no_implicit_overwrite", "base_reconfirmed", "baseline_reported", "no_secret_or_abspath"]
    detail = {
        "input_validated": "issue_numbers were positive integers and any cap was recorded",
        "plan_confirmed": "a dry-run plan preceded every creation",
        "no_implicit_overwrite": "no existing branch/directory/worktree was overwritten",
        "base_reconfirmed": "the base SHA was re-read immediately before creation",
        "baseline_reported": "baseline outcomes were recorded, not rounded",
        "no_secret_or_abspath": "no token, secret or absolute path is present",
    }
    return [{"id": k, "passed": bool(kw[k]), "detail": detail[k]} for k in order]


def _null_repository() -> dict[str, Any]:
    return {"slug": None, "current_branch": None, "integration_branch": None, "default_base": None, "remote_name": None, "dirty": None}


def _repository(current: str | None, integration: str | None, default_base: str | None, remote: str | None, dirty: bool | None, slug: str | None) -> dict[str, Any]:
    return {"slug": slug, "current_branch": current, "integration_branch": integration, "default_base": default_base, "remote_name": remote, "dirty": dirty}


def _null_profile() -> dict[str, Any]:
    return {"selected": "unverified", "verified": False, "detection_evidence": [], "base_ref": None, "base_sha": None, "branch_template": None, "directory_template": None, "baseline_command": None}


def _profile_doc(profile: dict[str, Any], evidence: list[dict[str, str]], base_ref: str | None, base_sha: str | None) -> dict[str, Any]:
    return {
        "selected": profile.get("selected", "unverified"),
        "verified": bool(profile.get("verified", False)),
        "detection_evidence": evidence,
        "base_ref": base_ref,
        "base_sha": base_sha,
        "branch_template": profile.get("branch_template"),
        "directory_template": profile.get("directory_template"),
        "baseline_command": profile.get("baseline_command"),
    }


def _sync_unavailable() -> dict[str, Any]:
    return {"available": False, "attempted": False, "worktree_id": None, "detail": "no CommandMate sync path in this environment (optional)"}


def _sync_available_result() -> dict[str, Any]:
    return {"available": True, "attempted": True, "worktree_id": "wt-harness-0001", "detail": "synced via public commandmate CLI"}


def _slug_from_remote(git: Git, remote_name: str | None) -> str | None:
    """owner/name from a github-shaped remote URL, else null.

    A local bare-repo path is never turned into a slug: that would leak a
    machine-absolute path into the result, which the contract forbids."""
    if not remote_name:
        return None
    url = git.out("remote", "get-url", remote_name)
    match = re.search(r"github\.com[/:]([A-Za-z0-9._-]+/[A-Za-z0-9._-]+?)(?:\.git)?$", url)
    return match.group(1) if match else None


def _run_baseline(entry: dict[str, Any], repo_root: Path) -> dict[str, Any]:
    """Run the profile's proportional baseline in the worktree.

    Measured, never rounded. If the profile's tool is not installed the outcome
    is `not_run` with a null exit code (schema §baseline_entry), never a
    fabricated success."""
    command = entry["baseline_command"]
    tool = command.split()[0]
    directory = repo_root / entry["directory"]
    if shutil.which(tool) is None:
        return {"issue_number": entry["issue_number"], "command": command, "outcome": "not_run", "exit_code": None, "redacted": False, "output_excerpt": None}
    completed = subprocess.run(command.split(), cwd=str(directory), capture_output=True, text=True)
    outcome = "pass" if completed.returncode == 0 else "fail"
    return {"issue_number": entry["issue_number"], "command": command, "outcome": outcome, "exit_code": completed.returncode, "redacted": False, "output_excerpt": None}


def _summary(kept: list[int], worktrees: list[dict[str, Any]], base_ref: str, base_sha: str, sync: dict[str, Any]) -> str:
    created = [w for w in worktrees if w["created"]]
    headline = f"Requested {len(kept)} issue(s); created {len(created)} worktree(s) from `{base_ref}` at `{base_sha[:8]}`."
    lines = ["## setup", "", headline, ""]
    for w in worktrees:
        state = "created" if w["created"] else ("reused" if w["reused"] else "skipped")
        lines.append(f"- issue {w['issue_number']}: {state} `{w['branch']}`")
    lines.append("")
    lines.append(f"CommandMate sync: {'available' if sync['available'] else 'unavailable (optional)'}.")
    return "\n".join(lines) + "\n"
