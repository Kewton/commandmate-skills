"""Reproducible release pipeline for the CommandMate official Skill repository.

Stdlib only, on purpose. The pipeline runs on a bare `ubuntu-latest` runner with
no package installation step, so a compromised or unavailable registry cannot
change what a release artifact contains.

The modules under this package mirror the distribution contract that
`Kewton/CommandMate` owns. See `docs/design/contract-sync.md` for the upstream
files, the pinned revision and the review procedure that keeps the two in step.
"""

__all__ = [
    "constants",
    "errors",
    "package",
    "repo",
    "safe_yaml",
    "schema",
    "semver",
]
