#!/usr/bin/env python3
"""Hold a cmate-workspace-research run-dir, and the package that describes it, to the Skill's rules.

    python3 tests/fixtures/cmate-workspace-research/check_run.py <run-dir> [--workspace <dir>]
    python3 tests/fixtures/cmate-workspace-research/check_run.py --package
    python3 tests/fixtures/cmate-workspace-research/check_run.py --selftest

A run-dir is what the parent session leaves under
`.commandmate/workspace-research/<run-id>/` (references/artifacts.md). Every rule
below has an id, and every id is tied to an acceptance criterion of Issue #245:

  RUN-*    run.json: shape, the parent never listed as a child (F), each child's
           status agreeing with the exit code `ask` actually returned (AC-16),
           roles assigned after the capability probe (AC-05 / B)
  REPLY-*  the children's replies: history-shaped JSON (AC-03), the WEB line and
           the DONE line, the eight report headings (AC-06), and no mention of
           the other children in the independent phase (AC-04)
  SENT-* / ROLE-CONTRACT
           the short message carries the five fields and forbids reading
           agents/ and writing anything, while the research contract lives in
           roles/<key>.md and nowhere else (D)
  CMD-*    commands.log: no respond / auto-yes / interrupt (AC-18), research
           asks at --timeout 3600 --json and never --async (E), and one ask for
           every reply on disk
  XC-* / EV-*
           cross-check.md and evidence.md (AC-09 / AC-10 / AC-12)
  FINAL-*  final.md: the section 33 headings (AC-14), a non-empty What Changed
           Through Cross Check (I), locators by the regexes in
           references/evidence-rules.md section 4.3 (AC-07 / AC-08), the
           before/after git status comparison (AC-15), the coverage line for a
           child that did not finish (AC-16) and UNRESOLVED CONTRADICTION
           (AC-17)

The locator regexes are read from references/evidence-rules.md itself, so the
rule an Agent is told to follow and the rule this script enforces cannot drift.

`--selftest` runs the package checks, both fixture runs, one injected mutation
per rule (a checker nobody ever saw reject anything proves nothing), the
exit 124 / 21 / 2 variants of the stopped child, and finally asserts that every
rule id is exercised by at least one mutation.

Standard library only, like everything else in this repository.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
SKILL_DIR = REPO_ROOT / "skills" / "cmate-workspace-research"
FIXTURE = HERE / "two-agent-contradiction"
RUNS = FIXTURE / "runs"
FIXTURE_WORKSPACE = FIXTURE / "repo"

STATES = ("VERIFIED", "PARTIAL", "CITED_NOT_VERIFIED", "UNVERIFIED", "REJECTED")
IMPORTANCE = ("HIGH", "MEDIUM", "LOW")
AGENT_STATUSES = ("completed", "prompt_stopped", "timeout", "failed")
RUN_STATUSES = ("COMPLETED", "PARTIAL", "FAILED")
SOURCES = ("history", "pane", "file", None)
WEB_CAP = ("available", "unavailable", "unknown")
WS_CAP = ("readable", "unreadable", "unknown")
WARMUP_STATES = ("not_needed", "ready", "failed")

BRIEF_HEADINGS = (
    "Original Request", "Research Goal", "Workspace Scope", "Web Questions",
    "Workspace Questions", "Key Uncertainties", "Expected Output",
)
REPORT_HEADINGS = (
    "Conclusion", "Web Findings", "Workspace Findings", "Web ↔ Workspace Connections",
    "Assumptions", "Risks / Counterevidence", "Unknowns", "Recommended Next Checks",
)
REPORT_HEADING_LINES = frozenset("# " + h for h in REPORT_HEADINGS)
CROSS_CHECK_HEADINGS = (
    "Important Agreements", "Important Contradictions", "Shared Assumptions",
    "Challenges Sent", "Verification Performed", "Corrections", "Remaining Disagreements",
)
FINAL_HEADINGS = (
    "Research Question", "Conclusion", "What This Means for This Workspace", "Key Findings",
    "What Changed Through Cross Check", "Risks / Counterevidence", "Unknowns",
    "Recommended Next Actions", "Sources", "Research Metadata",
)
METADATA_KEYS = ("Agents", "Workspace", "AS_OF", "Depth", "Coverage", "Workspace integrity", "Run")

SEND_LABELS = {
    "ja": ("■ 目的", "■ 対象", "■ 出力の形", "■ 触ってはいけないもの", "■ 締め方"),
    "en": ("# Purpose", "# Target", "# Expected output", "# Do not touch", "# How to close"),
}
CONTRACT_MARKERS = ("MODE: WORKSPACE_RESEARCH", "Evidence Status", "Web ↔ Workspace Connections")
WARMUP_TEXT = "Stand by. A research request will arrive shortly. Reply with READY."
NONE_ITEMS = ("修正なし", "なし", "none")

FORBIDDEN_CMD = re.compile(r"\bcommandmate\s+(respond|auto-yes|interrupt)\b|--auto-yes\b")
ASK_NAME = re.compile(r"@sent/(\S+)\.txt(?=\s|$)")
WS_PARTS = re.compile(
    r"^(\[[^\]]+\] )?([^\s:\[\]]+)(?::([0-9]+)(?:-([0-9]+))?|::([A-Za-z_$][A-Za-z0-9_$.#-]*))"
)

RULES = (
    "RUN-SHAPE", "RUN-SELF", "RUN-EXIT", "RUN-STATUS", "RUN-ROLE", "RUN-CAPABILITY",
    "REPLY-SHAPE", "REPLY-HEADINGS", "REPLY-INDEPENDENT", "PROMPT-SHAPE",
    "SENT-BRIEF", "SENT-PROBE", "SENT-WARMUP", "ROLE-CONTRACT",
    "CMD-FORBIDDEN", "CMD-ASK", "CMD-TRACE", "BRIEF",
    "XC-HEADINGS", "XC-SHARED", "XC-CORRECTIONS", "EV-SHAPE", "EV-DUP",
    "FINAL-HEADINGS", "FINAL-CHANGED", "FINAL-FINDING", "FINAL-LOCATOR-WS", "FINAL-LOCATOR-WEB",
    "FINAL-UNVERIFIED-WORDING", "FINAL-METADATA", "FINAL-INTEGRITY", "FINAL-COVERAGE",
    "FINAL-UNRESOLVED", "INTEGRITY",
)

Problems = list[tuple[str, str]]


# =============================================================================
# Text helpers
# =============================================================================


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def between(text: str, marker: str) -> str | None:
    """The block between `<!-- BEGIN marker -->` and `<!-- END marker -->`, fences stripped."""
    begin, end = f"<!-- BEGIN {marker} -->", f"<!-- END {marker} -->"
    start, stop = text.find(begin), text.find(end)
    if start < 0 or stop < start:
        return None
    lines = text[start + len(begin):stop].strip("\n").splitlines()
    if lines and lines[0].startswith("```"):
        lines = lines[1:]
    if lines and lines[-1].startswith("```"):
        lines = lines[:-1]
    return "\n".join(lines)


def h1_sections(md: str) -> list[tuple[str, str]]:
    """Top-level `# ` sections, ignoring anything inside fenced code."""
    out: list[tuple[str, str]] = []
    title: str | None = None
    buf: list[str] = []
    fence = False
    for line in md.splitlines():
        if line.lstrip().startswith("```"):
            fence = not fence
        if not fence and line.startswith("# "):
            if title is not None:
                out.append((title, "\n".join(buf)))
            title, buf = line[2:].strip(), []
        elif title is not None:
            buf.append(line)
    if title is not None:
        out.append((title, "\n".join(buf)))
    return out


def section(md: str, title: str) -> str | None:
    for name, body in h1_sections(md):
        if name == title:
            return body
    return None


def heading_problem(titles: list[str], required: tuple[str, ...]) -> str | None:
    missing = [h for h in required if h not in titles]
    if missing:
        return "missing heading: " + ", ".join(f"# {h}" for h in missing)
    positions = [titles.index(h) for h in required]
    if positions != sorted(positions):
        return "headings out of order; expected: " + " / ".join(required)
    return None


def items(body: str) -> list[str]:
    """Non-empty lines with a leading list marker stripped."""
    out = []
    for line in body.splitlines():
        text = line.strip()
        if text:
            out.append(re.sub(r"^(?:[-*]|\d+\.)\s+", "", text))
    return out


def is_none(body: str) -> bool:
    found = items(body)
    return len(found) == 1 and found[0] in NONE_ITEMS


def subsections(body: str, marker: str) -> list[tuple[str, str]]:
    """Split on lines starting with `marker` (`## ` or `### `)."""
    parts = re.split(rf"(?m)^{re.escape(marker)}", body)
    out = []
    for part in parts[1:]:
        title, _, rest = part.partition("\n")
        out.append((title.strip(), rest))
    return out


def code_blocks(md: str) -> list[str]:
    blocks, buf, inside = [], [], False
    for line in md.splitlines():
        if line.lstrip().startswith("```"):
            if inside:
                blocks.append("\n".join(buf))
                buf = []
            inside = not inside
            continue
        if inside:
            buf.append(line)
    return blocks


def mentions(text: str, name: str) -> bool:
    pattern = rf"(?<![A-Za-z0-9-]){re.escape(name.lower())}(?![A-Za-z0-9-])"
    return re.search(pattern, text.lower()) is not None


def load_locator_rules(skill_dir: Path = SKILL_DIR) -> dict[str, re.Pattern[str]]:
    block = between(read(skill_dir / "references" / "evidence-rules.md"), "LOCATOR RULES")
    if block is None:
        raise SystemExit("evidence-rules.md: the LOCATOR RULES block is missing")
    rules: dict[str, re.Pattern[str]] = {}
    for line in block.splitlines():
        if " = " in line:
            name, pattern = line.split(" = ", 1)
            rules[name.strip()] = re.compile(pattern.strip())
    missing = {"WORKSPACE_LOCATOR", "WEB_LOCATOR", "NONE_LOCATOR"} - rules.keys()
    if missing:
        raise SystemExit(f"evidence-rules.md: LOCATOR RULES lacks {sorted(missing)}")
    return rules


def resolve_workspace_locator(line: str, root: Path | None) -> str | None:
    """None when the locator points at something that exists; else why not."""
    match = WS_PARTS.match(line)
    if match is None:
        return "not a locator"
    prefix, path, start, end, symbol = match.groups()
    if prefix or root is None:
        return None  # another worktree: nothing here to resolve against
    target = root / path
    try:
        target.resolve().relative_to(root.resolve())
    except ValueError:
        return f"{path} escapes the workspace"
    if not target.is_file():
        return f"{path} does not exist in the workspace"
    text = read(target)
    if symbol is not None:
        leaf = re.split(r"[.#]", symbol)[-1]
        return None if leaf in text else f"{path}::{symbol} names nothing in the file"
    count = len(text.splitlines())
    first, last = int(start), int(end) if end else int(start)
    if first < 1 or last < first or last > count:
        return f"{path}:{start}{'-' + end if end else ''} is outside lines 1..{count}"
    return None


def locator_key(line: str) -> str:
    return re.split(r" (?:—|-) ", line, maxsplit=1)[0].strip()


# =============================================================================
# Message and role checks (shared by the package templates and the fixtures)
# =============================================================================


def forbids_reading_agents(text: str) -> bool:
    return any("agents/" in l and ("読まない" in l or "Do not read" in l) for l in text.splitlines())


def forbids_writing(text: str) -> bool:
    return "1 byte も書かない" in text or "Do not write a single byte" in text


def five_fields_problem(text: str) -> str | None:
    missing = {lang: [l for l in labels if l not in text] for lang, labels in SEND_LABELS.items()}
    if any(not m for m in missing.values()):
        return None
    return "the five fields are incomplete (missing: " + ", ".join(min(missing.values(), key=len)) + ")"


def check_send_text(text: str, key: str, kind: str, n: str = "<n>") -> list[str]:
    """A research or challenge message: short, five fields, reads files, writes nothing."""
    out = []
    problem = five_fields_problem(text)
    if problem:
        out.append(problem)
    if "DONE:" not in text:
        out.append("no DONE: closing line")
    if not forbids_reading_agents(text):
        out.append("does not forbid reading agents/")
    if not forbids_writing(text):
        out.append("does not forbid writing to the workspace")
    for marker in CONTRACT_MARKERS:
        if marker in text:
            out.append(f"carries the research contract ({marker}); it belongs in roles/<key>.md")
    if kind == "research":
        for needle in ("brief.md", f"roles/{key}.md", "WEB: available", "WEB: unavailable"):
            if needle not in text:
                out.append(f"does not mention {needle}")
    else:
        needle = f"challenges/{key}.challenge-{n}.md"
        if needle not in text:
            out.append(f"does not point at {needle}")
    return out


def check_probe_text(text: str) -> list[str]:
    out = []
    problem = five_fields_problem(text)
    if problem:
        out.append(problem)
    for needle in ("brief.md", "WEB: available", "WEB: unavailable", "WORKSPACE: readable",
                   "WORKSPACE: unreadable", "DONE: probe"):
        if needle not in text:
            out.append(f"does not ask for {needle}")
    if not forbids_writing(text):
        out.append("does not forbid writing to the workspace")
    for marker in CONTRACT_MARKERS:
        if marker in text:
            out.append(f"carries the research contract ({marker})")
    return out


def check_role_text(text: str) -> list[str]:
    out = []
    for needle in (
        "MODE: WORKSPACE_RESEARCH",
        "Source Type: WEB | WORKSPACE | DERIVED",
        "Evidence Status: VERIFIED | PARTIAL | CITED_NOT_VERIFIED | UNVERIFIED",
        "Do not write a single byte",
        "Do not assume general Web information automatically applies to this workspace",
        "path:line",
        "as-of",
        "DONE:",
    ):
        if needle not in text:
            out.append(f"missing: {needle}")
    lines = {l.strip() for l in text.splitlines()}
    for heading in REPORT_HEADINGS:
        if f"# {heading}" not in lines:
            out.append(f"missing report heading: # {heading}")
    if not forbids_reading_agents(text):
        out.append("does not forbid reading agents/")
    return out


# =============================================================================
# The run checker
# =============================================================================


def check_run(run_dir: Path, workspace: Path | None, rules: dict[str, re.Pattern[str]]) -> Problems:
    found: Problems = []

    def bad(rule: str, message: str) -> None:
        found.append((rule, message))

    try:
        run = json.loads(read(run_dir / "run.json"))
    except (OSError, ValueError) as error:
        return [("RUN-SHAPE", f"run.json does not parse: {error}")]

    # ---- RUN-SHAPE ---------------------------------------------------------
    for key in ("run_id", "request", "mode", "depth", "depth_requested", "status", "as_of", "self",
                "preflight", "agents", "coverage", "workspace_integrity"):
        if key not in run:
            bad("RUN-SHAPE", f"run.json has no {key}")
    if found:
        return found
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*-\d{8}-\d{3}", str(run["run_id"])):
        bad("RUN-SHAPE", f"run_id {run['run_id']!r} is not <slug>-<YYYYMMDD>-<nnn>")
    if run["mode"] != "WORKSPACE_RESEARCH":
        bad("RUN-SHAPE", f"mode is {run['mode']!r}")
    if run["depth"] != "standard" or run["depth_requested"] not in ("quick", "standard", "deep"):
        bad("RUN-SHAPE", "depth must run as standard and record quick / standard / deep as requested")
    if run["status"] not in RUN_STATUSES:
        bad("RUN-SHAPE", f"status {run['status']!r}")
    if run["preflight"].get("permission_mode") not in ("prepared", "files_only"):
        bad("RUN-SHAPE", "preflight.permission_mode is neither prepared nor files_only")
    if run["preflight"].get("gitignore") not in ("ignored", "not_ignored"):
        bad("RUN-SHAPE", "preflight.gitignore is neither ignored nor not_ignored")
    agents: list[dict[str, Any]] = run["agents"] if isinstance(run["agents"], list) else []
    if not agents:
        bad("RUN-SHAPE", "agents is empty")
    for agent in agents:
        who = agent.get("key", "?")
        for key in ("key", "worktreeId", "instanceId", "alias", "cliTool", "running", "autoYes",
                    "warmup", "capability", "role", "source", "exit_code", "status", "reason"):
            if key not in agent:
                bad("RUN-SHAPE", f"agents[{who}] has no {key}")
        cap = agent.get("capability") or {}
        if cap.get("web") not in WEB_CAP or cap.get("workspace") not in WS_CAP:
            bad("RUN-SHAPE", f"agents[{who}].capability is {cap}")
        if agent.get("status") not in AGENT_STATUSES:
            bad("RUN-SHAPE", f"agents[{who}].status is {agent.get('status')!r}")
        if agent.get("source") not in SOURCES:
            bad("RUN-SHAPE", f"agents[{who}].source is {agent.get('source')!r}")
        if agent.get("warmup") not in WARMUP_STATES:
            bad("RUN-SHAPE", f"agents[{who}].warmup is {agent.get('warmup')!r}")
        if agent.get("status") != "completed" and not agent.get("reason"):
            bad("RUN-SHAPE", f"agents[{who}] did not complete and records no reason")
    if any(r == "RUN-SHAPE" for r, _ in found):
        return found

    keys = [a["key"] for a in agents]
    by_key = {a["key"]: a for a in agents}

    # ---- RUN-SELF ----------------------------------------------------------
    me = (run["self"].get("worktreeId"), run["self"].get("instanceId"))
    for agent in agents:
        if (agent["worktreeId"], agent["instanceId"]) == me:
            bad("RUN-SELF", f"the parent session {me} is listed as a child ({agent['key']})")
    pairs = [(a["worktreeId"], a["instanceId"]) for a in agents]
    if len(set(pairs)) != len(pairs) or len(set(keys)) != len(keys):
        bad("RUN-SELF", "the same instance is listed twice")

    # ---- files on disk -----------------------------------------------------
    sent_dir, agents_dir = run_dir / "sent", run_dir / "agents"
    sent_names = {p.name[:-4] for p in sent_dir.glob("*.txt")} if sent_dir.is_dir() else set()
    exit_names = {p.name[:-5] for p in agents_dir.glob("*.exit")} if agents_dir.is_dir() else set()

    def exit_of(name: str) -> int | None:
        path = agents_dir / f"{name}.exit"
        if not path.is_file():
            return None
        try:
            return int(read(path).strip())
        except ValueError:
            return -1

    def json_of(name: str) -> Any:
        path = agents_dir / f"{name}.json"
        try:
            return json.loads(read(path))
        except (OSError, ValueError):
            return None

    def reply_of(name: str) -> str | None:
        data = json_of(name)
        if isinstance(data, dict) and data.get("source") in ("history", "pane"):
            reply = data.get("reply")
            if isinstance(reply, str) and reply.strip():
                return reply
        return None

    def log_of(name: str) -> str:
        path = agents_dir / f"{name}.log"
        return read(path) if path.is_file() else ""

    # ---- RUN-EXIT ----------------------------------------------------------
    for agent in agents:
        key = agent["key"]
        research_exit = exit_of(key)
        if agent["exit_code"] != research_exit:
            bad("RUN-EXIT", f"{key}: run.json exit_code {agent['exit_code']} but agents/{key}.exit says {research_exit}")
        code = research_exit
        if code is None:
            for phase in (f"{key}.probe", f"{key}.warmup"):
                if exit_of(phase) is not None:
                    code = exit_of(phase)
                    break
        if code is None:
            expected = "failed"
        elif code == 0:
            readable = reply_of(key) is not None if research_exit is not None else False
            if agent["source"] == "file":
                readable = readable and (agents_dir / f"{key}.md").is_file()
            expected = "completed" if readable else "failed"
        elif code == 10 or (code == 2 and "waiting on a prompt" in log_of(key if research_exit is not None else f"{key}.probe")):
            expected = "prompt_stopped"
        elif code == 124:
            expected = "timeout"
        else:
            expected = "failed"
        if agent["status"] != expected:
            bad("RUN-EXIT", f"{key}: exit {code} means {expected}, run.json says {agent['status']}")
        if agent["status"] == "completed" and agent["source"] not in ("history", "pane", "file"):
            bad("RUN-EXIT", f"{key}: completed without a source")

    # ---- RUN-STATUS --------------------------------------------------------
    completed = [a for a in agents if a["status"] == "completed"]
    reduced = sorted(a["key"] for a in agents if a["status"] != "completed")
    coverage = run["coverage"]
    if not completed and run["status"] != "FAILED":
        bad("RUN-STATUS", "no child completed, so the run is FAILED")
    if run["status"] == "COMPLETED" and (reduced or coverage.get("web") != "full" or coverage.get("workspace") != "full"):
        bad("RUN-STATUS", "COMPLETED although coverage was reduced")
    if run["status"] != "COMPLETED" and completed and not reduced and coverage.get("web") == "full" \
            and coverage.get("workspace") == "full":
        bad("RUN-STATUS", f"{run['status']} although every child completed with full coverage")
    if sorted(coverage.get("reduced_by", [])) != reduced:
        bad("RUN-STATUS", f"coverage.reduced_by is {coverage.get('reduced_by')}, expected {reduced}")

    # ---- RUN-ROLE ----------------------------------------------------------
    with_role = [a for a in agents if a.get("role")]
    for agent in with_role:
        cap = agent["capability"]
        if agent["role"] == "External-first" and cap["web"] != "available":
            bad("RUN-ROLE", f"{agent['key']} is External-first without WEB: available")
        if agent["role"] == "Workspace-first" and cap["workspace"] != "readable":
            bad("RUN-ROLE", f"{agent['key']} is Workspace-first without WORKSPACE: readable")
    full = all(a["capability"] == {"web": "available", "workspace": "readable"} for a in with_role)
    if len(with_role) == 2 and full and [a["role"] for a in with_role] != ["Workspace-first", "External-first"]:
        bad("RUN-ROLE", "two fully capable children get Workspace-first then External-first, in --agents order")
    if len(with_role) == 1 and not str(with_role[0]["role"]).startswith("Hybrid"):
        bad("RUN-ROLE", "a single child is a Hybrid Researcher")

    # ---- RUN-CAPABILITY ----------------------------------------------------
    for agent in agents:
        key, cap = agent["key"], agent["capability"]
        probe_exit = exit_of(f"{key}.probe")
        if probe_exit != 0:
            if cap != {"web": "unknown", "workspace": "unknown"}:
                bad("RUN-CAPABILITY", f"{key}: no successful probe, so capability stays unknown")
            continue
        reply = reply_of(f"{key}.probe") or ""
        web = re.search(r"(?m)^WEB: (available|unavailable)\b", reply)
        ws = re.search(r"(?m)^WORKSPACE: (readable|unreadable)\b", reply)
        if not web or not ws:
            bad("RUN-CAPABILITY", f"{key}: the probe reply lacks the WEB / WORKSPACE lines")
        elif (web.group(1), ws.group(1)) != (cap["web"], cap["workspace"]):
            bad("RUN-CAPABILITY", f"{key}: probe said {web.group(1)} / {ws.group(1)}, run.json says {cap}")

    # ---- REPLY-* / PROMPT-SHAPE --------------------------------------------
    research_text: dict[str, str] = {}
    for agent in agents:
        key = agent["key"]
        if agent["status"] == "completed" and exit_of(key) == 0:
            data = json_of(key)
            if not isinstance(data, dict) or not {"worktreeId", "instanceId", "cliToolId", "source", "reply"} <= data.keys():
                bad("REPLY-SHAPE", f"agents/{key}.json is not the ask --json reply shape")
                continue
            if data["instanceId"] != agent["instanceId"] or data["worktreeId"] != agent["worktreeId"]:
                bad("REPLY-SHAPE", f"agents/{key}.json answers for {data['worktreeId']}/{data['instanceId']}")
            if agent["source"] in ("history", "pane") and data["source"] != agent["source"]:
                bad("REPLY-SHAPE", f"agents/{key}.json source {data['source']} but run.json says {agent['source']}")
            reply = data["reply"] if isinstance(data["reply"], str) else ""
            lines = [l for l in reply.splitlines() if l.strip()]
            # A history reply can carry the turn's narration before the report (Command Code
            # does; Claude returns only the final message), so the WEB line only has to come
            # before the report's first heading, not on line 1 (Issue #253).
            web_at = next((i for i, l in enumerate(lines) if re.match(r"^WEB: (available|unavailable)\b", l)), None)
            report_at = next((i for i, l in enumerate(lines) if l.strip() in REPORT_HEADING_LINES), len(lines))
            if web_at is None or web_at > report_at:
                bad("REPLY-SHAPE", f"{key}: the reply has no WEB line before the report")
            if not any(l.startswith("DONE:") for l in lines):
                bad("REPLY-SHAPE", f"{key}: the reply has no DONE: line")
            body = read(agents_dir / f"{key}.md") if agent["source"] == "file" else reply
            research_text[key] = body
            problem = heading_problem([t for t, _ in h1_sections(body)], REPORT_HEADINGS)
            if problem:
                bad("REPLY-HEADINGS", f"{key}: {problem}")
        if exit_of(key) == 10:
            data = json_of(key)
            if not isinstance(data, dict) or not {"worktreeId", "cliToolId", "type", "question", "options", "status"} <= data.keys() \
                    or not isinstance(data.get("options"), list):
                bad("PROMPT-SHAPE", f"agents/{key}.json is not the prompt payload exit 10 carries")
    for key, text in research_text.items():
        for other in agents:
            if other["key"] == key:
                continue
            for name in {other["instanceId"], other["alias"], other["key"]}:
                if name and mentions(text, name):
                    bad("REPLY-INDEPENDENT", f"{key}'s independent reply mentions {name}")
    for name in sorted(exit_names):
        if ".challenge-" in name and exit_of(name) == 0:
            reply = reply_of(name) or ""
            if not any(l.startswith("DONE:") for l in reply.splitlines()):
                bad("REPLY-SHAPE", f"{name}: the challenge reply has no DONE: line")

    # ---- SENT-* / ROLE-CONTRACT ------------------------------------------
    for name in sorted(sent_names):
        text = read(sent_dir / f"{name}.txt")
        if name in by_key:
            for problem in check_send_text(text, name, "research"):
                bad("SENT-BRIEF", f"sent/{name}.txt {problem}")
            continue
        match = re.fullmatch(r"(.+)\.challenge-(\d+)", name)
        if match and match.group(1) in by_key:
            for problem in check_send_text(text, match.group(1), "challenge", match.group(2)):
                bad("SENT-BRIEF", f"sent/{name}.txt {problem}")
            if not (run_dir / "challenges" / f"{name}.md").is_file():
                bad("SENT-BRIEF", f"challenges/{name}.md does not exist")
        elif name.endswith(".probe") and name[:-6] in by_key:
            for problem in check_probe_text(text):
                bad("SENT-PROBE", f"sent/{name}.txt {problem}")
        elif name.endswith(".warmup") and name[:-7] in by_key:
            if text.strip() != WARMUP_TEXT:
                bad("SENT-WARMUP", f"sent/{name}.txt is not the fixed warm-up text")
        else:
            bad("CMD-TRACE", f"sent/{name}.txt belongs to no child and no phase")
    for agent in agents:
        key = agent["key"]
        if not agent["running"] and agent["warmup"] == "not_needed":
            bad("SENT-WARMUP", f"{key} was not running and got no warm-up")
        if agent["warmup"] == "ready":
            reply = reply_of(f"{key}.warmup") or ""
            if f"{key}.warmup" not in sent_names or exit_of(f"{key}.warmup") != 0 or "READY" not in reply:
                bad("SENT-WARMUP", f"{key}: warmup is ready without a READY reply to the fixed text")
        if agent.get("role"):
            role_path = run_dir / "roles" / f"{key}.md"
            if not role_path.is_file():
                bad("ROLE-CONTRACT", f"roles/{key}.md does not exist")
            else:
                for problem in check_role_text(read(role_path)):
                    bad("ROLE-CONTRACT", f"roles/{key}.md {problem}")

    # ---- CMD-* -------------------------------------------------------------
    log_path = run_dir / "commands.log"
    log_lines = read(log_path).splitlines() if log_path.is_file() else []
    if not log_lines:
        bad("CMD-TRACE", "commands.log is missing or empty")
    ask_names = set()
    for line in log_lines:
        if FORBIDDEN_CMD.search(line):
            bad("CMD-FORBIDDEN", f"the parent answered for or re-armed a child: {line.strip()}")
        if re.search(r"\bcommandmate\s+ask\s+(--help|-h)\b", line):
            continue  # the ask-path probe references/delegate-contract.md prescribes; it sends nothing
        if re.search(r"\bcommandmate\s+ask\b", line):
            match = ASK_NAME.search(line)
            if not match:
                bad("CMD-TRACE", f"an ask without an @sent/ message: {line.strip()}")
                continue
            name = match.group(1)
            ask_names.add(name)
            if re.search(r"--async\b|--reply-to\b", line):
                bad("CMD-ASK", f"relay used in an MVP run: {line.strip()}")
            if "--json" not in line.split():
                bad("CMD-ASK", f"ask without --json: {line.strip()}")
            if (name in by_key or ".challenge-" in name) and "--timeout 3600" not in line:
                bad("CMD-ASK", f"research / challenge ask not at --timeout 3600: {line.strip()}")
    for name in sorted(sent_names | exit_names | ask_names):
        missing = [what for what, names in (("sent/", sent_names), ("agents/*.exit", exit_names),
                                            ("commands.log ask", ask_names)) if name not in names]
        if missing:
            bad("CMD-TRACE", f"{name}: no {', '.join(missing)}")

    # ---- BRIEF -------------------------------------------------------------
    brief_path = run_dir / "brief.md"
    brief = read(brief_path) if brief_path.is_file() else ""
    problem = heading_problem([t for t, _ in h1_sections(brief)], BRIEF_HEADINGS)
    if problem:
        bad("BRIEF", problem)
    if (section(brief, "Original Request") or "").strip() != run["request"]:
        bad("BRIEF", "Original Request is not the request, verbatim")

    # ---- INTEGRITY ---------------------------------------------------------
    changed = False
    worktrees = run["workspace_integrity"].get("worktrees") or []
    if not worktrees:
        bad("INTEGRITY", "workspace_integrity.worktrees is empty")
    for wt in worktrees:
        before = run_dir / "integrity" / f"{wt}.before.txt"
        after = run_dir / "integrity" / f"{wt}.after.txt"
        if not before.is_file() or not after.is_file():
            bad("INTEGRITY", f"integrity/{wt}.before.txt / .after.txt missing")
        elif read(before) != read(after):
            changed = True
    if run["workspace_integrity"].get("changed") is not changed:
        bad("INTEGRITY", f"workspace_integrity.changed is {run['workspace_integrity'].get('changed')}, the files say {changed}")
    # git status does not see ignored paths; touched.txt lists what changed after before.txt (Issue #249).
    ignored_touched: list[str] = []
    for wt in worktrees:
        touched = run_dir / "integrity" / f"{wt}.touched.txt"
        if not touched.is_file():
            bad("INTEGRITY", f"integrity/{wt}.touched.txt missing")
            continue
        for line in read(touched).splitlines():
            if not line.strip():
                continue
            kind, _, path = line.partition("\t")
            if kind not in ("ignored", "visible") or not path:
                bad("INTEGRITY", f"integrity/{wt}.touched.txt: {line!r} is not <ignored|visible><TAB><path>")
            elif kind == "ignored":
                ignored_touched.append(f"{wt}:{path}")
    declared_ignored = run["workspace_integrity"].get("ignored_touched")
    if not isinstance(declared_ignored, list) or sorted(declared_ignored) != sorted(ignored_touched):
        bad("INTEGRITY", f"workspace_integrity.ignored_touched is {declared_ignored}, touched.txt says {ignored_touched}")

    if run["status"] == "FAILED":
        return found

    # ---- cross-check.md ----------------------------------------------------
    xc_path = run_dir / "cross-check.md"
    xc = read(xc_path) if xc_path.is_file() else ""
    problem = heading_problem([t for t, _ in h1_sections(xc)], CROSS_CHECK_HEADINGS)
    if problem:
        bad("XC-HEADINGS", problem)
    shared = section(xc, "Shared Assumptions") or ""
    if is_none(shared) or not re.search(r"反証:|Falsifier:", shared):
        bad("XC-SHARED", "Shared Assumptions names no assumption with what would falsify it")
    if not items(section(xc, "Challenges Sent") or ""):
        bad("XC-HEADINGS", "Challenges Sent is empty")
    remaining = section(xc, "Remaining Disagreements") or ""
    has_remaining = bool(items(remaining)) and not is_none(remaining)

    # ---- evidence.md -------------------------------------------------------
    ev_path = run_dir / "evidence.md"
    entries = subsections(read(ev_path), "## ") if ev_path.is_file() else []
    if not entries:
        bad("EV-SHAPE", "evidence.md has no R-xxx entry")
    for title, body in entries:
        fields: dict[str, list[str]] = {}
        current = None
        for line in body.splitlines():
            top = re.match(r"^- ([A-Za-z ]+):\s*(.*)$", line)
            if top:
                current = top.group(1)
                fields.setdefault(current, [])
                if top.group(2).strip():
                    fields[current].append(top.group(2).strip())
                continue
            nested = re.match(r"^\s+- (.*)$", line)
            if nested and current:
                fields[current].append(nested.group(1).strip())
        if not re.fullmatch(r"R-\d{3}", title):
            bad("EV-SHAPE", f"entry {title!r} is not R-xxx")
        if fields.get("Status", [""])[0] not in STATES:
            bad("EV-SHAPE", f"{title}: Status {fields.get('Status')}")
        if fields.get("Importance", [""])[0] not in IMPORTANCE:
            bad("EV-SHAPE", f"{title}: Importance {fields.get('Importance')}")
        if not fields.get("Finding"):
            bad("EV-SHAPE", f"{title}: no Finding")
        locators = []
        for label, rule in (("Workspace evidence", "WORKSPACE_LOCATOR"), ("Web evidence", "WEB_LOCATOR")):
            if label not in fields:
                bad("EV-SHAPE", f"{title}: no {label}")
            for entry in fields.get(label, []):
                if rules["NONE_LOCATOR"].fullmatch(entry):
                    continue
                if not rules[rule].fullmatch(entry):
                    bad("EV-SHAPE", f"{title}: {label} {entry!r} is not a locator")
                    continue
                if rule == "WORKSPACE_LOCATOR":
                    problem = resolve_workspace_locator(entry, workspace)
                    if problem:
                        bad("EV-SHAPE", f"{title}: {problem}")
                locators.append(locator_key(entry))
        if len(set(locators)) != len(locators):
            bad("EV-DUP", f"{title}: the same locator is counted twice")
        declared = fields.get("Independent sources", [""])[0]
        count = re.match(r"\s*(\d+)(?!\d)", declared)  # a note may follow the number (Issue #253)
        if not count or int(count.group(1)) != len(set(locators)):
            bad("EV-DUP", f"{title}: Independent sources {declared!r}, distinct locators {len(set(locators))}")

    # ---- final.md ----------------------------------------------------------
    final_path = run_dir / "final.md"
    final = read(final_path) if final_path.is_file() else ""
    titles = [t for t, _ in h1_sections(final)]
    problem = heading_problem(titles, FINAL_HEADINGS)
    if problem:
        bad("FINAL-HEADINGS", problem)

    changed_body = section(final, "What Changed Through Cross Check")
    if changed_body is not None:
        if not items(changed_body):
            bad("FINAL-CHANGED", "What Changed Through Cross Check is empty; write 修正なし")
        elif not is_none(changed_body) and not (re.search(r"(?m)^- Initial:", changed_body)
                                                and re.search(r"(?m)^- Final:", changed_body)):
            bad("FINAL-CHANGED", "each change needs Initial: and Final:")
        xc_corrections = section(xc, "Corrections") or ""
        if is_none(xc_corrections) != is_none(changed_body):
            bad("XC-CORRECTIONS", "cross-check Corrections and final What Changed disagree on whether anything changed")

    def check_evidence_items(where: str, found_items: list[str], kind: str) -> int:
        count = 0
        for entry in found_items:
            if rules["NONE_LOCATOR"].fullmatch(entry):
                continue
            if kind == "ws":
                if not rules["WORKSPACE_LOCATOR"].fullmatch(entry):
                    bad("FINAL-LOCATOR-WS", f"{where}: {entry!r} is not path:line or path::symbol")
                    continue
                problem = resolve_workspace_locator(entry, workspace)
                if problem:
                    bad("FINAL-LOCATOR-WS", f"{where}: {problem}")
            elif not rules["WEB_LOCATOR"].fullmatch(entry):
                bad("FINAL-LOCATOR-WEB", f"{where}: {entry!r} is not URL — source (date), as-of YYYY-MM-DD")
                continue
            count += 1
        return count

    ws_total = web_total = 0
    findings = subsections(section(final, "Key Findings") or "", "## ")
    if not findings:
        bad("FINAL-FINDING", "Key Findings has no ## Finding")
    for title, body in findings:
        head = re.split(r"(?m)^### ", body, maxsplit=1)[0]
        fields = {m.group(1): m.group(2).strip()
                  for m in re.finditer(r"(?m)^- (Finding|Status|Why it matters):\s*(.*)$", head)}
        for key in ("Finding", "Status", "Why it matters"):
            if not fields.get(key):
                bad("FINAL-FINDING", f"{title}: no {key}")
        status = fields.get("Status", "")
        if status and status not in STATES:
            bad("FINAL-FINDING", f"{title}: Status {status!r}")
        if status in ("UNVERIFIED", "CITED_NOT_VERIFIED") and not re.search(
                r"未確認|unverified|not verified", fields.get("Finding", ""), re.IGNORECASE):
            bad("FINAL-UNVERIFIED-WORDING", f"{title}: {status} but the Finding reads as fact")
        subs = dict(subsections(body, "### "))
        for label, kind in (("Workspace Evidence", "ws"), ("Web Evidence", "web")):
            if label not in subs or not items(subs[label]):
                bad("FINAL-FINDING", f"{title}: ### {label} is missing or empty")
                continue
            n = check_evidence_items(f"{title} / {label}", items(subs[label]), kind)
            ws_total += n if kind == "ws" else 0
            web_total += n if kind == "web" else 0
    sources = dict(subsections(section(final, "Sources") or "", "## "))
    check_evidence_items("Sources / Web", items(sources.get("Web", "")), "web")
    check_evidence_items("Sources / Workspace", items(sources.get("Workspace", "")), "ws")

    metadata = {m.group(1): m.group(2).strip() for m in re.finditer(
        r"(?m)^- (Agents|Workspace|AS_OF|Depth|Coverage|Workspace integrity|Run):\s*(.*)$",
        section(final, "Research Metadata") or "")}
    for key in METADATA_KEYS:
        if not metadata.get(key):
            bad("FINAL-METADATA", f"Research Metadata has no {key}")
    if metadata.get("AS_OF") and metadata["AS_OF"] != run["as_of"]:
        bad("FINAL-METADATA", f"AS_OF {metadata['AS_OF']} but run.json says {run['as_of']}")
    if metadata.get("Depth") and not metadata["Depth"].startswith("standard"):
        bad("FINAL-METADATA", f"Depth {metadata['Depth']!r}")
    if (section(final, "Research Question") or "").strip() != run["request"]:
        bad("FINAL-METADATA", "Research Question is not the request, verbatim")

    coverage_line = metadata.get("Coverage", "")
    if ws_total == 0 and "Workspace research unavailable" not in coverage_line:
        bad("FINAL-FINDING", "no Workspace evidence in any finding, and the coverage does not say so")
    if web_total == 0 and "Web research unavailable" not in coverage_line:
        bad("FINAL-FINDING", "no Web evidence in any finding, and the coverage does not say so")

    integrity = metadata.get("Workspace integrity", "")
    if integrity and integrity.split()[0] != ("changed" if changed else "unchanged"):
        bad("FINAL-INTEGRITY", f"final says {integrity.split()[0]!r} but before/after say {'changed' if changed else 'unchanged'}")
    if changed and "workspace が変更された" not in (section(final, "Risks / Counterevidence") or ""):
        bad("FINAL-INTEGRITY", "the workspace changed and Risks does not say so")
    reported = re.search(r"ignore 対象の更新: *(\d+) *件", integrity)
    if integrity and (not reported or int(reported.group(1)) != len(ignored_touched)):
        bad("FINAL-INTEGRITY", f"Workspace integrity does not report {len(ignored_touched)} ignored-path write(s) as 'ignore 対象の更新: N 件'")
    risks_text = section(final, "Risks / Counterevidence") or ""
    for entry in ignored_touched:
        if entry.split(":", 1)[1] not in risks_text:
            bad("FINAL-INTEGRITY", f"the ignored-path write {entry} is not listed in Risks")

    for key in reduced:
        if "Research coverage reduced:" not in coverage_line or not mentions(coverage_line, key):
            bad("FINAL-COVERAGE", f"{key} did not complete and the Coverage line does not say so")
    if not reduced and "Research coverage reduced" in coverage_line:
        bad("FINAL-COVERAGE", "Coverage says reduced although every child completed")

    if has_remaining and "UNRESOLVED CONTRADICTION" not in final:
        bad("FINAL-UNRESOLVED", "a disagreement remains in cross-check.md and final.md does not mark it UNRESOLVED CONTRADICTION")

    return found


# =============================================================================
# The package checker
# =============================================================================

LOCATOR_EXAMPLES = (
    ("WORKSPACE_LOCATOR", "package.json:14", True),
    ("WORKSPACE_LOCATOR", "docker/Dockerfile:23-31", True),
    ("WORKSPACE_LOCATOR", "src/auth/auth.service.ts::AuthService.login", True),
    ("WORKSPACE_LOCATOR", "[api-wt] src/app.ts:12", True),
    ("WORKSPACE_LOCATOR", 'package.json:14 — "pkg-x": "^3.4.2"', True),
    ("WORKSPACE_LOCATOR", "package.json", False),
    ("WORKSPACE_LOCATOR", "the config file", False),
    ("WORKSPACE_LOCATOR", "src/app.ts:0", False),
    ("WEB_LOCATOR", "https://pkg-x.example.com/docs/support-matrix — pkg-x Support Matrix（2026-06-30 更新）, as-of 2026-09-11", True),
    ("WEB_LOCATOR", "https://example.com/a - A (date unknown), as-of 2026-09-11", True),
    ("WEB_LOCATOR", "https://example.com/a — A", False),
    ("WEB_LOCATOR", "http://example.com/a — A (2026-01-01), as-of 2026-09-11", False),
    ("WEB_LOCATOR", "command-code と antigravity の意見が一致した", False),
    ("NONE_LOCATOR", "なし — Workspace 内の事実だけで決まる", True),
    ("NONE_LOCATOR", "なし", False),
)


def check_package(skill_dir: Path = SKILL_DIR) -> Problems:
    found: Problems = []

    def bad(rule: str, message: str) -> None:
        found.append((rule, message))

    refs = skill_dir / "references"
    skill_md = read(skill_dir / "SKILL.md")

    # PKG-SECTIONS: ## 0. .. ## 10. in order, and every reference linked and present.
    numbers = [int(m.group(1)) for m in re.finditer(r"(?m)^## (\d+)\. ", skill_md)]
    if [n for n in numbers if n <= 10] != list(range(11)):
        bad("PKG-SECTIONS", f"SKILL.md sections are {numbers}, expected 0..10 in order")
    linked = set(re.findall(r"\]\(\./references/([^)#]+)\)", skill_md))
    shipped = {p.name for p in refs.glob("*.md")}
    for name in sorted(linked - shipped):
        bad("PKG-SECTIONS", f"SKILL.md links references/{name}, which does not exist")
    for name in sorted(shipped - linked):
        bad("PKG-SECTIONS", f"references/{name} is shipped but SKILL.md never links it")

    brief_md = read(refs / "research-brief.md")
    cross_md = read(refs / "cross-check.md")
    artifacts_md = read(refs / "artifacts.md")

    def block(text: str, marker: str) -> str:
        found_block = between(text, marker)
        if found_block is None:
            bad("PKG-TEMPLATES", f"template block {marker} is missing")
            return ""
        return found_block

    for lang in ("ja", "en"):
        for problem in check_send_text(block(brief_md, f"SEND TEMPLATE {lang}"), "<key>", "research"):
            bad("PKG-TEMPLATES", f"send template ({lang}) {problem}")
        for problem in check_probe_text(block(brief_md, f"PROBE TEMPLATE {lang}")):
            bad("PKG-TEMPLATES", f"probe template ({lang}) {problem}")
        for problem in check_send_text(block(cross_md, f"CHALLENGE SEND TEMPLATE {lang}"), "<key>", "challenge"):
            bad("PKG-TEMPLATES", f"challenge send template ({lang}) {problem}")
    if block(brief_md, "WARMUP TEMPLATE").strip() != WARMUP_TEXT:
        bad("PKG-TEMPLATES", "the warm-up template is not the fixed text")
    for problem in check_role_text(block(brief_md, "ROLE TEMPLATE")):
        bad("PKG-TEMPLATES", f"role template {problem}")
    for marker, text, required in (
        ("BRIEF TEMPLATE", brief_md, BRIEF_HEADINGS),
        ("CROSS-CHECK TEMPLATE", artifacts_md, CROSS_CHECK_HEADINGS),
        ("FINAL TEMPLATE", artifacts_md, FINAL_HEADINGS),
    ):
        problem = heading_problem([t for t, _ in h1_sections(block(text, marker))], required)
        if problem:
            bad("PKG-TEMPLATES", f"{marker}: {problem}")
    evidence_template = block(artifacts_md, "EVIDENCE TEMPLATE")
    for needle in ("- Status:", "- Workspace evidence:", "- Web evidence:", "- Independent sources:"):
        if needle not in evidence_template:
            bad("PKG-TEMPLATES", f"EVIDENCE TEMPLATE: missing {needle}")

    # PKG-LOCATOR-RULES
    try:
        rules = load_locator_rules(skill_dir)
    except SystemExit as error:
        bad("PKG-LOCATOR-RULES", str(error))
    else:
        for name, example, expected in LOCATOR_EXAMPLES:
            if bool(rules[name].fullmatch(example)) is not expected:
                bad("PKG-LOCATOR-RULES", f"{name} {'rejects' if expected else 'accepts'} {example!r}")

    # PKG-CODE-BLOCKS: no runnable snippet answers a prompt, touches auto-yes or opens a relay.
    documents = [("SKILL.md", skill_md)] + [(f"references/{p.name}", read(p)) for p in sorted(refs.glob("*.md"))]
    for where, text in documents:
        for snippet in code_blocks(text):
            for line in snippet.splitlines():
                if FORBIDDEN_CMD.search(line) or re.search(r"--async\b|--reply-to\b", line):
                    bad("PKG-CODE-BLOCKS", f"{where}: {line.strip()}")
                if re.search(r"\bcommandmate ask\b", line) and "--help" not in line and "--json" not in line:
                    bad("PKG-CODE-BLOCKS", f"{where}: an ask without --json: {line.strip()}")

    # PKG-RUN-DIR: the run-dir is .commandmate/workspace-research/, never .cmate/.
    for where, text in documents:
        if ".cmate/" in text:
            bad("PKG-RUN-DIR", f"{where} mentions .cmate/")
    if ".commandmate/workspace-research/" not in skill_md:
        bad("PKG-RUN-DIR", "SKILL.md does not name .commandmate/workspace-research/")
    return found


# =============================================================================
# Self-test
# =============================================================================


class MutationMiss(Exception):
    """The mutation did not apply: the fixture no longer contains what it edits."""


def replace_in(path: Path, old: str, new: str, count: int = 1) -> None:
    text = read(path)
    if old not in text:
        raise MutationMiss(f"{path.name}: {old!r} not found")
    path.write_text(text.replace(old, new, count if count > 0 else text.count(old)), encoding="utf-8")


def drop_lines(path: Path, needle: str) -> None:
    lines = read(path).splitlines(keepends=True)
    kept = [l for l in lines if needle not in l]
    if len(kept) == len(lines):
        raise MutationMiss(f"{path.name}: no line contains {needle!r}")
    path.write_text("".join(kept), encoding="utf-8")


def append(path: Path, text: str) -> None:
    with path.open("a", encoding="utf-8") as handle:
        handle.write(text)


def edit_json(path: Path, change: Callable[[Any], None]) -> None:
    data = json.loads(read(path))
    change(data)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def edit_reply(path: Path, change: Callable[[str], str]) -> None:
    def apply(data: Any) -> None:
        new = change(data["reply"])
        if new == data["reply"]:
            raise MutationMiss(f"{path.name}: the reply did not change")
        data["reply"] = new
    edit_json(path, apply)


def agent_named(key: str) -> Callable[[Any], dict[str, Any]]:
    return lambda run: next(a for a in run["agents"] if a["key"] == key)


def set_agent(key: str, **fields: Any) -> Callable[[Any], None]:
    return lambda run: agent_named(key)(run).update(fields)


def replace_section(path: Path, title: str, next_title: str, body: str) -> None:
    text = read(path)
    pattern = re.compile(rf"(?ms)^# {re.escape(title)}\n.*?(?=^# {re.escape(next_title)}\n)")
    if not pattern.search(text):
        raise MutationMiss(f"{path.name}: section {title} not found")
    path.write_text(pattern.sub(f"# {title}\n\n{body}\n\n", text, count=1), encoding="utf-8")


CC, PS = "cross-check-correction", "prompt-stopped"
SUPPORT_LINE = "https://pkg-x.example.com/docs/support-matrix — pkg-x Support Matrix（2026-06-30 更新）, as-of 2026-09-11"

# (name, run, mutate(run_dir), the rule that has to fire)
RUN_MUTATIONS: tuple[tuple[str, str, Callable[[Path], None], str], ...] = (
    ("run.json: an unknown mode", CC,
     lambda d: edit_json(d / "run.json", lambda r: r.update(mode="RESEARCH")), "RUN-SHAPE"),
    ("run.json: the parent listed as a child", CC,
     lambda d: edit_json(d / "run.json", set_agent("command-code", instanceId="claude")), "RUN-SELF"),
    ("run.json: the prompt-stopped child reported completed", PS,
     lambda d: edit_json(d / "run.json", set_agent("antigravity", status="completed", reason=None)), "RUN-EXIT"),
    ("run.json: COMPLETED with a stopped child", PS,
     lambda d: edit_json(d / "run.json", lambda r: r.update(status="COMPLETED")), "RUN-STATUS"),
    ("run.json: External-first given to a Web-less child", CC,
     lambda d: edit_json(d / "run.json", set_agent("antigravity", capability={"web": "unavailable", "workspace": "readable"})), "RUN-ROLE"),
    ("probe: the reply disagrees with the recorded capability", CC,
     lambda d: edit_reply(d / "agents" / "command-code.probe.json", lambda s: s.replace("WEB: available", "WEB: unavailable")), "RUN-CAPABILITY"),
    ("reply: the independent reply mentions the other child", CC,
     lambda d: edit_reply(d / "agents" / "command-code.json", lambda s: s.replace("\n\nDONE:", "\n\nantigravity の結論とも一致する。\n\nDONE:")), "REPLY-INDEPENDENT"),
    ("reply: no DONE line", CC,
     lambda d: edit_reply(d / "agents" / "antigravity.json", lambda s: "\n".join(l for l in s.splitlines() if not l.startswith("DONE:"))), "REPLY-SHAPE"),
    ("reply: the WEB line removed", CC,
     lambda d: edit_reply(d / "agents" / "command-code.json", lambda s: s.split("\n", 1)[1]), "REPLY-SHAPE"),
    ("reply: the WEB line only after the report", CC,
     lambda d: edit_reply(d / "agents" / "command-code.json", lambda s: "\n".join(s.split("\n")[1:] + [s.split("\n")[0]])), "REPLY-SHAPE"),
    ("reply: a report heading is missing", CC,
     lambda d: edit_reply(d / "agents" / "antigravity.json", lambda s: s.replace("# Web ↔ Workspace Connections\n", "")), "REPLY-HEADINGS"),
    ("reply: exit 10 without a prompt payload", PS,
     lambda d: (d / "agents" / "antigravity.json").write_text('{"source":"history","reply":"DONE: ok"}\n', encoding="utf-8"), "PROMPT-SHAPE"),
    ("sent: the agents/ prohibition removed", CC,
     lambda d: drop_lines(d / "sent" / "command-code.txt", "agents/"), "SENT-BRIEF"),
    ("sent: the research contract pasted into the message", CC,
     lambda d: append(d / "sent" / "antigravity.txt", "\nMODE: WORKSPACE_RESEARCH\n"), "SENT-BRIEF"),
    ("sent: the no-write clause removed", CC,
     lambda d: drop_lines(d / "sent" / "command-code.txt", "1 byte"), "SENT-BRIEF"),
    ("sent: the challenge message points at no challenge file", CC,
     lambda d: replace_in(d / "sent" / "antigravity.challenge-1.txt", "challenges/antigravity.challenge-1.md", "challenges/antigravity.md"), "SENT-BRIEF"),
    ("sent: the probe no longer asks about the workspace", CC,
     lambda d: drop_lines(d / "sent" / "command-code.probe.txt", "WORKSPACE:"), "SENT-PROBE"),
    ("sent: the warm-up text reworded", PS,
     lambda d: (d / "sent" / "antigravity.warmup.txt").write_text("Are you there?\n", encoding="utf-8"), "SENT-WARMUP"),
    ("role: the Evidence Status line removed", CC,
     lambda d: drop_lines(d / "roles" / "command-code.md", "Evidence Status: VERIFIED"), "ROLE-CONTRACT"),
    ("role: the agents/ prohibition removed", CC,
     lambda d: drop_lines(d / "roles" / "antigravity.md", "agents/"), "ROLE-CONTRACT"),
    ("commands.log: the parent answered the stopped child", PS,
     lambda d: append(d / "commands.log", '2026-09-12T09:42:00+0900 commandmate respond node-app "1" --instance antigravity\n'), "CMD-FORBIDDEN"),
    ("commands.log: the parent enabled auto-yes", PS,
     lambda d: append(d / "commands.log", "2026-09-12T09:42:00+0900 commandmate auto-yes node-app --enable --instance antigravity\n"), "CMD-FORBIDDEN"),
    ("commands.log: a research ask at the default timeout", CC,
     lambda d: replace_in(d / "commands.log", "@sent/command-code.txt --timeout 3600", "@sent/command-code.txt --timeout 1800"), "CMD-ASK"),
    ("commands.log: a relay opened", CC,
     lambda d: replace_in(d / "commands.log", "@sent/antigravity.challenge-1.txt --timeout 3600 --json", "@sent/antigravity.challenge-1.txt --timeout 3600 --json --async"), "CMD-ASK"),
    ("commands.log: a reply with no ask that produced it", CC,
     lambda d: drop_lines(d / "commands.log", "@sent/antigravity.txt"), "CMD-TRACE"),
    ("commands.log: an ask that sends an inline message", CC,
     lambda d: append(d / "commands.log", "2026-09-11T10:30:00+0900 commandmate ask node-app --instance antigravity \"inline\" --timeout 3600 --json\n"), "CMD-TRACE"),
    ("brief: the Original Request reworded", CC,
     lambda d: replace_in(d / "brief.md", "このrepoをNode.js 24へ移行して問題ないか調査して", "Node.js 24 への移行手順を作って"), "BRIEF"),
    ("cross-check: a heading removed", CC,
     lambda d: drop_lines(d / "cross-check.md", "# Verification Performed"), "XC-HEADINGS"),
    ("cross-check: shared assumptions with no falsifier", CC,
     lambda d: drop_lines(d / "cross-check.md", "反証:"), "XC-SHARED"),
    ("cross-check: Corrections says none while final lists changes", CC,
     lambda d: replace_section(d / "cross-check.md", "Corrections", "Remaining Disagreements", "- 修正なし"), "XC-CORRECTIONS"),
    ("evidence: an invalid status", CC,
     lambda d: replace_in(d / "evidence.md", "- Status: VERIFIED", "- Status: CONFIRMED"), "EV-SHAPE"),
    ("evidence: the same URL counted twice", CC,
     lambda d: replace_in(d / "evidence.md", f"  - {SUPPORT_LINE}\n", f"  - {SUPPORT_LINE}\n  - {SUPPORT_LINE}\n"), "EV-DUP"),
    ("evidence: Independent sources overstated", CC,
     lambda d: replace_in(d / "evidence.md", "- Independent sources: 4", "- Independent sources: 5"), "EV-DUP"),
    ("evidence: Independent sources overstated behind a note", CC,
     lambda d: replace_in(d / "evidence.md", "- Independent sources: 4", "- Independent sources: 5（同じ URL は 1 と数える）"), "EV-DUP"),
    ("final: the What Changed heading removed", CC,
     lambda d: drop_lines(d / "final.md", "# What Changed Through Cross Check"), "FINAL-HEADINGS"),
    ("final: What Changed left empty", PS,
     lambda d: drop_lines(d / "final.md", "- 修正なし"), "FINAL-CHANGED"),
    ("final: a finding without Why it matters", CC,
     lambda d: drop_lines(d / "final.md", "- Why it matters: 移行の blocker"), "FINAL-FINDING"),
    ("final: a vague workspace locator", CC,
     lambda d: replace_in(d / "final.md", "- src/server.js:6 — 起動時に openCache を呼ぶ", "- the server code — 起動時に openCache を呼ぶ"), "FINAL-LOCATOR-WS"),
    ("final: a locator past the end of the file", CC,
     lambda d: replace_in(d / "final.md", "- package.json:15 — ", "- package.json:99 — "), "FINAL-LOCATOR-WS"),
    ("final: Web evidence without as-of", CC,
     lambda d: replace_in(d / "final.md", "（2026-05-12）, as-of 2026-09-11", "（2026-05-12）"), "FINAL-LOCATOR-WEB"),
    ("final: agent consensus written as Web evidence", CC,
     lambda d: replace_in(d / "final.md", "- なし — Workspace 内の事実だけで決まる", "- command-code と antigravity の意見が一致した"), "FINAL-LOCATOR-WEB"),
    ("final: an UNVERIFIED finding stated as fact", CC,
     lambda d: replace_in(d / "final.md", "open 呼び出しが壊れるかは未確認", "open 呼び出しが壊れる"), "FINAL-UNVERIFIED-WORDING"),
    ("final: AS_OF disagrees with run.json", CC,
     lambda d: replace_in(d / "final.md", "- AS_OF: 2026-09-11", "- AS_OF: 2026-09-01"), "FINAL-METADATA"),
    ("final: says unchanged while the workspace changed", CC,
     lambda d: append(d / "integrity" / "node-app.after.txt", " M package.json\n"), "FINAL-INTEGRITY"),
    ("final: the coverage line dropped for a stopped child", PS,
     lambda d: replace_in(d / "final.md", "- Coverage: Research coverage reduced: antigravity did not complete (prompt_stopped).", "- Coverage: full"), "FINAL-COVERAGE"),
    ("final: the unresolved contradiction merged away", CC,
     lambda d: replace_in(d / "final.md", "UNRESOLVED CONTRADICTION", "未決着の点", count=0), "FINAL-UNRESOLVED"),
    ("integrity: the after snapshot is missing", CC,
     lambda d: (d / "integrity" / "node-app.after.txt").unlink(), "INTEGRITY"),
    ("integrity: touched.txt is missing", CC,
     lambda d: (d / "integrity" / "node-app.touched.txt").unlink(), "INTEGRITY"),
    ("integrity: an ignored-path write not carried to run.json", CC,
     lambda d: append(d / "integrity" / "node-app.touched.txt", "ignored\t.commandcode/taste/taste.md\n"), "INTEGRITY"),
    ("final: an ignored-path write not listed in Risks", PS,
     lambda d: drop_lines(d / "final.md", "- ignore 対象への書き込み:"), "FINAL-INTEGRITY"),
    ("final: the ignored-path write count is wrong", PS,
     lambda d: replace_in(d / "final.md", "ignore 対象の更新: 1 件", "ignore 対象の更新: 0 件"), "FINAL-INTEGRITY"),
)

# The package mutations: one literal dropped from a copy of a reference, and the
# package check has to notice. (file, literal, rule)
PACKAGE_MUTATIONS: tuple[tuple[str, str, str], ...] = (
    ("references/research-brief.md", "■ 触ってはいけないもの", "PKG-TEMPLATES"),
    ("references/research-brief.md", "# Do not touch", "PKG-TEMPLATES"),
    ("references/research-brief.md", "- run-dir の agents/ と、他の Agent の roles/ は読まない", "PKG-TEMPLATES"),
    ("references/research-brief.md", "- Do not write a single byte into the workspace, the run-dir included (no file", "PKG-TEMPLATES"),
    ("references/research-brief.md", "WORKSPACE: readable — <読めた path>", "PKG-TEMPLATES"),
    ("references/research-brief.md", "Evidence Status: VERIFIED | PARTIAL | CITED_NOT_VERIFIED | UNVERIFIED", "PKG-TEMPLATES"),
    ("references/research-brief.md", "# Web ↔ Workspace Connections", "PKG-TEMPLATES"),
    ("references/cross-check.md", "- <run-dir の絶対 path>/challenges/<key>.challenge-<n>.md を読み", "PKG-TEMPLATES"),
    ("references/artifacts.md", "# What Changed Through Cross Check", "PKG-TEMPLATES"),
    ("references/artifacts.md", "# Shared Assumptions", "PKG-TEMPLATES"),
    ("references/evidence-rules.md", "WEB_LOCATOR = ", "PKG-LOCATOR-RULES"),
    ("SKILL.md", "## 7. TARGETED VERIFY", "PKG-SECTIONS"),
    ("SKILL.md", "[references/roles.md](./references/roles.md)", "PKG-SECTIONS"),
)


class Tally:
    def __init__(self) -> None:
        self.passed = 0
        self.failed = 0

    def ok(self, name: str) -> None:
        self.passed += 1
        print(f"ok   {name}")

    def fail(self, name: str, detail: str) -> None:
        self.failed += 1
        print(f"FAIL {name}\n     {detail}")


ASK_HELP_LINE = "2026-09-11T09:59:00+0900 commandmate ask --help   # preflight: ask path check\n"

# Shapes a real run produced in the #245 UAT (Issue #253). Each must pass as it is; the
# mutations above keep the relaxed rules able to reject the real violation next to it.
LIVE_SHAPES: tuple[tuple[str, str, Callable[[Path], None]], ...] = (
    ("a history reply with the turn's narration before the WEB line (Command Code)", CC,
     lambda d: edit_reply(d / "agents" / "command-code.json",
                          lambda s: "I'll read the two required files first.\n\n> **Thinking**\n\n" + s)),
    ("commands.log records the ask-path probe `commandmate ask --help`", CC,
     lambda d: (d / "commands.log").write_text(ASK_HELP_LINE + (d / "commands.log").read_text(encoding="utf-8"),
                                               encoding="utf-8")),
    ("Independent sources carries a note after the number", CC,
     lambda d: replace_in(d / "evidence.md", "- Independent sources: 4",
                          "- Independent sources: 4（同じ URL を挙げた子が 2 つあっても 1 と数える）")),
)


def variant(tmp: Path, code: int, status: str, reason: str, log: str) -> Path:
    """The prompt-stopped run, with the stopped child ending on another exit code instead."""
    run_dir = tmp / f"{PS}-exit-{code}-{status}"
    shutil.copytree(RUNS / PS, run_dir)
    (run_dir / "agents" / "antigravity.exit").write_text(f"{code}\n", encoding="utf-8")
    (run_dir / "agents" / "antigravity.json").write_text("", encoding="utf-8")
    (run_dir / "agents" / "antigravity.log").write_text(log, encoding="utf-8")
    edit_json(run_dir / "run.json", set_agent("antigravity", exit_code=code, status=status, reason=reason))
    replace_in(run_dir / "final.md", "did not complete (prompt_stopped)", f"did not complete ({status})")
    return run_dir


def selftest() -> int:
    tally = Tally()
    rules = load_locator_rules()

    print("== 1. the package: templates, locator rules, sections, snippets ==")
    problems = check_package()
    if problems:
        tally.fail("the package passes every package rule", "; ".join(f"{r}: {m}" for r, m in problems))
    else:
        tally.ok("the package passes every package rule")

    print("\n== 2. every package rule rejects the omission it names ==")
    with tempfile.TemporaryDirectory(prefix="cwr-pkg-") as tmp:
        for rel, literal, rule in PACKAGE_MUTATIONS:
            copy = Path(tmp) / "cmate-workspace-research"
            if copy.exists():
                shutil.rmtree(copy)
            shutil.copytree(SKILL_DIR, copy)
            name = f"package: {rel} without {literal!r}"
            try:
                drop_lines(copy / rel, literal)
            except MutationMiss as miss:
                tally.fail(name, f"the mutation removed nothing: {miss}")
                continue
            hits = [m for r, m in check_package(copy) if r == rule]
            tally.ok(name) if hits else tally.fail(name, f"{rule} did not fire")

    print("\n== 3. both fixture runs pass ==")
    runs = sorted(p for p in RUNS.iterdir() if p.is_dir())
    if [p.name for p in runs] != sorted([CC, PS]):
        tally.fail("the fixture has exactly the two runs", f"found {[p.name for p in runs]}")
    for run_dir in runs:
        problems = check_run(run_dir, FIXTURE_WORKSPACE, rules)
        if problems:
            tally.fail(f"run {run_dir.name} passes", "\n     ".join(f"{r}: {m}" for r, m in problems))
        else:
            tally.ok(f"run {run_dir.name} passes")

    print("\n== 4. every run rule rejects the mutation aimed at it ==")
    exercised: set[str] = set()
    with tempfile.TemporaryDirectory(prefix="cwr-run-") as tmp:
        for index, (name, run_name, mutate, rule) in enumerate(RUN_MUTATIONS):
            run_dir = Path(tmp) / f"{index:02d}-{run_name}"
            shutil.copytree(RUNS / run_name, run_dir)
            try:
                mutate(run_dir)
            except (MutationMiss, StopIteration, KeyError) as miss:
                tally.fail(name, f"the mutation did not apply: {miss!r}")
                continue
            fired = {r for r, _ in check_run(run_dir, FIXTURE_WORKSPACE, rules)}
            if rule in fired:
                exercised.add(rule)
                tally.ok(f"{name} -> {rule}")
            else:
                tally.fail(name, f"{rule} did not fire (fired: {sorted(fired) or 'nothing'})")

    print("\n== 5. a stopped child still leaves a final, whichever exit code stopped it (AC-16) ==")
    with tempfile.TemporaryDirectory(prefix="cwr-var-") as tmp:
        cases = (
            (124, "timeout", "exit 124: --timeout 3600 を超えた。再送していない", "Message sent. Waiting for the reply...\n"),
            (21, "failed", "exit 21: セッションが起動していなかった", "Not started: node-app has no running antigravity session.\n"),
            (2, "prompt_stopped", "exit 2: 送る前から prompt で止まっていた。送信されていない",
             "Error: node-app is waiting on a prompt; the message was not sent.\n"),
        )
        for code, status, reason, log in cases:
            run_dir = variant(Path(tmp), code, status, reason, log)
            problems = check_run(run_dir, FIXTURE_WORKSPACE, rules)
            name = f"exit {code} -> agents[].status {status}, final still carries the coverage line"
            tally.fail(name, "; ".join(f"{r}: {m}" for r, m in problems)) if problems else tally.ok(name)
        run_dir = variant(Path(tmp), 124, "completed", "", "")
        edit_json(run_dir / "run.json", set_agent("antigravity", reason=None))
        fired = {r for r, _ in check_run(run_dir, FIXTURE_WORKSPACE, rules)}
        name = "exit 124 recorded as completed is rejected"
        tally.ok(name) if "RUN-EXIT" in fired else tally.fail(name, f"fired: {sorted(fired)}")

    print("\n== 6. shapes seen in the #245 UAT pass (Issue #253) ==")
    with tempfile.TemporaryDirectory(prefix="cwr-live-") as tmp:
        for index, (name, run_name, shape) in enumerate(LIVE_SHAPES):
            run_dir = Path(tmp) / f"{index:02d}-{run_name}"
            shutil.copytree(RUNS / run_name, run_dir)
            shape(run_dir)
            problems = check_run(run_dir, FIXTURE_WORKSPACE, rules)
            tally.fail(name, "; ".join(f"{r}: {m}" for r, m in problems)) if problems else tally.ok(name)

    print("\n== 7. no rule is a rubber stamp ==")
    missing = [r for r in RULES if r not in exercised]
    name = f"all {len(RULES)} run rules were seen to reject something"
    tally.fail(name, f"never exercised: {missing}") if missing else tally.ok(name)

    print(f"\n{tally.passed} passed, {tally.failed} failed "
          f"({len(RUN_MUTATIONS)} run mutations, {len(PACKAGE_MUTATIONS)} package mutations)")
    return 0 if tally.failed == 0 else 1


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("run_dir", nargs="?", type=Path, help="a .commandmate/workspace-research/<run-id>/ directory")
    parser.add_argument("--workspace", type=Path, help="the workspace root the locators are resolved against")
    parser.add_argument("--package", action="store_true", help="check the Skill package only")
    parser.add_argument("--selftest", action="store_true", help="run the fixture suite")
    args = parser.parse_args(argv)
    if args.selftest:
        return selftest()
    if args.package:
        problems = check_package()
    elif args.run_dir:
        problems = check_run(args.run_dir, args.workspace, load_locator_rules())
    else:
        parser.print_usage(sys.stderr)
        return 2
    for rule, message in problems:
        print(f"{rule}: {message}")
    print("ok" if not problems else f"{len(problems)} problem(s)")
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
