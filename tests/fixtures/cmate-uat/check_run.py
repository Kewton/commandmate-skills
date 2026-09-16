#!/usr/bin/env python3
"""Grade a cmate-uat run directory.

    python3 tests/fixtures/cmate-uat/check_run.py --selftest
    python3 tests/fixtures/cmate-uat/check_run.py --run <run-dir>

What it checks is the run's SHAPE, against three sources:

1. the acceptance-result schema that `cmate-acceptance-test` owns (the only copy;
   this package deliberately ships none);
2. the rules SKILL.md states about the report — three named sections, and a
   hand-off section that lists every unresolved outcome with a reason;
3. the rules that keep a run honest: the isolation measurement is recorded, a
   `blocked` isolation result means no test case ran, and `skill.id` is
   `cmate-uat` so the orchestrate runner can place the verdict.

WHY A CHECKER AND NOT JUST A SCHEMA. The schema cannot say "if isolation was
blocked then no test case ran", and that implication is the whole point of the
isolation gate — a run that measured a failure and then tested anyway produces a
schema-valid document asserting a verdict it has no right to. Rules 4 and 5 below
are that implication and its sibling (an unresolved outcome must reach the
hand-off), which is why `--selftest` injects a mutation for each.

Standard library only. No network.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent.parent
SCHEMA_PATH = (
    REPO_ROOT / "skills" / "cmate-acceptance-test" / "schemas" / "acceptance-result.v1.json"
)

#: Outcomes that are neither pass nor fail. Each one that appears in a result
#: document has to be named in the report's hand-off section, with a reason.
UNRESOLVED_OUTCOMES = ("flaky", "blocked", "not_run", "manual_pending", "not_verifiable")

#: The report's three sections, in the order SKILL.md fixes.
REQUIRED_SECTIONS = ("環境", "Issue ごとの結果", "申し送り")


class Failure(Exception):
    """A graded run did not hold."""


# ---------------------------------------------------------------------------
# A minimal JSON Schema subset, enough for acceptance-result.v1: the same shape
# of validator the other fixture suites in this repository use. Bringing in a
# dependency would break the "standard library only" property the CI job relies
# on.
# ---------------------------------------------------------------------------
def validate(schema: dict, doc: object, path: str = "") -> list[str]:
    errors: list[str] = []
    _validate(schema, doc, path or "$", schema, errors)
    return errors


def _resolve(root: dict, ref: str) -> dict:
    node: object = root
    for part in ref.lstrip("#/").split("/"):
        if not part:
            continue
        assert isinstance(node, dict), ref
        node = node[part]
    assert isinstance(node, dict), ref
    return node


def _validate(schema: dict, doc: object, path: str, root: dict, errors: list[str]) -> None:
    if "$ref" in schema:
        _validate(_resolve(root, schema["$ref"]), doc, path, root, errors)
        return
    if "oneOf" in schema:
        for branch in schema["oneOf"]:
            sub: list[str] = []
            _validate(branch, doc, path, root, sub)
            if not sub:
                return
        errors.append(f"{path}: matched none of oneOf")
        return
    if "const" in schema and doc != schema["const"]:
        errors.append(f"{path}: expected const {schema['const']!r}, got {doc!r}")
        return
    if "enum" in schema and doc not in schema["enum"]:
        errors.append(f"{path}: {doc!r} not in enum")
        return

    kind = schema.get("type")
    if kind == "object":
        if not isinstance(doc, dict):
            errors.append(f"{path}: expected object")
            return
        for key in schema.get("required", []):
            if key not in doc:
                errors.append(f'{path}: missing required "{key}"')
        props = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            for key in doc:
                if key not in props:
                    errors.append(f'{path}: unexpected property "{key}"')
        for key, sub_schema in props.items():
            if key in doc:
                _validate(sub_schema, doc[key], f"{path}/{key}", root, errors)
    elif kind == "array":
        if not isinstance(doc, list):
            errors.append(f"{path}: expected array")
            return
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for i, item in enumerate(doc):
                _validate(item_schema, item, f"{path}[{i}]", root, errors)
    elif kind == "string":
        if not isinstance(doc, str):
            errors.append(f"{path}: expected string")
            return
        if "minLength" in schema and len(doc) < schema["minLength"]:
            errors.append(f"{path}: shorter than minLength")
        if "maxLength" in schema and len(doc) > schema["maxLength"]:
            errors.append(f"{path}: longer than maxLength")
        if "pattern" in schema and not re.search(schema["pattern"], doc):
            errors.append(f"{path}: does not match pattern")
    elif kind == "integer":
        if not isinstance(doc, int) or isinstance(doc, bool):
            errors.append(f"{path}: expected integer")
    elif kind == "boolean":
        if not isinstance(doc, bool):
            errors.append(f"{path}: expected boolean")
    elif kind == "null":
        if doc is not None:
            errors.append(f"{path}: expected null")


# ---------------------------------------------------------------------------
# The rules
# ---------------------------------------------------------------------------
def grade(run_dir: Path) -> list[str]:
    """Return the list of reasons this run does not hold. Empty means it holds."""
    problems: list[str] = []

    report = run_dir / "uat-report.md"
    plan = run_dir / "test-plan.md"
    acceptance_dir = run_dir / "acceptance"

    # Rule 1 — the two outputs exist. SKILL.md forbids returning only one.
    if not report.is_file():
        problems.append("uat-report.md is missing")
    if not plan.is_file():
        problems.append("test-plan.md is missing")
    if not acceptance_dir.is_dir():
        problems.append("acceptance/ is missing")
        return problems

    report_text = report.read_text(encoding="utf-8") if report.is_file() else ""

    # Rule 2 — the report has the three named sections, in order.
    positions = []
    for name in REQUIRED_SECTIONS:
        match = re.search(rf"^##+\s*{re.escape(name)}\s*$", report_text, re.M)
        if match is None:
            problems.append(f'uat-report.md has no "{name}" section')
            positions.append(None)
        else:
            positions.append(match.start())
    known = [p for p in positions if p is not None]
    if len(known) == len(REQUIRED_SECTIONS) and known != sorted(known):
        problems.append("uat-report.md sections are out of the fixed order")

    # Rule 3 — the isolation measurement is recorded. A run that cannot show it
    # has not shown that it left production alone, which is the claim the
    # environment section exists to make.
    if "isolation" not in report_text and "隔離" not in report_text:
        problems.append("uat-report.md does not record the isolation measurement")

    docs = sorted(acceptance_dir.glob("issue-*.json"))
    if not docs:
        problems.append("acceptance/ holds no issue-<n>.json")
        return problems

    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    handoff = _handoff_text(report_text)

    for doc_path in docs:
        label = f"acceptance/{doc_path.name}"
        try:
            doc = json.loads(doc_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            problems.append(f"{label} is not valid JSON: {exc}")
            continue

        for error in validate(schema, doc, label):
            problems.append(error)

        if not isinstance(doc, dict):
            continue

        # Rule 4 — this Skill's own id. The orchestrate runner reads skill.id to
        # place the verdict; a document claiming another producer would be
        # attributed to a Skill that never ran.
        skill = doc.get("skill")
        if isinstance(skill, dict) and skill.get("id") != "cmate-uat":
            problems.append(f"{label}: skill.id is {skill.get('id')!r}, expected 'cmate-uat'")

        criteria = doc.get("criteria")
        criteria = criteria if isinstance(criteria, list) else []
        outcomes = [c.get("outcome") for c in criteria if isinstance(c, dict)]

        # Rule 5 — an unresolved outcome must reach the hand-off section, by its
        # criterion id. This is what keeps "could not verify" from vanishing
        # between the document and the page a human reads.
        for crit in criteria:
            if not isinstance(crit, dict):
                continue
            if crit.get("outcome") in UNRESOLVED_OUTCOMES:
                crit_id = str(crit.get("id", ""))
                if crit_id and crit_id not in handoff:
                    problems.append(
                        f"{label}: {crit_id} is {crit['outcome']} but is not in the hand-off section"
                    )

        # Rule 6 — a blocked isolation gate means NO test case ran. A document
        # that reports outcomes after a blocked isolation is asserting a verdict
        # it has no basis for, and it would still be schema-valid.
        if _isolation_blocked(doc):
            resolved = [o for o in outcomes if o in ("pass", "fail", "flaky")]
            if resolved:
                problems.append(
                    f"{label}: isolation was blocked, but {len(resolved)} criterion/criteria "
                    "report an executed outcome"
                )
            if doc.get("verdict") == "go":
                problems.append(f"{label}: isolation was blocked but the verdict is go")

        # Rule 7 — status/verdict cannot be the rounded-up pair when something is
        # unresolved. success+go means "verified everything and it passed".
        if doc.get("status") == "success" and doc.get("verdict") == "go":
            unresolved = [o for o in outcomes if o in UNRESOLVED_OUTCOMES]
            if unresolved:
                problems.append(
                    f"{label}: status success + verdict go, but {len(unresolved)} "
                    f"criterion/criteria are unresolved ({sorted(set(unresolved))})"
                )

    return problems


def _handoff_text(report_text: str) -> str:
    """The hand-off section's body, or the whole report when it has no such section."""
    match = re.search(r"^##+\s*申し送り\s*$", report_text, re.M)
    if match is None:
        return ""
    rest = report_text[match.end() :]
    nxt = re.search(r"^##+\s", rest, re.M)
    return rest[: nxt.start()] if nxt else rest


