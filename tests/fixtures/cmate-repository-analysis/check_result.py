#!/usr/bin/env python3
"""Grade one `cmate-repository-analysis` result against a fixture case.

    python3 tests/fixtures/cmate-repository-analysis/check_result.py \\
        --case nextjs-app --result my-run.json

    python3 tests/fixtures/cmate-repository-analysis/check_result.py --selftest

Two layers, in this order:

1. the result is validated against the schema the Skill ships
   (`skills/cmate-repository-analysis/schemas/repository-analysis.result.v1.json`),
   so schema and grader cannot drift apart -- there is only one schema;
2. the result is checked against the case, which is where the parts a schema
   cannot express live: does every cited line exist in the fixture repository,
   was the vendored directory left alone, did any secret *value* survive into
   the report.

The rubric in `rubric.md` grades what remains: whether the analysis is any good.
This script grades whether it is admissible. A result that fails here is not
scored by a human at all.

`--selftest` runs every sample under `samples/`, including samples that are
*expected to fail*. A grader that accepts everything is worse than no grader,
so the negative samples are what make a green run mean something.

Standard library only, like everything else in this repository.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
SCHEMA_PATH = (
    REPO_ROOT
    / "skills"
    / "cmate-repository-analysis"
    / "schemas"
    / "repository-analysis.result.v1.json"
)
CASES_DIR = HERE / "cases"
SAMPLES_DIR = HERE / "samples"

#: The six headings `summary_markdown` must carry, in this order, once each.
REQUIRED_HEADINGS = (
    "## 目的",
    "## 結論",
    "## 主要な発見",
    "## 再利用候補と変更risk",
    "## 推奨verification",
    "## 未解決と走査範囲",
)

COMPLETION_CHECK_IDS = (
    "evidence_present",
    "evidence_resolvable",
    "verification_grounded",
    "no_secret_values",
    "scope_declared",
)

#: Item lists whose entries all carry `evidence`.
EVIDENCE_BEARING = ("findings", "reuse_candidates", "risks", "recommended_verification")


# =============================================================================
# Minimal JSON Schema reader
# =============================================================================
#
# Only the keywords the shipped schema uses. A general validator would be a
# dependency, and a dependency here would mean the eval cannot run in the same
# stdlib-only environment as the release pipeline.


def validate_schema(value: Any, schema: dict[str, Any], root: dict[str, Any], path: str) -> list[str]:
    if "$ref" in schema:
        return validate_schema(value, resolve_ref(schema["$ref"], root), root, path)

    errors: list[str] = []

    # `==` alone would accept `True` where `1` is required, and `1.0` too:
    # Python's numeric tower is wider than JSON's type distinctions.
    if "const" in schema and not json_equal(value, schema["const"]):
        return [f"{path}: expected {schema['const']!r}, got {value!r}"]
    if "enum" in schema and not any(json_equal(value, option) for option in schema["enum"]):
        return [f"{path}: {value!r} is not one of {schema['enum']}"]

    expected = schema.get("type")
    if expected is not None and not matches_type(value, expected):
        return [f"{path}: expected type {expected}, got {type(value).__name__}"]

    if expected == "string":
        if "minLength" in schema and len(value) < schema["minLength"]:
            errors.append(f"{path}: shorter than minLength {schema['minLength']}")
        # `fullmatch`, not `search`: `$` matches before a trailing newline, so a
        # `search` would accept `"lib/x.ts\n"` against an anchored pattern.
        if "pattern" in schema and re.fullmatch(schema["pattern"], value) is None:
            errors.append(f"{path}: does not match pattern {schema['pattern']}")
    elif expected == "integer":
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{path}: below minimum {schema['minimum']}")
    elif expected == "array":
        if "minItems" in schema and len(value) < schema["minItems"]:
            errors.append(f"{path}: fewer than minItems {schema['minItems']}")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            errors.append(f"{path}: more than maxItems {schema['maxItems']}")
        item_schema = schema.get("items")
        if item_schema is not None:
            for index, item in enumerate(value):
                errors.extend(validate_schema(item, item_schema, root, f"{path}[{index}]"))
    elif expected == "object":
        properties = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{path}: missing required field {key!r}")
        if schema.get("additionalProperties") is False:
            for key in value:
                if key not in properties:
                    errors.append(f"{path}: unknown field {key!r}")
        for key, sub_schema in properties.items():
            if key in value:
                errors.extend(validate_schema(value[key], sub_schema, root, f"{path}/{key}"))

    return errors


def json_equal(value: Any, expected: Any) -> bool:
    """Equality with JSON's type distinctions rather than Python's."""
    if isinstance(expected, bool) or isinstance(value, bool):
        return isinstance(value, bool) and isinstance(expected, bool) and value == expected
    if isinstance(expected, int) and not isinstance(value, int):
        return False
    return value == expected


def matches_type(value: Any, expected: str) -> bool:
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "integer":
        # `True` is an `int` in Python and never an integer in this schema.
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    raise ValueError(f"unsupported schema type: {expected}")


def resolve_ref(ref: str, root: dict[str, Any]) -> dict[str, Any]:
    if not ref.startswith("#/"):
        raise ValueError(f"only local refs are supported: {ref}")
    node: Any = root
    for part in ref[2:].split("/"):
        node = node[part]
    return node


# =============================================================================
# Case checks
# =============================================================================


def repository_bytes(repo: Path | None) -> int | None:
    """Total size of the fixture repository, or None when there is no repo."""
    if repo is None or not repo.is_dir():
        return None
    return sum(entry.stat().st_size for entry in repo.rglob("*") if entry.is_file())


def line_counts(repo: Path | None) -> dict[str, int | None] | None:
    """Line count per repository-relative path, or None when there is no repo.

    A value of `None` means the file is not text: citing a line inside it is
    wrong no matter which line was cited.
    """
    if repo is None or not repo.is_dir():
        return None
    counts: dict[str, int | None] = {}
    for entry in sorted(repo.rglob("*")):
        if not entry.is_file():
            continue
        relative = entry.relative_to(repo).as_posix()
        try:
            text = entry.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            counts[relative] = None
            continue
        # `splitlines()` also breaks on U+2028, form feed and friends, which
        # would inflate the count above what any editor calls the last line.
        lines = text.split("\n")
        if lines and lines[-1] == "":
            lines.pop()
        counts[relative] = len(lines)
    return counts


def escapes_repository(path: str) -> bool:
    """Whether a declared path fails to name one file inside the repository.

    Deliberately stricter than the schema's `repo_path` pattern rather than a
    restatement of it. The pattern already stops `..`, a leading `/` and
    backslashes; what is left over is the set of paths that are *shaped* like a
    repository path but do not denote a file in it -- a Windows drive letter, a
    directory entry, a `.` segment, an empty segment. Those would otherwise sail
    through to the fixture comparison and, in a case with no fixture repository,
    through to no comparison at all.
    """
    if path.startswith("/") or "\\" in path or path.endswith("/"):
        return True
    if len(path) >= 2 and path[1] == ":" and path[0].isascii() and path[0].isalpha():
        return True
    segments = path.split("/")
    return any(segment in ("", ".", "..") for segment in segments)


def all_evidence(result: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    found: list[tuple[str, dict[str, Any]]] = []
    profile = result.get("repository_profile", {})
    for key in ("entry_points", "conventions"):
        for index, item in enumerate(profile.get(key, [])):
            for position, evidence in enumerate(item.get("evidence", [])):
                found.append((f"repository_profile/{key}[{index}]/evidence[{position}]", evidence))
    for key in EVIDENCE_BEARING:
        for index, item in enumerate(result.get(key, [])):
            for position, evidence in enumerate(item.get("evidence", [])):
                found.append((f"{key}[{index}]/evidence[{position}]", evidence))
    return found


def check_case(result: dict[str, Any], case: dict[str, Any], repo: Path | None) -> list[str]:
    errors: list[str] = []
    expect = case.get("expect", {})
    counts = line_counts(repo)

    # -- status and self-declared completion -----------------------------
    allowed_status = expect.get("status", ["success", "partial", "failure"])
    if result["status"] not in allowed_status:
        errors.append(f"status: {result['status']!r} is not one of {allowed_status}")

    checks = result["completion_check"]["checks"]
    seen = [entry["id"] for entry in checks]
    if sorted(seen) != sorted(COMPLETION_CHECK_IDS):
        errors.append(f"completion_check: ids must be exactly {list(COMPLETION_CHECK_IDS)}, got {seen}")
    all_passed = all(entry["passed"] for entry in checks)
    if result["completion_check"]["passed"] != all_passed:
        errors.append("completion_check: passed does not agree with the individual checks")
    if result["status"] == "success" and not all_passed:
        errors.append("status: success requires every completion check to pass")
    if result["status"] in ("partial", "failure") and not result["unresolved"]:
        errors.append(f"unresolved: status {result['status']} requires at least one entry")
    if result["status"] != "failure" and result["scope"]["files_read"] == 0:
        errors.append("scope: files_read is 0 but the status is not failure")

    # -- evidence resolves against the fixture ---------------------------
    for where, evidence in all_evidence(result):
        if evidence["line_end"] < evidence["line_start"]:
            errors.append(f"{where}: line_end is before line_start")
        # Checked even when there is no fixture repository to compare against:
        # a result that can name a path outside the analysed tree contradicts
        # the read-only declaration whether or not the path happens to exist.
        if escapes_repository(evidence["path"]):
            errors.append(f"{where}: cites {evidence['path']!r}, which points outside the repository")
            continue
        if counts is None:
            continue
        path = evidence["path"]
        if path not in counts:
            errors.append(f"{where}: cites {path!r}, which is not in the fixture repository")
            continue
        if counts[path] is None:
            errors.append(f"{where}: cites a line inside the binary file {path!r}")
        elif counts[path] == 0:
            errors.append(f"{where}: cites a line of {path!r}, which is empty")
        elif evidence["line_end"] > counts[path]:
            errors.append(
                f"{where}: cites line {evidence['line_end']} of {path!r}, which has {counts[path]} lines"
            )

    cited = {evidence["path"] for _, evidence in all_evidence(result)}
    # `evidence_resolvable` claims every cited file was read during the run, so
    # citing more distinct files than `files_read` is a self-contradiction.
    if len(cited) > result["scope"]["files_read"]:
        errors.append(
            f"scope: files_read is {result['scope']['files_read']} "
            f"but the evidence cites {len(cited)} distinct files"
        )
    for path in expect.get("required_evidence_paths", []):
        if path not in cited:
            errors.append(f"evidence: nothing cites {path!r}, which this case requires")
    for path in expect.get("forbidden_evidence_paths", []):
        if path in cited:
            errors.append(f"evidence: cites {path!r}, which the scan policy excludes")

    # -- sensitive locations ---------------------------------------------
    sensitive_paths = {entry["path"] for entry in result["sensitive_locations"]}
    for path in expect.get("required_sensitive_paths", []):
        if path not in sensitive_paths:
            errors.append(f"sensitive_locations: {path!r} was not reported")
    for entry in result["sensitive_locations"]:
        if escapes_repository(entry["path"]):
            errors.append(f"sensitive_locations: {entry['path']!r} points outside the repository")
        elif counts is None:
            continue
        elif entry["path"] not in counts:
            errors.append(f"sensitive_locations: {entry['path']!r} is not in the fixture repository")
        elif counts[entry["path"]] is None:
            errors.append(f"sensitive_locations: {entry['path']!r} is a binary file")
        elif entry["line"] > counts[entry["path"]]:
            errors.append(f"sensitive_locations: {entry['path']!r} has no line {entry['line']}")

    # The whole serialized result is searched, not just the fields where a
    # secret is *supposed* to be absent: a value copied into a statement or a
    # summary is the same leak as one copied into `sensitive_locations`.
    # Fragments, not whole values: the policy bans 値の一部 and 先頭数文字 too,
    # so a truncated or partly-masked literal has to fail the same way.
    serialized = json.dumps(result, ensure_ascii=False)
    for needle in expect.get("forbidden_fragments", []):
        if needle in serialized:
            errors.append("result: contains a secret value from the fixture repository")

    # -- verification is grounded ----------------------------------------
    commands = [entry["command"] for entry in result["recommended_verification"]]
    for needle in expect.get("required_verification_commands", []):
        if not any(needle in command for command in commands):
            errors.append(f"recommended_verification: no command contains {needle!r}")
    for entry in result["recommended_verification"]:
        if not entry["evidence"]:
            errors.append(f"recommended_verification: {entry['id']!r} has no evidence")

    # -- scope bookkeeping ------------------------------------------------
    declared_rules = {entry["rule"] for entry in result["scope"]["excluded"]}
    for rule in expect.get("required_excluded_rules", []):
        if rule not in declared_rules:
            errors.append(f"scope: exclusion rule {rule!r} was not reported")
    if "truncated" in expect and result["scope"]["truncated"] != expect["truncated"]:
        errors.append(f"scope: truncated should be {expect['truncated']}")
    if "files_read" in expect and result["scope"]["files_read"] != expect["files_read"]:
        errors.append(f"scope: files_read should be {expect['files_read']}")

    # `scope` is the part of the report a reader uses to decide how much of the
    # repository the analysis actually covered, so its numbers are checked
    # against the fixture rather than taken on trust.
    scope = result["scope"]
    if scope["files_read"] > scope["files_listed"]:
        errors.append(
            f"scope: files_read {scope['files_read']} exceeds files_listed {scope['files_listed']}"
        )
    if scope["files_read"] > 0 and scope["bytes_read"] == 0:
        errors.append("scope: files_read is positive but bytes_read is 0")
    total_bytes = repository_bytes(repo)
    if total_bytes is not None and scope["bytes_read"] > total_bytes:
        errors.append(
            f"scope: bytes_read {scope['bytes_read']} exceeds the whole fixture repository ({total_bytes})"
        )

    declared_reasons = {entry["reason_code"] for entry in result["unresolved"]}
    for reason in expect.get("required_reason_codes", []):
        if reason not in declared_reasons:
            errors.append(f"unresolved: reason_code {reason!r} was not reported")

    # -- minimum substance -------------------------------------------------
    for key in ("findings", "reuse_candidates", "risks", "recommended_verification"):
        minimum = expect.get(f"min_{key}")
        if minimum is not None and len(result[key]) < minimum:
            errors.append(f"{key}: {len(result[key])} entries, case requires at least {minimum}")

    # -- human-readable summary -------------------------------------------
    errors.extend(check_summary(result["summary_markdown"], expect))

    # -- ids are unique across every item list (result-contract §3.3) ------
    ids: list[str] = []
    for key in EVIDENCE_BEARING:
        ids.extend(entry["id"] for entry in result[key])
    duplicates = sorted({value for value in ids if ids.count(value) > 1})
    if duplicates:
        errors.append(f"ids: reused across items: {duplicates}")

    return errors


def check_summary(summary: str, expect: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    positions: list[int] = []
    for heading in REQUIRED_HEADINGS:
        occurrences = [
            index for index, line in enumerate(summary.splitlines()) if line.strip() == heading
        ]
        if len(occurrences) != 1:
            errors.append(f"summary_markdown: {heading!r} must appear exactly once, found {len(occurrences)}")
            continue
        positions.append(occurrences[0])
    if len(positions) == len(REQUIRED_HEADINGS) and positions != sorted(positions):
        errors.append("summary_markdown: headings are not in the required order")
    for needle in expect.get("required_summary_strings", []):
        if needle not in summary:
            errors.append(f"summary_markdown: does not mention {needle!r}")
    return errors


# =============================================================================
# Entry points
# =============================================================================


def load_case(case_id: str) -> tuple[dict[str, Any], Path | None]:
    case_dir = CASES_DIR / case_id
    case_file = case_dir / "case.json"
    if not case_file.is_file():
        raise SystemExit(f"unknown case: {case_id} (expected {case_file})")
    case = json.loads(case_file.read_text(encoding="utf-8"))
    repo = case_dir / "repo"
    return case, repo if repo.is_dir() else None


def grade(result: dict[str, Any], case_id: str) -> list[str]:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    errors = validate_schema(result, schema, schema, "")
    if errors:
        # Case checks index into fields the schema has just found missing, so
        # they would raise rather than report. Schema first, then the rest.
        return errors
    case, repo = load_case(case_id)
    return check_case(result, case, repo)


def run_selftest() -> int:
    index = json.loads((SAMPLES_DIR / "index.json").read_text(encoding="utf-8"))
    failures = 0
    for sample in index["samples"]:
        path = SAMPLES_DIR / sample["file"]
        result = json.loads(path.read_text(encoding="utf-8"))
        errors = grade(result, sample["case"])
        admissible = not errors
        expected = sample["expect"] == "admissible"
        if admissible == expected:
            detail = "admissible" if admissible else f"rejected ({len(errors)} finding(s))"
            print(f"OK   {sample['file']}: {detail}")
        else:
            failures += 1
            print(f"FAIL {sample['file']}: expected {sample['expect']}, got the opposite")
            print(f"     why it should be rejected: {sample['reason']}")
            for error in errors[:5]:
                print(f"     {error}")
    print()
    if failures:
        print(f"FAILED: {failures} sample(s) graded the wrong way")
        return 1
    print(f"PASSED: {len(index['samples'])} samples graded as expected")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", help="case id under cases/")
    parser.add_argument("--result", help="path to the result JSON to grade")
    parser.add_argument("--selftest", action="store_true", help="grade the bundled samples")
    args = parser.parse_args()

    if args.selftest:
        return run_selftest()
    if not args.case or not args.result:
        parser.error("--case and --result are required unless --selftest is given")

    try:
        result = json.loads(Path(args.result).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        # A run that produced unparsable output is a rejection with a reason,
        # not a traceback: the caller is grading, not debugging this script.
        print(f"REJECTED {args.result}")
        print(f"  result is not readable JSON: {error}")
        return 1
    if not isinstance(result, dict):
        print(f"REJECTED {args.result}")
        print("  result must be a JSON object")
        return 1
    errors = grade(result, args.case)
    if errors:
        print(f"REJECTED {args.result} ({len(errors)} finding(s))")
        for error in errors:
            print(f"  {error}")
        return 1
    print(f"ADMISSIBLE {args.result} (case {args.case}); score it with rubric.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
