#!/usr/bin/env python3
"""Check a document written by skills/cmate-acceptance-test/scripts/run-acceptance.mjs.

    python3 check_runner_result.py <result.json> [--status S] [--verdict V] [--outcome AC-01=pass ...]

Applies the same three gates `check_result.py` applies to the golden cases —
the published acceptance-result.v1 schema, the verdict-rubric invariants the
schema cannot express, and the redaction rules — and then the expectations
given on the command line. Exit 0 when everything holds, 1 otherwise.

It imports `check_result` rather than carrying a second schema validator: two
validators for one schema drift, and the runner must satisfy the one the
golden cases are graded by.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_result  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("result")
    parser.add_argument("--status")
    parser.add_argument("--verdict")
    parser.add_argument("--outcome", action="append", default=[], help="AC-NN=<outcome>")
    args = parser.parse_args()

    document = check_result.load_json(Path(args.result))
    validator = check_result.SchemaValidator(check_result.load_json(check_result.SCHEMA_PATH))
    errors = validator.validate(document)
    if not errors:
        errors = check_result.check_rubric(document) + check_result.check_redaction(document)

    if args.status and document.get("status") != args.status:
        errors.append(f"$.status: expected {args.status!r}, got {document.get('status')!r}")
    if args.verdict and document.get("verdict") != args.verdict:
        errors.append(f"$.verdict: expected {args.verdict!r}, got {document.get('verdict')!r}")
    outcomes = {c.get("id"): c.get("outcome") for c in document.get("criteria", [])}
    for spec in args.outcome:
        criterion_id, _, want = spec.partition("=")
        if outcomes.get(criterion_id) != want:
            errors.append(f"$.criteria: expected {criterion_id} {want!r}, got {outcomes.get(criterion_id)!r}")

    for error in errors:
        print(error)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