def _isolation_blocked(doc: dict) -> bool:
    """Whether this document says the isolation gate blocked the run."""
    for reason in doc.get("blocking_reasons", []) or []:
        text = reason if isinstance(reason, str) else json.dumps(reason, ensure_ascii=False)
        if "isolation" in text:
            return True
    return False


# ---------------------------------------------------------------------------
# selftest
# ---------------------------------------------------------------------------
def _mutations(run: Path) -> list[tuple[str, object]]:
    """(description, mutate) pairs. Each must make `grade` report something."""

    def drop_handoff_entry(work: Path) -> None:
        report = work / "uat-report.md"
        text = report.read_text(encoding="utf-8")
        # Remove the line that names the unresolved criterion.
        text = "\n".join(l for l in text.split("\n") if "AC-02" not in l)
        report.write_text(text, encoding="utf-8")

    def drop_handoff_section(work: Path) -> None:
        report = work / "uat-report.md"
        text = report.read_text(encoding="utf-8")
        idx = text.index("## 申し送り")
        report.write_text(text[:idx], encoding="utf-8")

    def drop_isolation_record(work: Path) -> None:
        report = work / "uat-report.md"
        text = report.read_text(encoding="utf-8")
        text = "\n".join(
            l for l in text.split("\n") if "isolation" not in l and "隔離" not in l
        )
        report.write_text(text, encoding="utf-8")

    def wrong_producer(work: Path) -> None:
        for doc_path in (work / "acceptance").glob("issue-*.json"):
            doc = json.loads(doc_path.read_text(encoding="utf-8"))
            doc["skill"]["id"] = "cmate-acceptance-test"
            doc_path.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
            return

    def round_up_to_go(work: Path) -> None:
        for doc_path in sorted((work / "acceptance").glob("issue-*.json")):
            doc = json.loads(doc_path.read_text(encoding="utf-8"))
            if any(
                c.get("outcome") in UNRESOLVED_OUTCOMES
                for c in doc.get("criteria", [])
                if isinstance(c, dict)
            ):
                doc["status"] = "success"
                doc["verdict"] = "go"
                doc_path.write_text(
                    json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8"
                )
                return

    def test_after_blocked_isolation(work: Path) -> None:
        for doc_path in sorted((work / "acceptance").glob("issue-*.json")):
            doc = json.loads(doc_path.read_text(encoding="utf-8"))
            if _isolation_blocked(doc):
                for crit in doc["criteria"]:
                    crit["outcome"] = "pass"
                doc_path.write_text(
                    json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8"
                )
                return

    def break_schema(work: Path) -> None:
        for doc_path in (work / "acceptance").glob("issue-*.json"):
            doc = json.loads(doc_path.read_text(encoding="utf-8"))
            doc["verdict"] = "probably_fine"
            doc_path.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
            return

    def remove_report(work: Path) -> None:
        (work / "uat-report.md").unlink()

    per_run = {
        "partial-manual-pending": [
            ("an unresolved criterion vanishes from the hand-off", drop_handoff_entry),
            ("the hand-off section is removed entirely", drop_handoff_section),
            ("status/verdict rounded up to success+go", round_up_to_go),
            ("the isolation measurement is not recorded", drop_isolation_record),
            ("the producer id is another Skill", wrong_producer),
            ("verdict is not a schema value", break_schema),
            ("the report is missing", remove_report),
        ],
        "blocked-isolation": [
            ("test cases report outcomes after a blocked isolation", test_after_blocked_isolation),
            ("the isolation measurement is not recorded", drop_isolation_record),
        ],
    }
    return per_run[run.name]


