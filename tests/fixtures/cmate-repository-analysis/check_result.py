#!/usr/bin/env python3
"""Grade one `cmate-repository-analysis` result against a fixture case.

    python3 tests/fixtures/cmate-repository-analysis/check_result.py \\
        --case nextjs-app --result my-run.json

    python3 tests/fixtures/cmate-repository-analysis/check_result.py --selftest

Two layers, and since 0.2.0 only one of them can reject:

1. **advisory** -- the result is read against the schema the Skill ships
   (`skills/cmate-repository-analysis/schemas/repository-analysis.result.v1.json`).
   That schema became advisory when the Skill did: nothing machine-consumes a
   `repository-analysis` result, so a shape complaint is a note, not a verdict.
   Notes are printed and do not change the exit status.
2. **blocking** -- the result is checked against the *discipline*, which is what
   the Skill is actually for and what a schema was never checking anyway: does
   every cited line exist in the fixture repository, does every path stay inside
   it, is `evidence` still nothing but a path and a line range, is
   `sensitive_locations` still nothing but path/line/classification, did any
   secret *value* survive into the report, was the vendored directory left
   alone, and does the declared scope agree with what was cited.

The two closed shapes in layer 2 are not a leftover of the strict schema. They
are the leak barrier: an extra key on an `evidence` object (`snippet`,
`excerpt`) or on a `sensitive_locations` entry is precisely how a secret-bearing
line would be quoted into a result that promised to carry only its position.
Everywhere else an unknown field is now fine.

The rubric in `rubric.md` grades what remains: whether the analysis is any good.
This script grades whether it is admissible. A result that fails here is not
scored by a human at all.

`--selftest` runs every sample under `samples/`, including samples that are
*expected to fail*. A grader that accepts everything is worse than no grader,
so the negative samples are what make a green run mean something -- and after
the advisory downgrade they are what proves the grader did not simply stop
checking. Wired into `.commandmate/verify.yaml` and `.github/workflows/validate.yml`
as `repository-analysis-fixtures`; before that it had never run in CI.

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

#: The only keys an `evidence` object may carry. Enforced here rather than left
#: to the schema because this one is the leak barrier: `evidence` deliberately
#: has no field for quoted text (scan-policy.md §4), so any key beyond these
#: three is a place a secret-bearing line could be copied to.
EVIDENCE_KEYS = ("path", "line_start", "line_end")

#: Likewise for a reported secret location: position and classification only,
#: never the value, a fragment of it, a masked form of it or its length
#: (scan-policy.md §3.1).
SENSITIVE_LOCATION_KEYS = ("path", "line", "classification")

#: scan-policy.md §3.2. Closed for the same reason: a free-text classification
#: is somewhere the value itself can be written.
SENSITIVE_CLASSIFICATIONS = (
    "env_file",
    "credential_assignment",
    "private_key_material",
    "cloud_credential",
    "service_token_pattern",
    "unknown_high_entropy",
)


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


# The schema no longer rejects a result, so nothing has type-checked the
# document by the time these run. Every field is read through one of these:
# a malformed result must be *reported*, never a traceback out of the grader.


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def as_int(value: Any) -> int | None:
    """The value as a JSON integer, or None. `True` is not an integer here."""
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def all_evidence(result: dict[str, Any]) -> list[tuple[str, Any]]:
    found: list[tuple[str, Any]] = []
    profile = as_dict(result.get("repository_profile"))
    for key in ("entry_points", "conventions"):
        for index, item in enumerate(as_list(profile.get(key))):
            for position, evidence in enumerate(as_list(as_dict(item).get("evidence"))):
                found.append((f"repository_profile/{key}[{index}]/evidence[{position}]", evidence))
    for key in EVIDENCE_BEARING:
        for index, item in enumerate(as_list(result.get(key))):
            for position, evidence in enumerate(as_list(as_dict(item).get("evidence"))):
                found.append((f"{key}[{index}]/evidence[{position}]", evidence))
    return found


def evidence_paths(result: dict[str, Any]) -> set[str]:
    return {
        evidence["path"]
        for _, evidence in all_evidence(result)
        if isinstance(evidence, dict) and isinstance(evidence.get("path"), str)
    }


def check_case(result: dict[str, Any], case: dict[str, Any], repo: Path | None) -> list[str]:
    errors: list[str] = []
    expect = as_dict(case.get("expect"))
    counts = line_counts(repo)
    scope = as_dict(result.get("scope"))
    files_read = as_int(scope.get("files_read"))

    # -- status and self-declared completion -----------------------------
    allowed_status = expect.get("status", ["success", "partial", "failure"])
    status = result.get("status")
    if status not in allowed_status:
        errors.append(f"status: {status!r} is not one of {allowed_status}")

    # `completion_check` is optional now that the result document itself is.
    # What is *declared* still has to be true, though: a self-report that
    # contradicts itself is worse than no self-report at all.
    if "completion_check" in result:
        completion = as_dict(result.get("completion_check"))
        checks = [as_dict(entry) for entry in as_list(completion.get("checks"))]
        seen = [str(entry.get("id")) for entry in checks]
        if sorted(seen) != sorted(COMPLETION_CHECK_IDS):
            errors.append(
                f"completion_check: ids must be exactly {list(COMPLETION_CHECK_IDS)}, got {seen}"
            )
        all_passed = bool(checks) and all(entry.get("passed") is True for entry in checks)
        if completion.get("passed") is not all_passed:
            errors.append("completion_check: passed does not agree with the individual checks")
        if status == "success" and not all_passed:
            errors.append("status: success requires every completion check to pass")
    if status in ("partial", "failure") and not as_list(result.get("unresolved")):
        errors.append(f"unresolved: status {status} requires at least one entry")
    if status != "failure" and files_read == 0:
        errors.append("scope: files_read is 0 but the status is not failure")

    # -- evidence discipline ----------------------------------------------
    #
    # The blocking layer. `evidence` is a path and a line range and nothing
    # else, the path names a file inside the analysed repository, and the line
    # exists in it. All three survive the advisory downgrade because all three
    # are what the Skill is for.
    for where, evidence in all_evidence(result):
        if not isinstance(evidence, dict):
            errors.append(f"{where}: is not an evidence object")
            continue
        extra = sorted(key for key in evidence if key not in EVIDENCE_KEYS)
        if extra:
            # scan-policy.md §4: evidence carries no quoted text, deliberately.
            errors.append(f"{where}: carries {extra}; evidence is a path and a line range only")
        path = evidence.get("path")
        line_start = as_int(evidence.get("line_start"))
        line_end = as_int(evidence.get("line_end"))
        if not isinstance(path, str) or not path:
            errors.append(f"{where}: has no usable path")
            continue
        if line_start is None or line_start < 1 or line_end is None or line_end < 1:
            errors.append(f"{where}: has no usable 1-based line range")
            continue
        if line_end < line_start:
            errors.append(f"{where}: line_end is before line_start")
        # Checked even when there is no fixture repository to compare against:
        # a result that can name a path outside the analysed tree contradicts
        # the read-only declaration whether or not the path happens to exist.
        if escapes_repository(path):
            errors.append(f"{where}: cites {path!r}, which points outside the repository")
            continue
        if counts is None:
            continue
        if path not in counts:
            errors.append(f"{where}: cites {path!r}, which is not in the fixture repository")
            continue
        if counts[path] is None:
            errors.append(f"{where}: cites a line inside the binary file {path!r}")
        elif counts[path] == 0:
            errors.append(f"{where}: cites a line of {path!r}, which is empty")
        elif line_end > counts[path]:
            errors.append(
                f"{where}: cites line {line_end} of {path!r}, which has {counts[path]} lines"
            )

    cited = evidence_paths(result)
    # `evidence_resolvable` claims every cited file was read during the run, so
    # citing more distinct files than `files_read` is a self-contradiction.
    if files_read is not None and len(cited) > files_read:
        errors.append(
            f"scope: files_read is {files_read} "
            f"but the evidence cites {len(cited)} distinct files"
        )
    for path in expect.get("required_evidence_paths", []):
        if path not in cited:
            errors.append(f"evidence: nothing cites {path!r}, which this case requires")
    for path in expect.get("forbidden_evidence_paths", []):
        if path in cited:
            errors.append(f"evidence: cites {path!r}, which the scan policy excludes")

    # -- sensitive locations ---------------------------------------------
    #
    # The other shape that stays closed. Position and classification are the
    # whole permitted payload; an extra key is a channel for the value itself.
    sensitive = [as_dict(entry) for entry in as_list(result.get("sensitive_locations"))]
    sensitive_paths = {entry.get("path") for entry in sensitive}
    for path in expect.get("required_sensitive_paths", []):
        if path not in sensitive_paths:
            errors.append(f"sensitive_locations: {path!r} was not reported")
    for index, entry in enumerate(sensitive):
        where = f"sensitive_locations[{index}]"
        extra = sorted(key for key in entry if key not in SENSITIVE_LOCATION_KEYS)
        if extra:
            errors.append(f"{where}: carries {extra}; only path, line and classification may be reported")
        classification = entry.get("classification")
        if classification not in SENSITIVE_CLASSIFICATIONS:
            errors.append(f"{where}: {classification!r} is not one of the scan-policy classifications")
        path = entry.get("path")
        line = as_int(entry.get("line"))
        if not isinstance(path, str) or not path or line is None or line < 1:
            errors.append(f"{where}: has no usable path and 1-based line")
            continue
        if escapes_repository(path):
            errors.append(f"{where}: {path!r} points outside the repository")
        elif counts is None:
            continue
        elif path not in counts:
            errors.append(f"{where}: {path!r} is not in the fixture repository")
        elif counts[path] is None:
            errors.append(f"{where}: {path!r} is a binary file")
        elif line > counts[path]:
            errors.append(f"{where}: {path!r} has no line {line}")

    # The whole serialized result is searched, not just the fields where a
    # secret is *supposed* to be absent: a value copied into a statement or a
    # summary is the same leak as one copied into `sensitive_locations`. This is
    # also why an open schema costs nothing here -- an invented field is
    # searched exactly like a declared one.
    # Fragments, not whole values: the policy bans 値の一部 and 先頭数文字 too,
    # so a truncated or partly-masked literal has to fail the same way.
    serialized = json.dumps(result, ensure_ascii=False)
    for needle in expect.get("forbidden_fragments", []):
        if needle in serialized:
            errors.append("result: contains a secret value from the fixture repository")

    # -- verification is grounded ----------------------------------------
    verification = [as_dict(entry) for entry in as_list(result.get("recommended_verification"))]
    commands = [entry.get("command") for entry in verification]
    for needle in expect.get("required_verification_commands", []):
        if not any(isinstance(command, str) and needle in command for command in commands):
            errors.append(f"recommended_verification: no command contains {needle!r}")
    for entry in verification:
        if not as_list(entry.get("evidence")):
            errors.append(f"recommended_verification: {entry.get('id')!r} has no evidence")

    # -- scope bookkeeping ------------------------------------------------
    #
    # Declaring the budget and the truncation is one of the disciplines the
    # advisory downgrade explicitly kept, so these stay blocking.
    declared_rules = {as_dict(entry).get("rule") for entry in as_list(scope.get("excluded"))}
    for rule in expect.get("required_excluded_rules", []):
        if rule not in declared_rules:
            errors.append(f"scope: exclusion rule {rule!r} was not reported")
    if "truncated" in expect and scope.get("truncated") is not expect["truncated"]:
        errors.append(f"scope: truncated should be {expect['truncated']}")
    if "files_read" in expect and files_read != expect["files_read"]:
        errors.append(f"scope: files_read should be {expect['files_read']}")

    # `scope` is the part of the report a reader uses to decide how much of the
    # repository the analysis actually covered, so its numbers are checked
    # against the fixture rather than taken on trust.
    files_listed = as_int(scope.get("files_listed"))
    bytes_read = as_int(scope.get("bytes_read"))
    if files_read is None or files_listed is None or bytes_read is None:
        errors.append("scope: files_listed, files_read and bytes_read must all be integers")
    else:
        if files_read > files_listed:
            errors.append(f"scope: files_read {files_read} exceeds files_listed {files_listed}")
        if files_read > 0 and bytes_read == 0:
            errors.append("scope: files_read is positive but bytes_read is 0")
        total_bytes = repository_bytes(repo)
        if total_bytes is not None and bytes_read > total_bytes:
            errors.append(
                f"scope: bytes_read {bytes_read} exceeds the whole fixture repository ({total_bytes})"
            )

    declared_reasons = {as_dict(entry).get("reason_code") for entry in as_list(result.get("unresolved"))}
    for reason in expect.get("required_reason_codes", []):
        if reason not in declared_reasons:
            errors.append(f"unresolved: reason_code {reason!r} was not reported")

    # -- minimum substance -------------------------------------------------
    for key in ("findings", "reuse_candidates", "risks", "recommended_verification"):
        minimum = expect.get(f"min_{key}")
        present = len(as_list(result.get(key)))
        if minimum is not None and present < minimum:
            errors.append(f"{key}: {present} entries, case requires at least {minimum}")

    # -- human-readable summary -------------------------------------------
    #
    # `summary_markdown` is the deliverable, so its absence is a rejection and
    # not, as it would have been under the strict schema, one violation among
    # fifteen equally weighted required fields.
    summary = result.get("summary_markdown")
    if not isinstance(summary, str) or not summary.strip():
        errors.append("summary_markdown: missing; it is the deliverable, not an optional field")
    else:
        errors.extend(check_summary(summary, expect))

    # -- ids are unique across every item list (result-contract §3.3) ------
    ids: list[Any] = []
    for key in EVIDENCE_BEARING:
        ids.extend(as_dict(entry).get("id") for entry in as_list(result.get(key)))
    ids = [value for value in ids if value is not None]
    duplicates = sorted({str(value) for value in ids if ids.count(value) > 1})
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


def grade(result: dict[str, Any], case_id: str) -> tuple[list[str], list[str]]:
    """Grade one result. Returns (blocking errors, advisory schema notes).

    Both layers always run. The schema layer cannot reject any more -- it is
    advisory, like the schema itself -- so its output is returned separately
    and the case checks are written to survive whatever shape it complained
    about rather than to be skipped because of it.
    """
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    notes = validate_schema(result, schema, schema, "")
    case, repo = load_case(case_id)
    return check_case(result, case, repo), notes


def run_selftest() -> int:
    index = json.loads((SAMPLES_DIR / "index.json").read_text(encoding="utf-8"))
    failures = 0
    for sample in index["samples"]:
        path = SAMPLES_DIR / sample["file"]
        result = json.loads(path.read_text(encoding="utf-8"))
        errors, notes = grade(result, sample["case"])
        admissible = not errors
        expected = sample["expect"] == "admissible"
        suffix = f", {len(notes)} advisory note(s)" if notes else ""
        if admissible == expected:
            detail = "admissible" if admissible else f"rejected ({len(errors)} finding(s))"
            print(f"OK   {sample['file']}: {detail}{suffix}")
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
    rejected = sum(1 for sample in index["samples"] if sample["expect"] == "rejected")
    print(
        f"PASSED: {len(index['samples'])} samples graded as expected "
        f"({rejected} of them rejected, which is what makes this green run mean something)"
    )
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
    errors, notes = grade(result, args.case)
    if errors:
        print(f"REJECTED {args.result} ({len(errors)} finding(s))")
        for error in errors:
            print(f"  {error}")
    else:
        print(f"ADMISSIBLE {args.result} (case {args.case}); score it with rubric.md")
    if notes:
        # Printed after the verdict, and never part of it: the schema is a
        # description of the usual shape, not a gate.
        print(f"advisory: {len(notes)} schema note(s), which do not affect the verdict")
        for note in notes:
            print(f"  {note}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
