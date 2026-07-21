#!/usr/bin/env python3
"""Shared utilities for the Harness Pack integration suite.

Everything here is Python standard library only, like the rest of this
repository's tooling. The suite never touches the network, a real token or a
real model; it drives the three Harness Pack Skills against a fake CommandMate/
gh/git CLI, a temporary git repository built from scratch, and a deterministic
clock, so a green run means the same thing on every machine and in CI.

What this module provides:

- `Reporter` -- a tiny TAP-ish assertion collector shared by every phase.
- `MiniSchema` -- a standard-library JSON Schema validator covering exactly the
  keywords the shipped result/plan schemas use, so the schema a Skill ships and
  the check the suite runs can never drift apart. (Same philosophy as the
  per-Skill graders under `tests/fixtures/*/check_result.py`.)
- `Git` -- a deterministic git wrapper that records every invocation and refuses
  the destructive flags the cleanup contract forbids (`--force`, `branch -D`),
  so a forbidden operation is impossible by construction *and* provable from the
  audit log.
- redaction scanners for secrets and machine-absolute paths.
- `import_cmate_skills()` -- put `scripts/` on the path and hand back the
  packaging primitives the release tooling already exposes.
"""

from __future__ import annotations

import hashlib
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"

#: The three Skills this suite exists to integrate.
HARNESS_PACK_SKILLS = ("cmate-worktree-setup", "cmate-worktree-cleanup", "cmate-orchestrate")

#: A frozen instant used everywhere a document records `generated_at`. A fixed
#: clock keeps the whole suite a pure function of its inputs.
FIXED_CLOCK = "2026-01-02T03:04:05Z"

#: A synthetic, obviously-not-real 40-hex commit used as release provenance for
#: the throwaway artifacts Phase A builds. The suite never publishes anything, so
#: a placeholder that is stable (and therefore reproducible) is exactly right.
SYNTHETIC_COMMIT = "0" * 40


# =============================================================================
# Reporting
# =============================================================================


class Reporter:
    """Collects assertions across phases and prints a single verdict.

    A failed assertion is recorded, never raised: one broken invariant should
    not hide the twenty that still hold, and a reviewer wants the whole picture
    in one run.
    """

    def __init__(self) -> None:
        self.failures: list[str] = []
        self.passed = 0

    def check(self, condition: bool, message: str) -> bool:
        if condition:
            self.passed += 1
        else:
            self.failures.append(message)
            print(f"    FAIL {message}")
        return bool(condition)

    def section(self, title: str) -> None:
        print(f"  -- {title} --")

    def note(self, message: str) -> None:
        print(f"    .. {message}")

    def ok(self) -> bool:
        return not self.failures


# =============================================================================
# Minimal JSON Schema validator
# =============================================================================
#
# Only the keywords the shipped schemas use. A general validator would be a
# dependency, and a dependency here would defeat the point of a stdlib-only
# suite that runs in the same environment as the release pipeline.


