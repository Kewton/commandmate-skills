"""Line-oriented parsing of access logs."""

from __future__ import annotations

import re
from dataclasses import dataclass

_LINE = re.compile(
    r"^(?P<host>\S+) \S+ \S+ \[(?P<when>[^\]]+)\] "
    r'"(?P<method>[A-Z]+) (?P<path>\S+)[^"]*" (?P<status>\d{3}) (?P<size>\d+|-)$'
)


@dataclass(frozen=True)
class Record:
    host: str
    when: str
    method: str
    path: str
    status: int
    size: int


def parse_line(line: str) -> Record | None:
    """Parse one access-log line, or return None when it does not match."""
    match = _LINE.match(line.rstrip("\n"))
    if match is None:
        return None
    size = match.group("size")
    return Record(
        host=match.group("host"),
        when=match.group("when"),
        method=match.group("method"),
        path=match.group("path"),
        status=int(match.group("status")),
        size=0 if size == "-" else int(size),
    )
