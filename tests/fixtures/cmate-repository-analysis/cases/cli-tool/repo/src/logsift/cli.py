"""Command line entry point."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .parser import parse_line


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="logsift")
    parser.add_argument("path", type=Path)
    parser.add_argument("--format", choices=("json", "tsv"), default="tsv")
    args = parser.parse_args(argv)

    skipped = 0
    for line in args.path.read_text(encoding="utf-8").splitlines():
        record = parse_line(line)
        if record is None:
            skipped += 1
            continue
        if args.format == "json":
            print(json.dumps(record.__dict__, ensure_ascii=False))
        else:
            print(f"{record.host}\t{record.method}\t{record.path}\t{record.status}")

    if skipped:
        print(f"skipped {skipped} unparsable line(s)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