class MiniSchema:
    def __init__(self, schema: dict[str, Any]) -> None:
        self.root = schema

    def errors(self, value: Any) -> list[str]:
        out: list[str] = []
        self._validate(value, self.root, "", out)
        return out

    # -- helpers --------------------------------------------------------------

    @staticmethod
    def _json_equal(value: Any, expected: Any) -> bool:
        """Equality with JSON's type distinctions, not Python's.

        `True == 1` in Python; in these schemas a boolean is never an integer.
        """
        if isinstance(expected, bool) or isinstance(value, bool):
            return isinstance(value, bool) and isinstance(expected, bool) and value == expected
        if isinstance(expected, int) and not isinstance(value, bool) and isinstance(value, float):
            return False
        return value == expected

    @staticmethod
    def _matches_type(value: Any, expected: str) -> bool:
        if expected == "object":
            return isinstance(value, dict)
        if expected == "array":
            return isinstance(value, list)
        if expected == "string":
            return isinstance(value, str)
        if expected == "boolean":
            return isinstance(value, bool)
        if expected == "null":
            return value is None
        if expected == "integer":
            return isinstance(value, int) and not isinstance(value, bool)
        if expected == "number":
            return isinstance(value, (int, float)) and not isinstance(value, bool)
        raise ValueError(f"unsupported schema type: {expected}")

    def _resolve_ref(self, ref: str) -> dict[str, Any]:
        if not ref.startswith("#/"):
            raise ValueError(f"only local refs are supported: {ref}")
        node: Any = self.root
        for part in ref[2:].split("/"):
            node = node[part.replace("~1", "/").replace("~0", "~")]
        return node

    def _validate(self, value: Any, schema: dict[str, Any], path: str, out: list[str]) -> None:
        if "$ref" in schema:
            self._validate(value, self._resolve_ref(schema["$ref"]), path, out)
            return

        # anyOf / oneOf are used stand-alone in these schemas (e.g. "a SHA or
        # null"). Evaluate them and stop: there are no sibling keywords to apply.
        if "anyOf" in schema:
            if not any(not self._branch_errors(value, sub, path) for sub in schema["anyOf"]):
                out.append(f"{path}: matched none of anyOf")
            return
        if "oneOf" in schema:
            matched = sum(1 for sub in schema["oneOf"] if not self._branch_errors(value, sub, path))
            if matched != 1:
                out.append(f"{path}: matched {matched} of oneOf, expected exactly 1")
            return

        if "const" in schema and not self._json_equal(value, schema["const"]):
            out.append(f"{path}: expected const {schema['const']!r}, got {value!r}")
        if "enum" in schema and not any(self._json_equal(value, opt) for opt in schema["enum"]):
            out.append(f"{path}: {value!r} is not one of {schema['enum']}")

        expected = schema.get("type")
        if expected is not None:
            allowed = [expected] if isinstance(expected, str) else list(expected)
            if not any(self._matches_type(value, t) for t in allowed):
                got = "null" if value is None else type(value).__name__
                out.append(f"{path}: expected type {expected}, got {got}")
                return

        if isinstance(value, str):
            if "minLength" in schema and len(value) < schema["minLength"]:
                out.append(f"{path}: shorter than minLength {schema['minLength']}")
            if "maxLength" in schema and len(value) > schema["maxLength"]:
                out.append(f"{path}: longer than maxLength {schema['maxLength']}")
            # fullmatch, not search: `$` matches before a trailing newline, so a
            # search would wave through `"x\n"` against an anchored pattern.
            if "pattern" in schema and re.fullmatch(schema["pattern"], value, re.UNICODE) is None:
                out.append(f"{path}: does not match pattern {schema['pattern']}")
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            if "minimum" in schema and value < schema["minimum"]:
                out.append(f"{path}: below minimum {schema['minimum']}")
            if "maximum" in schema and value > schema["maximum"]:
                out.append(f"{path}: above maximum {schema['maximum']}")
        elif isinstance(value, list):
            if "minItems" in schema and len(value) < schema["minItems"]:
                out.append(f"{path}: fewer than minItems {schema['minItems']}")
            if "maxItems" in schema and len(value) > schema["maxItems"]:
                out.append(f"{path}: more than maxItems {schema['maxItems']}")
            item_schema = schema.get("items")
            if item_schema is not None:
                for index, item in enumerate(value):
                    self._validate(item, item_schema, f"{path}[{index}]", out)
        elif isinstance(value, dict):
            properties = schema.get("properties", {})
            for key in schema.get("required", []):
                if key not in value:
                    out.append(f"{path}: missing required {key!r}")
            if schema.get("additionalProperties") is False:
                for key in value:
                    if key not in properties:
                        out.append(f"{path}: unexpected property {key!r}")
            for key, sub in properties.items():
                if key in value:
                    self._validate(value[key], sub, f"{path}/{key}", out)

    def _branch_errors(self, value: Any, schema: dict[str, Any], path: str) -> list[str]:
        local: list[str] = []
        self._validate(value, schema, path, local)
        return local


# =============================================================================
# Deterministic git wrapper with a destructive-flag guard
# =============================================================================


class ForbiddenGitOperation(RuntimeError):
    """Raised when a driver tries a flag the cleanup contract forbids."""


#: The deterministic environment every git invocation runs under. Fixed identity
#: and dates make commit ids a pure function of content; devnull config files cut
#: the run loose from whatever gitconfig the developer happens to have.
_GIT_ENV = {
    "GIT_AUTHOR_NAME": "Harness Pack",
    "GIT_AUTHOR_EMAIL": "harness@example.invalid",
    "GIT_COMMITTER_NAME": "Harness Pack",
    "GIT_COMMITTER_EMAIL": "harness@example.invalid",
    "GIT_AUTHOR_DATE": "2026-01-02T03:04:05 +0000",
    "GIT_COMMITTER_DATE": "2026-01-02T03:04:05 +0000",
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_SYSTEM": os.devnull,
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_ADVICE": "0",
}


@dataclass
class GitResult:
    args: list[str]
    returncode: int
    stdout: str
    stderr: str


