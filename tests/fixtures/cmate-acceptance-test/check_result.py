#!/usr/bin/env python3
"""Grade a cmate-acceptance-test result document.

    python3 tests/fixtures/cmate-acceptance-test/check_result.py
    python3 tests/fixtures/cmate-acceptance-test/check_result.py --case 03-flaky-retry --result run.json

With no arguments it checks every `expected-result.json` under `cases/` — the
golden documents — against three things:

1. the published schema (`skills/cmate-acceptance-test/schemas/acceptance-result.v1.json`);
2. the rubric invariants that the schema cannot express, above all the decision
   table in `references/verdict-rubric.md` and the rule that an unresolved
   criterion is never rounded to `pass`;
3. the per-case expectations recorded in `cases/<id>/case.json`.

With `--case` and `--result` it applies the same three checks to a document an
Agent actually produced, which is what makes the fixture an evaluation rather
than an example. The run is deterministic: no clock, no network, no ordering
dependence, so the same inputs always produce the same verdict.

Standard library only, matching the rest of this repository's tooling.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

FIXTURE_ROOT = Path(__file__).resolve().parent
REPO_ROOT = FIXTURE_ROOT.parents[2]
SCHEMA_PATH = REPO_ROOT / "skills" / "cmate-acceptance-test" / "schemas" / "acceptance-result.v1.json"

UNRESOLVED_OUTCOMES = frozenset({"flaky", "blocked", "not_run", "manual_pending", "not_verifiable"})
RESOLVED_OUTCOMES = frozenset({"pass", "fail"})
EVIDENCE_REQUIRED_OUTCOMES = frozenset({"pass", "fail", "flaky"})


# =============================================================================
# A small JSON Schema subset
# =============================================================================

_TYPE_MAP: dict[str, tuple[type, ...]] = {
    "object": (dict,),
    "array": (list,),
    "string": (str,),
    "integer": (int,),
    "number": (int, float),
    "boolean": (bool,),
    "null": (type(None),),
}


def _type_matches(value: Any, name: str) -> bool:
    expected = _TYPE_MAP.get(name)
    if expected is None:
        return False
    # `True` is an `int` in Python. Letting that slide would accept a boolean
    # everywhere an integer is declared, which is exactly the kind of silent
    # coercion this document format is meant to refuse.
    if name in ("integer", "number") and isinstance(value, bool):
        return False
    if name == "boolean":
        return isinstance(value, bool)
    return isinstance(value, expected)


class SchemaValidator:
    """Validator for the subset of JSON Schema used by the result schema."""

    def __init__(self, schema: dict[str, Any]) -> None:
        self.root = schema

    def validate(self, document: Any) -> list[str]:
        errors: list[str] = []
        self._check(document, self.root, "$", errors)
        return errors

    def _resolve(self, schema: dict[str, Any]) -> dict[str, Any]:
        ref = schema.get("$ref")
        if ref is None:
            return schema
        if not ref.startswith("#/"):
            raise ValueError(f"only local $ref is supported, got {ref!r}")
        node: Any = self.root
        for part in ref[2:].split("/"):
            node = node[part]
        return self._resolve(node)

    def _check(self, value: Any, schema: dict[str, Any], path: str, errors: list[str]) -> None:
        schema = self._resolve(schema)

        if "const" in schema and value != schema["const"]:
            errors.append(f"{path}: expected {schema['const']!r}, got {value!r}")
            return
        if "enum" in schema and value not in schema["enum"]:
            errors.append(f"{path}: {value!r} is not one of {schema['enum']}")
            return

        if "oneOf" in schema:
            matches = [
                branch
                for branch in schema["oneOf"]
                if not self._collect(value, branch, path)
            ]
            if len(matches) != 1:
                errors.append(f"{path}: matched {len(matches)} of the oneOf branches, expected exactly 1")
            return

        declared = schema.get("type")
        if declared is not None:
            names = declared if isinstance(declared, list) else [declared]
            if not any(_type_matches(value, name) for name in names):
                errors.append(f"{path}: expected type {declared}, got {type(value).__name__}")
                return

        if isinstance(value, str):
            pattern = schema.get("pattern")
            if pattern is not None and re.search(pattern, value) is None:
                errors.append(f"{path}: does not match {pattern}")
            if "minLength" in schema and len(value) < schema["minLength"]:
                errors.append(f"{path}: shorter than minLength {schema['minLength']}")
            if "maxLength" in schema and len(value) > schema["maxLength"]:
                errors.append(f"{path}: longer than maxLength {schema['maxLength']} ({len(value)})")

        if isinstance(value, (int, float)) and not isinstance(value, bool):
            if "minimum" in schema and value < schema["minimum"]:
                errors.append(f"{path}: below minimum {schema['minimum']}")
            if "maximum" in schema and value > schema["maximum"]:
                errors.append(f"{path}: above maximum {schema['maximum']}")

        if isinstance(value, dict):
            properties = schema.get("properties", {})
            for name in schema.get("required", []):
                if name not in value:
                    errors.append(f"{path}: required property {name!r} is missing")
            if schema.get("additionalProperties") is False:
                for name in value:
                    if name not in properties:
                        errors.append(f"{path}: unknown property {name!r}")
            for name, child in value.items():
                if name in properties:
                    self._check(child, properties[name], f"{path}.{name}", errors)

        if isinstance(value, list):
            if "minItems" in schema and len(value) < schema["minItems"]:
                errors.append(f"{path}: fewer than minItems {schema['minItems']}")
            item_schema = schema.get("items")
            if item_schema is not None:
                for index, item in enumerate(value):
                    self._check(item, item_schema, f"{path}[{index}]", errors)

    def _collect(self, value: Any, schema: dict[str, Any], path: str) -> list[str]:
        errors: list[str] = []
        self._check(value, schema, path, errors)
        return errors


# =============================================================================
# Rubric invariants
# =============================================================================

#: Credential shapes that must never reach a result document. Same high-signal
#: approach as `scripts/cmate_skills/repo.py`: a scan that cries wolf gets muted.
_SECRET_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("github-token", re.compile(r"gh[pousr]_[A-Za-z0-9]{36,}")),
    ("aws-access-key-id", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("private-key-block", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----")),
    ("slack-token", re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}")),
    ("google-api-key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("openai-key", re.compile(r"\bsk-[A-Za-z0-9]{32,}\b")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")),
)

#: `NAME=value` where the name announces a secret. The value has to be a
#: placeholder; anything else is a credential that was written down.
_SECRET_ASSIGNMENT = re.compile(
    r"\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|CREDENTIAL)S?)\s*[=:]\s*(\S+)"
)
_PLACEHOLDER = re.compile(r"^<(redacted:[a-z-]+|set|unset|omitted)>[,.;]?$")


def _walk_strings(node: Any, path: str = "$"):
    if isinstance(node, str):
        yield path, node
    elif isinstance(node, dict):
        for key, child in node.items():
            yield from _walk_strings(child, f"{path}.{key}")
    elif isinstance(node, list):
        for index, child in enumerate(node):
            yield from _walk_strings(child, f"{path}[{index}]")


def check_redaction(document: dict[str, Any]) -> list[str]:
    out: list[str] = []
    for path, text in _walk_strings(document):
        for label, pattern in _SECRET_PATTERNS:
            if pattern.search(text):
                # The match is never echoed back: printing it would copy the
                # secret from the document into a log.
                out.append(f"{path}: matches the {label} credential shape")
        for match in _SECRET_ASSIGNMENT.finditer(text):
            if _PLACEHOLDER.match(match.group(2)) is None:
                out.append(
                    f"{path}: {match.group(1)} is assigned a value that is not a redaction placeholder"
                )

    for index, entry in enumerate(document.get("evidence", [])):
        if not isinstance(entry, dict):
            continue
        marked = any("<redacted:" in text for _, text in _walk_strings(entry))
        if marked and entry.get("redacted") is not True:
            out.append(
                f"$.evidence[{index}]: contains a redaction marker but redacted is not true"
            )
    return out


def check_rubric(document: dict[str, Any]) -> list[str]:
    """Everything the decision table requires that the schema cannot express."""
    out: list[str] = []
    criteria = document.get("criteria", [])
    checks = document.get("checks", [])
    confirmations = document.get("confirmations", [])
    evidence = document.get("evidence", [])
    next_actions = document.get("next_actions", [])
    status = document.get("status")
    verdict = document.get("verdict")

    # -- identity ------------------------------------------------------------
    for label, items in (("criteria", criteria), ("checks", checks), ("evidence", evidence)):
        ids = [item.get("id") for item in items if isinstance(item, dict)]
        if len(ids) != len(set(ids)):
            out.append(f"$.{label}: duplicate id")

    criterion_ids = {item["id"] for item in criteria if isinstance(item, dict) and "id" in item}
    evidence_ids = {item["id"] for item in evidence if isinstance(item, dict) and "id" in item}
    check_ids = {item["id"] for item in checks if isinstance(item, dict) and "id" in item}

    # -- references ----------------------------------------------------------
    for index, criterion in enumerate(criteria):
        for ref in criterion.get("evidence_ids", []):
            if ref not in evidence_ids:
                out.append(f"$.criteria[{index}]: references unknown evidence {ref}")
    for index, check in enumerate(checks):
        for ref in check.get("criterion_ids", []):
            if ref not in criterion_ids:
                out.append(f"$.checks[{index}]: references unknown criterion {ref}")
        for ref in check.get("evidence_ids", []):
            if ref not in evidence_ids:
                out.append(f"$.checks[{index}]: references unknown evidence {ref}")
    for index, action in enumerate(next_actions):
        for ref in action.get("criterion_ids", []):
            if ref not in criterion_ids:
                out.append(f"$.next_actions[{index}]: references unknown criterion {ref}")
    for index, confirmation in enumerate(confirmations):
        if confirmation.get("check_id") not in check_ids:
            out.append(f"$.confirmations[{index}]: references unknown check")

    # -- evidence backing ----------------------------------------------------
    for index, criterion in enumerate(criteria):
        outcome = criterion.get("outcome")
        if outcome in EVIDENCE_REQUIRED_OUTCOMES and not criterion.get("evidence_ids"):
            out.append(
                f"$.criteria[{index}]: outcome {outcome!r} needs at least one evidence entry"
            )

    # -- flaky is never the successful attempt -------------------------------
    by_id = {item["id"]: item for item in evidence if isinstance(item, dict) and "id" in item}
    for index, criterion in enumerate(criteria):
        if criterion.get("outcome") != "flaky":
            continue
        attempts = [
            attempt
            for ref in criterion.get("evidence_ids", [])
            for attempt in by_id.get(ref, {}).get("attempts", [])
        ]
        codes = {attempt.get("exit_code") for attempt in attempts}
        if len(attempts) < 2 or len(codes) < 2:
            out.append(
                f"$.criteria[{index}]: flaky needs evidence of at least two attempts with differing results"
            )

    # -- skipped tests are not passed ----------------------------------------
    for index, entry in enumerate(evidence):
        if entry.get("type") != "test":
            continue
        total = entry.get("total")
        parts = (entry.get("passed"), entry.get("failed"), entry.get("skipped"))
        if all(isinstance(part, int) for part in parts) and isinstance(total, int):
            if sum(parts) != total:
                out.append(f"$.evidence[{index}]: passed + failed + skipped does not equal total")
        failed_tests = entry.get("failed_tests")
        if isinstance(failed_tests, list) and isinstance(entry.get("failed"), int):
            if entry["failed"] > 0 and not failed_tests:
                out.append(f"$.evidence[{index}]: a failing test run must name the failing tests")

    # -- checks --------------------------------------------------------------
    confirmed = {item.get("check_id"): item for item in confirmations}
    for index, check in enumerate(checks):
        if check.get("executed") is False:
            reason = check.get("skip_reason")
            if not isinstance(reason, str) or not reason.strip():
                out.append(f"$.checks[{index}]: a check that did not run needs a skip_reason")
        if check.get("risk_tier") != "confirm_required":
            continue
        confirmation = confirmed.get(check.get("id"))
        if confirmation is None:
            out.append(f"$.checks[{index}]: confirm_required check has no confirmation record")
            continue
        if not str(confirmation.get("cleanup_plan", "")).strip():
            out.append(f"$.checks[{index}]: confirm_required check has no cleanup plan")
        if check.get("executed") and confirmation.get("granted") is not True:
            out.append(
                f"$.checks[{index}]: confirm_required check was executed without an explicit approval"
            )

    if document.get("environment", {}).get("invocation") == "non_interactive":
        for index, check in enumerate(checks):
            if check.get("risk_tier") == "confirm_required" and check.get("executed"):
                out.append(
                    f"$.checks[{index}]: confirm_required check ran in a non-interactive invocation"
                )

    # -- decision table ------------------------------------------------------
    outcomes = [criterion.get("outcome") for criterion in criteria]
    unresolved = [
        criterion for criterion in criteria if criterion.get("outcome") in UNRESOLVED_OUTCOMES
    ]
    has_fail = any(outcome == "fail" for outcome in outcomes)

    if status == "success":
        if not criteria:
            out.append("$.status: success with no criteria is not a verified run")
        if any(outcome not in RESOLVED_OUTCOMES for outcome in outcomes):
            out.append("$.status: success requires every criterion to be pass or fail")
    elif status == "partial":
        if not unresolved:
            out.append("$.status: partial requires at least one unresolved criterion")
    elif status == "failure":
        if not document.get("blocking_reasons"):
            out.append("$.status: failure requires a non-empty blocking_reasons")

    if status == "failure":
        expected_verdict = "no_go"
    elif has_fail:
        expected_verdict = "no_go"
    elif status == "success":
        expected_verdict = "go"
    else:
        covered = {
            ref
            for action in next_actions
            for ref in action.get("criterion_ids", [])
            if str(action.get("owner", "")).strip()
        }
        every_unresolved_has_action = all(
            criterion.get("id") in covered for criterion in unresolved
        )
        expected_verdict = "conditional_go" if every_unresolved_has_action else "no_go"

    if verdict != expected_verdict:
        out.append(
            f"$.verdict: decision table gives {expected_verdict!r} for this outcome set, document says {verdict!r}"
        )

    if verdict == "conditional_go" and not next_actions:
        out.append("$.verdict: conditional_go requires at least one next action")
    if verdict == "no_go" and not document.get("blocking_reasons"):
        out.append("$.verdict: no_go requires a non-empty blocking_reasons")
    if verdict == "go" and unresolved:
        out.append("$.verdict: go with an unresolved criterion rounds an unverified item to pass")

    return out


def check_expectations(document: dict[str, Any], expect: dict[str, Any]) -> list[str]:
    out: list[str] = []
    if document.get("status") != expect["status"]:
        out.append(f"$.status: expected {expect['status']!r}, got {document.get('status')!r}")
    if document.get("verdict") != expect["verdict"]:
        out.append(f"$.verdict: expected {expect['verdict']!r}, got {document.get('verdict')!r}")

    actual = {
        criterion.get("id"): criterion.get("outcome")
        for criterion in document.get("criteria", [])
    }
    for criterion_id, outcome in expect.get("criteria_outcomes", {}).items():
        if actual.get(criterion_id) != outcome:
            out.append(
                f"$.criteria: expected {criterion_id} to be {outcome!r}, got {actual.get(criterion_id)!r}"
            )
    extra = set(actual) - set(expect.get("criteria_outcomes", {}))
    if extra:
        out.append(f"$.criteria: unexpected criteria {sorted(extra)}")

    if len(document.get("next_actions", [])) < expect.get("min_next_actions", 0):
        out.append(
            f"$.next_actions: expected at least {expect['min_next_actions']}, "
            f"got {len(document.get('next_actions', []))}"
        )

    serialized = json.dumps(document, ensure_ascii=False)
    for forbidden in expect.get("forbidden_strings", []):
        if forbidden in serialized:
            out.append(f"$: the document contains a string it must not carry ({forbidden[:24]}…)")
    return out


# =============================================================================
# Entry point
# =============================================================================


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def check_one(validator: SchemaValidator, case_dir: Path, result_path: Path) -> list[str]:
    case = load_json(case_dir / "case.json")
    document = load_json(result_path)
    errors = validator.validate(document)
    if errors:
        return errors
    return check_rubric(document) + check_redaction(document) + check_expectations(document, case["expect"])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", help="case id under cases/ to grade a real run against")
    parser.add_argument("--result", help="path to the result document produced by an Agent")
    args = parser.parse_args()

    if bool(args.case) != bool(args.result):
        print("error: --case and --result are used together", file=sys.stderr)
        return 2

    validator = SchemaValidator(load_json(SCHEMA_PATH))
    cases_root = FIXTURE_ROOT / "cases"

    if args.case:
        case_dir = cases_root / args.case
        if not case_dir.is_dir():
            print(f"error: no case at {case_dir}", file=sys.stderr)
            return 2
        targets = [(case_dir, Path(args.result))]
    else:
        targets = [(directory, directory / "expected-result.json") for directory in sorted(cases_root.iterdir()) if directory.is_dir()]

    if not targets:
        print("error: no cases found", file=sys.stderr)
        return 2

    failures = 0
    for case_dir, result_path in targets:
        errors = check_one(validator, case_dir, result_path)
        if errors:
            failures += 1
            print(f"FAIL {case_dir.name}")
            for error in errors:
                print(f"  {error}")
        else:
            print(f"OK   {case_dir.name}")

    print()
    if failures:
        print(f"FAILED: {failures} case(s) did not pass")
        return 1
    print(f"PASSED: {len(targets)} case(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
