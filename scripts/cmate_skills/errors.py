"""Error vocabulary shared by the pipeline.

Findings are values, not exceptions: a validation run reports every problem in a
package rather than stopping at the first one, so a contributor fixes a package
in one pass instead of one CI round-trip per mistake.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Finding:
    """One reason a package, manifest or catalog was rejected."""

    #: Stable machine code, e.g. `SKILL_FILE_SET_MISMATCH`. Never localized.
    code: str
    #: JSON-pointer-ish location inside the document, or a repo-relative path.
    path: str
    #: One sentence, safe to print in CI output. Never echoes payload content.
    message: str
    detail: dict[str, object] = field(default_factory=dict)

    def __str__(self) -> str:
        suffix = ""
        if self.detail:
            rendered = ", ".join(f"{k}={v}" for k, v in sorted(self.detail.items()))
            suffix = f" ({rendered})"
        location = self.path or "/"
        return f"[{self.code}] {location}: {self.message}{suffix}"


class ContractError(Exception):
    """A rejection that cannot be collected and carried on from."""

    def __init__(self, code: str, message: str, **detail: object) -> None:
        super().__init__(message)
        self.code = code
        self.detail = detail

    def as_finding(self, path: str = "") -> Finding:
        return Finding(self.code, path, str(self), dict(self.detail))


def join_path(parent: str, key: object) -> str:
    return f"{parent}/{key}"