class Git:
    """A per-repository git driver that records and guards every call.

    `audit` is the ordered list of argv the driver ran. The cleanup safety
    proof reads it to show, in addition to the guard raising, that no `--force`
    and no `git branch -D` was ever attempted.
    """

    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.audit: list[list[str]] = []

    @staticmethod
    def _guard(args: list[str]) -> None:
        sub = args[0] if args else ""
        toks = set(args)
        if "--force" in toks:
            raise ForbiddenGitOperation(f"--force is forbidden: git {' '.join(args)}")
        if sub == "branch" and "-D" in toks:
            raise ForbiddenGitOperation(f"git branch -D is forbidden: {' '.join(args)}")
        if sub == "worktree" and ("-f" in toks):
            raise ForbiddenGitOperation(f"git worktree -f is forbidden: {' '.join(args)}")
        if sub == "clean":
            raise ForbiddenGitOperation("git clean is never used by these Skills")

    def run(self, *args: str, cwd: Path | None = None, check: bool = True, record: bool = True) -> GitResult:
        argv = list(args)
        self._guard(argv)
        if record:
            self.audit.append(argv)
        env = {**os.environ, **_GIT_ENV}
        completed = subprocess.run(
            ["git", *argv],
            cwd=str(cwd or self.root),
            env=env,
            capture_output=True,
            text=True,
        )
        if check and completed.returncode != 0:
            raise RuntimeError(
                f"git {' '.join(argv)} failed ({completed.returncode}): {completed.stderr.strip()}"
            )
        return GitResult(argv, completed.returncode, completed.stdout, completed.stderr)

    def out(self, *args: str, cwd: Path | None = None) -> str:
        return self.run(*args, cwd=cwd).stdout.strip()

    # -- convenience queries used by the assertions ---------------------------

    def worktree_paths(self) -> list[str]:
        paths = []
        for line in self.out("worktree", "list", "--porcelain").splitlines():
            if line.startswith("worktree "):
                paths.append(line[len("worktree ") :])
        return paths

    def worktree_basenames(self) -> list[str]:
        return [Path(p).name for p in self.worktree_paths()]

    def local_branches(self) -> list[str]:
        raw = self.out("branch", "--format=%(refname:short)")
        return [b for b in raw.splitlines() if b]

    def used_forbidden_flag(self) -> bool:
        for argv in self.audit:
            toks = set(argv)
            if "--force" in toks or "-f" in toks:
                return True
            if argv[:1] == ["branch"] and "-D" in toks:
                return True
        return False


def init_repo(root: Path) -> Git:
    """Create an empty repository on branch `develop` with one initial commit."""
    root.mkdir(parents=True, exist_ok=True)
    git = Git(root)
    git.run("init", "-q", "-b", "develop")
    (root / "README.md").write_text("harness fixture\n", encoding="utf-8")
    git.run("add", "README.md")
    git.run("commit", "-q", "-m", "initial")
    return git


# =============================================================================
# Redaction scanners
# =============================================================================

#: Machine-absolute path shapes that must never survive into a result document
#: or a shipped artifact. A repository-relative path or an https URL is fine; a
#: home directory or a temp root is a leak.
_ABSOLUTE_PATH_MARKERS = (
    "/Users/",
    "/home/",
    "/root/",
    "/private/tmp/",
    "/private/var/",
    "/var/folders/",
    "/tmp/",
)

#: Credential shapes, mirrored from the repository's own secret scan intent. A
#: value copied into any field of a document is the same leak wherever it lands.
_SECRET_PATTERNS = (
    re.compile(r"ghp_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"gho_[A-Za-z0-9]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}"),
    re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
)


def find_secret_shapes(text: str) -> list[str]:
    hits = []
    for pattern in _SECRET_PATTERNS:
        if pattern.search(text):
            hits.append(pattern.pattern)
    return hits


def find_absolute_paths(text: str, extra_markers: Iterable[str] = ()) -> list[str]:
    hits = []
    for marker in (*_ABSOLUTE_PATH_MARKERS, *[m for m in extra_markers if m]):
        if marker and marker in text:
            hits.append(marker)
    return hits


# =============================================================================
# Packaging primitives from the release tooling
# =============================================================================


def import_cmate_skills() -> Any:
    """Make `cmate_skills` importable and return the module.

    The suite reuses the very code the release pipeline runs -- `check_package`,
    `read_package`, `compute_risk` -- rather than re-deriving the package
    contract, so it cannot disagree with what actually ships.
    """
    if str(SCRIPTS_DIR) not in sys.path:
        sys.path.insert(0, str(SCRIPTS_DIR))
    import cmate_skills  # noqa: E402  (path set up just above)

    return cmate_skills


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def skill_version(skill_id: str) -> str:
    """Read a Skill's declared version from its manifest, so documents the suite
    builds stay pinned to what actually ships rather than a copied constant."""
    import_cmate_skills()
    from cmate_skills.safe_yaml import parse_skill_yaml

    manifest_path = REPO_ROOT / "skills" / skill_id / "commandmate.skill.yaml"
    document = parse_skill_yaml(manifest_path.read_bytes())
    return str(document["version"])
