#!/usr/bin/env bash
# Regression tests for cmate-workspace-research.
#
#   bash tests/fixtures/cmate-workspace-research/run_tests.sh
#
# The package ships no script: it is a procedure an Agent follows. What can be
# held mechanically is (a) that SKILL.md still carries the rules Issue #245
# settled against measured CommandMate behaviour, (b) that no runnable snippet
# in the package answers a child's prompt, touches its auto-yes or opens a
# relay, (c) that a run-dir produced by the procedure has the shape the
# acceptance criteria describe, and (d) that SKILL.md holds nothing Claude
# rewrites with the slash arguments. Five sections, in this order:
#
#  1. **SKILL.md carries the confirmed spec.** One literal per rule (A-I of
#     Issue #245 plus the section 37 failure handling). A SKILL.md that quietly
#     loses "the parent never runs respond" still reads as complete.
#  2. **The check in 1 is not a rubber stamp.** Every literal is deleted from a
#     copy of the real SKILL.md, one at a time, and the check has to fail.
#  3. **No runnable snippet answers for a child.** Every fenced code block in
#     SKILL.md and references/ is read, by awk and independently of section 4,
#     for `commandmate respond` / `auto-yes` / `interrupt`, `--auto-yes`,
#     `--async` and `--reply-to`.
#  4. **The run-dir checker and the fixture.** `check_run.py --selftest`: the
#     package templates, both fixture runs under two-agent-contradiction/runs,
#     one injected mutation per rule, and the exit 124 / 21 / 2 variants of the
#     child that stopped (AC-16).
#  5. **SKILL.md survives the slash arguments.** Claude Code rewrites a dollar
#     sign followed by a digit, and $ARGUMENTS, in the SKILL.md body with the
#     arguments of the slash invocation (Issue #247). The body must hold
#     neither, and a planted one has to be found.
#
# Requires bash (3.2 is enough), python3 (standard library only) and the POSIX
# tools. No network, no CommandMate server, no Agent session.
set -u

SUITE_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SUITE_DIR/../../.." && pwd)
SKILL_DIR="$REPO_ROOT/skills/cmate-workspace-research"
SKILL_MD="$SKILL_DIR/SKILL.md"

WORK=$(mktemp -d -t cmate-workspace-research-tests.XXXXXX)
trap 'rm -rf "$WORK"' EXIT INT TERM

passed=0
failed=0
mutations=0

pass() { passed=$((passed + 1)); printf 'ok   %s\n' "$1"; }
fail() { failed=$((failed + 1)); printf 'FAIL %s\n     %s\n' "$1" "$2"; }

# ---------------------------------------------------------------------------
# 1. SKILL.md carries the confirmed spec
# ---------------------------------------------------------------------------
printf '== 1. SKILL.md carries the rules Issue #245 settled ==\n'

# <rule><TAB><literal>. The literal is what an Agent cannot work out from the
# rest of the file; the rule names where it comes from.
REQUIRED='A: permissions shown once, before the start	1 回だけ人に選ばせる
A: the parent never answers a child prompt	`respond` も打たない
A: exit 10 stops that child only	その子だけ止める
B: capability is probed before roles	WEB: available | unavailable
B: no Web anywhere lowers coverage	Workspace evidence only
C: the run-dir lives under .commandmate	.commandmate/workspace-research/<run-id>/
C: children write nothing	workspace に 1 byte も書かない
C: before/after git status is kept	workspace が変更された
C: pane-only tools get the one write exception	agents/<key>.md
D: the contract lives in the role file	調査契約を送信文に入れない
E: N background asks	) &
E: joined with the shell wait	wait   # shell の wait
E: a Codex parent falls back to serial	親が Codex のときは直列を fallback にする
E: no relay in the MVP	MVP では使わない
E: a timeout is never re-sent	再送しない
F: the parent refuses itself as a child	self_included
F: one child means self-refutation only	Cross Check は自己反証のみ
G: the fixed warm-up text	Stand by. A research request will arrive shortly. Reply with READY.
H: an unreadable request fails before anything is sent	ambiguous_request
I: What Changed is kept even when empty	修正なし
37.1: a child that did not finish lowers coverage	Research coverage reduced:
37.4: contradictions are not merged	UNRESOLVED CONTRADICTION'

# check_skill_md <file> -- exit 0 when every literal above is present.
check_skill_md() {
  local file="$1" line rule literal oldifs missing=0
  oldifs="$IFS"
  IFS='
'
  for line in $REQUIRED; do
    IFS="$oldifs"
    rule="${line%%	*}"
    literal="${line#*	}"
    if ! grep -qF -- "$literal" "$file"; then
      printf 'SKILL.md lost %s (%s)\n' "$rule" "$literal" >&2
      missing=$((missing + 1))
    fi
    IFS='
'
  done
  IFS="$oldifs"
  [ "$missing" -eq 0 ]
}

if out=$(check_skill_md "$SKILL_MD" 2>&1); then
  pass 'SKILL.md carries every rule of the confirmed spec'
else
  fail 'SKILL.md carries every rule of the confirmed spec' "$out"
fi

# ---------------------------------------------------------------------------
# 2. The check in 1 is not a rubber stamp
# ---------------------------------------------------------------------------
printf '\n== 2. deleting any one rule from SKILL.md is caught ==\n'