def selftest() -> int:
    import shutil
    import tempfile

    runs_dir = HERE / "runs"
    runs = sorted(p for p in runs_dir.iterdir() if p.is_dir())
    if not runs:
        print(f"selftest: no fixture runs under {runs_dir}", file=sys.stderr)
        return 2

    failures = 0
    for run in runs:
        problems = grade(run)
        if problems:
            failures += 1
            print(f"FAIL {run.name} should hold but does not:")
            for problem in problems:
                print(f"       {problem}")
        else:
            print(f"OK   {run.name}")

        for description, mutate in _mutations(run):
            with tempfile.TemporaryDirectory() as tmp:
                work = Path(tmp) / run.name
                shutil.copytree(run, work)
                mutate(work)
                if grade(work):
                    print(f"OK   {run.name}: caught — {description}")
                else:
                    failures += 1
                    print(f"FAIL {run.name}: NOT caught — {description}")

    print()
    if failures:
        print(f"FAILED: {failures} check(s) did not pass")
        return 1
    print(f"PASSED: {len(runs)} run(s) and their mutations")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--selftest", action="store_true", help="grade the fixture runs")
    group.add_argument("--run", type=Path, help="grade one run directory")
    args = parser.parse_args()

    if args.selftest:
        return selftest()

    problems = grade(args.run)
    if problems:
        for problem in problems:
            print(problem)
        return 1
    print(f"OK {args.run}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
