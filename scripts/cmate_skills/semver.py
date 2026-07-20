"""SemVer 2.0 and the range subset the distribution contract accepts.

Mirrors `src/lib/skills/semver.ts`. The range grammar is a small, total subset of
npm's: a space-separated AND list of comparators. `||`, x-ranges, `*` and hyphen
ranges are rejected so a range always has exactly one reading.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

SEMVER_2_PATTERN = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)"
    r"(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?"
    r"(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$"
)

SEMVER_MAX_LENGTH = 64
VERSION_RANGE_MAX_LENGTH = 100
VERSION_RANGE_MAX_COMPARATORS = 4

_OPERATOR_RE = re.compile(r"^(>=|<=|>|<|=|\^|~)?(.+)$")


@dataclass(frozen=True)
class ParsedSemVer:
    major: int
    minor: int
    patch: int
    prerelease: tuple[str, ...]
    build: tuple[str, ...]


def parse_semver(version: object) -> ParsedSemVer | None:
    if not isinstance(version, str) or len(version) > SEMVER_MAX_LENGTH:
        return None
    match = SEMVER_2_PATTERN.match(version)
    if match is None:
        return None
    return ParsedSemVer(
        major=int(match.group(1)),
        minor=int(match.group(2)),
        patch=int(match.group(3)),
        prerelease=tuple(match.group(4).split(".")) if match.group(4) else (),
        build=tuple(match.group(5).split(".")) if match.group(5) else (),
    )


def is_valid_semver(version: object) -> bool:
    return parse_semver(version) is not None


def _compare_prerelease(a: tuple[str, ...], b: tuple[str, ...]) -> int:
    # A release outranks any prerelease of the same major.minor.patch.
    if not a and not b:
        return 0
    if not a:
        return 1
    if not b:
        return -1
    for left, right in zip(a, b):
        if left == right:
            continue
        left_numeric = left.isdigit()
        right_numeric = right.isdigit()
        if left_numeric and right_numeric:
            return -1 if int(left) < int(right) else 1
        if left_numeric:
            return -1
        if right_numeric:
            return 1
        return -1 if left < right else 1
    if len(a) == len(b):
        return 0
    return -1 if len(a) < len(b) else 1


def compare_parsed(a: ParsedSemVer, b: ParsedSemVer) -> int:
    for left, right in ((a.major, b.major), (a.minor, b.minor), (a.patch, b.patch)):
        if left != right:
            return -1 if left < right else 1
    return _compare_prerelease(a.prerelease, b.prerelease)


def compare_semver(a: str, b: str) -> int | None:
    left = parse_semver(a)
    right = parse_semver(b)
    if left is None or right is None:
        return None
    return compare_parsed(left, right)


def _caret_upper(v: ParsedSemVer) -> ParsedSemVer:
    if v.major > 0:
        return ParsedSemVer(v.major + 1, 0, 0, (), ())
    if v.minor > 0:
        return ParsedSemVer(0, v.minor + 1, 0, (), ())
    return ParsedSemVer(0, 0, v.patch + 1, (), ())


def _tilde_upper(v: ParsedSemVer) -> ParsedSemVer:
    return ParsedSemVer(v.major, v.minor + 1, 0, (), ())


def parse_version_range(value: object) -> list[tuple[str, ParsedSemVer]] | None:
    """Desugar a range into `(operator, version)` comparators combined with AND."""
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    if not trimmed or len(trimmed) > VERSION_RANGE_MAX_LENGTH:
        return None
    if "||" in trimmed:
        return None

    tokens = trimmed.split()
    if len(tokens) > VERSION_RANGE_MAX_COMPARATORS:
        return None

    comparators: list[tuple[str, ParsedSemVer]] = []
    for token in tokens:
        match = _OPERATOR_RE.match(token)
        if match is None:
            return None
        operator = match.group(1) or "="
        version = parse_semver(match.group(2))
        if version is None:
            return None
        if operator in ("^", "~"):
            upper = _caret_upper(version) if operator == "^" else _tilde_upper(version)
            comparators.append((">=", version))
            comparators.append(("<", upper))
            continue
        comparators.append((operator, version))

    if len(comparators) > VERSION_RANGE_MAX_COMPARATORS * 2:
        return None
    return comparators


def is_valid_version_range(value: object) -> bool:
    return parse_version_range(value) is not None