oldifs="$IFS"
IFS='
'
for line in $REQUIRED; do
  IFS="$oldifs"
  rule="${line%%	*}"
  literal="${line#*	}"
  mutations=$((mutations + 1))
  copy="$WORK/SKILL.mutated.md"
  LITERAL="$literal" awk 'BEGIN { needle = ENVIRON["LITERAL"] } index($0, needle) == 0 { print }' \
    "$SKILL_MD" > "$copy"
  if cmp -s "$SKILL_MD" "$copy"; then
    fail "$rule" "the mutation removed nothing: literal not found ($literal)"
  elif check_skill_md "$copy" >/dev/null 2>&1; then
    fail "$rule" "a SKILL.md without '$literal' was accepted"
  else
    pass "$rule"
  fi
  IFS='
'
done
IFS="$oldifs"

# ---------------------------------------------------------------------------
# 3. No runnable snippet answers for a child
# ---------------------------------------------------------------------------
printf '\n== 3. no fenced snippet in the package answers a prompt, arms auto-yes or opens a relay ==\n'

# scan_snippets <file>... -- print every offending line inside ``` fences.
scan_snippets() {
  awk '
    /^[[:space:]]*```/ { inside = !inside; next }
    inside && (/commandmate[[:space:]]+(respond|auto-yes|interrupt)([[:space:]]|$)/ \
               || /--auto-yes/ || /--async/ || /--reply-to/) {
      printf "%s:%d: %s\n", FILENAME, FNR, $0
    }
  ' "$@"
}

hits=$(scan_snippets "$SKILL_MD" "$SKILL_DIR"/references/*.md)
if [ -z "$hits" ]; then
  pass 'no snippet in SKILL.md or references/ reaches respond / auto-yes / interrupt / a relay'
else
  fail 'no snippet in SKILL.md or references/ reaches respond / auto-yes / interrupt / a relay' "$hits"
fi

# The scan has to be able to see one.
mutations=$((mutations + 1))
planted="$WORK/planted.md"
printf 'prose may say respond\n\n```bash\ncommandmate respond wt-a "1" --instance codex\n```\n' > "$planted"
if [ -n "$(scan_snippets "$planted")" ]; then
  pass 'a planted respond inside a fence is found'
else
  fail 'a planted respond inside a fence is found' 'scan_snippets returned nothing'
fi
printf 'prose may say respond and --async outside a fence\n' > "$planted"
if [ -z "$(scan_snippets "$planted")" ]; then
  pass 'prose outside a fence is not mistaken for a command'
else
  fail 'prose outside a fence is not mistaken for a command' 'scan_snippets flagged prose'
fi

# ---------------------------------------------------------------------------
# 4. The run-dir checker and the fixture
# ---------------------------------------------------------------------------
printf '\n== 4. check_run.py --selftest (package templates, fixture runs, mutations, AC-16 variants) ==\n'

if ! command -v python3 >/dev/null 2>&1; then
  fail 'python3 is available' 'the run-dir checker needs python3 (standard library only)'
elif out=$(python3 "$SUITE_DIR/check_run.py" --selftest 2>&1); then
  printf '%s\n' "$out" | sed 's/^/  /'
  pass 'check_run.py --selftest'
else
  printf '%s\n' "$out" | sed 's/^/  /'
  fail 'check_run.py --selftest' 'see the FAIL lines above'
fi

# ---------------------------------------------------------------------------
# 5. SKILL.md survives the slash arguments
# ---------------------------------------------------------------------------
printf '\n== 5. SKILL.md holds nothing Claude rewrites with the slash arguments ==\n'

# Claude Code hands the SKILL.md body to the model only after replacing a
# dollar sign followed by a digit (0-based positional argument) and
# $ARGUMENTS with the arguments of `/cmate-workspace-research <args>`
# (measured on 2.1.268, Issue #247). 0.1.0 wrote the background ask as a shell
# function, and its "$1" reached the parent as the agents list. An index past
# the last argument is left alone, so the damage depends on how many arguments
# the user typed: no fixture run can show it, only the file itself. Only
# SKILL.md is scanned -- it is the body the slash invocation hands over.
scan_substituted() {
  awk '/\$[0-9]/ || /\$ARGUMENTS/ { printf "%s:%d: %s\n", FILENAME, FNR, $0 }' "$@"
}

hits=$(scan_substituted "$SKILL_MD")
if [ -z "$hits" ]; then
  pass 'SKILL.md has no positional-argument or ARGUMENTS placeholder'
else
  fail 'SKILL.md has no positional-argument or ARGUMENTS placeholder' "$hits"
fi

# The scan has to be able to see each form.
planted="$WORK/SKILL.planted.md"
for form in '"$1"' '$ARGUMENTS'; do
  mutations=$((mutations + 1))
  { cat "$SKILL_MD"; printf '\n```bash\ncommandmate ask %s --instance x y\n```\n' "$form"; } > "$planted"
  if [ -n "$(scan_substituted "$planted")" ]; then
    pass "a planted $form in a copy of SKILL.md is found"
  else
    fail "a planted $form in a copy of SKILL.md is found" 'scan_substituted returned nothing'
  fi
done

# ---------------------------------------------------------------------------
printf '\n%s passed, %s failed (%s mutations exercised here; check_run.py counts its own)\n' \
  "$passed" "$failed" "$mutations"
[ "$failed" -eq 0 ] || exit 1
exit 0
