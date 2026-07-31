#!/usr/bin/env bash
# Regression tests for the cmate-orchestrate-monitor decision core.
#
#   bash tests/fixtures/cmate-orchestrate-monitor/run_tests.sh
#
# Every case here failed before the guard it names existed. They are the reason
# the package can claim "no misreport": the classification, the intervention
# conditions and the completion decision are pinned against raw `capture --json`
# payloads, not against hand-written approximations of them (see README.md).
#
# Requires bash, git and the standard POSIX tools. No network, no npm, no tmux:
# the launcher and tmux are replaced by shims, so the loop is exercised without
# touching a real session.
set -u

SUITE_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SUITE_DIR/../../.." && pwd)
SCRIPTS="$REPO_ROOT/skills/cmate-orchestrate-monitor/scripts"
FIXTURES="$SUITE_DIR/fixtures"

MONITOR="$SCRIPTS/monitor.sh"
CLASSIFY="$SCRIPTS/classify-state.sh"
VERIFY="$SCRIPTS/verify-completion.sh"
SCOPE="$SCRIPTS/verify-scope.sh"
GATE="$SCRIPTS/quality-gate.sh"
HOOKS_GIT="$SCRIPTS/hooks-git.sh"

WORK=$(mktemp -d -t cmate-monitor-tests.XXXXXX)
trap 'rm -rf "$WORK"' EXIT INT TERM

passed=0
failed=0

# check <name> <expected> <actual>
check() {
  if [ "$2" = "$3" ]; then
    passed=$((passed + 1))
    printf 'ok   %s\n' "$1"
  else
    failed=$((failed + 1))
    printf 'FAIL %s\n     expected: %s\n     actual:   %s\n' "$1" "$2" "$3"
  fi
}

# check_contains <name> <needle> <haystack>
check_contains() {
  case "$3" in
    *"$2"*) passed=$((passed + 1)); printf 'ok   %s\n' "$1" ;;
    *) failed=$((failed + 1)); printf 'FAIL %s\n     missing: %s\n     in:\n%s\n' "$1" "$2" "$3" ;;
  esac
}

# check_lacks <name> <needle> <haystack>
check_lacks() {
  case "$3" in
    *"$2"*) failed=$((failed + 1)); printf 'FAIL %s\n     unexpected: %s\n     in:\n%s\n' "$1" "$2" "$3" ;;
    *) passed=$((passed + 1)); printf 'ok   %s\n' "$1" ;;
  esac
}

echo "== bash syntax =="
for script in "$SCRIPTS"/*.sh; do
  out=$(bash -n "$script" 2>&1)
  check "bash -n $(basename "$script")" "" "$out"
done

echo
echo "== classify-state on real capture --json shapes =="
classify() { bash "$CLASSIFY" --json "$FIXTURES/$1"; }

check "not-running.json -> NOT_RUNNING"            NOT_RUNNING "$(classify not-running.json)"
check "generating-token-anchor.json -> GENERATING" GENERATING  "$(classify generating-token-anchor.json)"
# The text anchor, not the isGenerating field, is the reliable "still busy" signal.
check "generating-bg-agent.json -> GENERATING"     GENERATING  "$(classify generating-bg-agent.json)"
# Anchor trap: `[0-9]+m [0-9]+s` would match the completion summary `Brewed for
# 8m 55s` and pin a finished session as generating forever.
check "idle-brewed-summary.json -> IDLE"           IDLE        "$(classify idle-brewed-summary.json)"
check "prompt-yes-no.json -> PROMPT"               PROMPT      "$(classify prompt-yes-no.json)"
# `❯ 1. Submit answers` is not flagged as isPromptWaiting by the product, so a
# text-marker check is required or a blocked question reads as idle.
check "prompt-submit-answers.json -> PROMPT"       PROMPT      "$(classify prompt-submit-answers.json)"
check "rate-limit.json -> RATE_LIMIT"              RATE_LIMIT  "$(classify rate-limit.json)"

echo
echo "== classify-state on live ANSI captures (CommandMate issue 1522) =="
# Defect 1: the live TUI emits the arrow, a colour reset, then the count, so
# `↓ [0-9]` grepped over the raw JSON never matched and every generating worker
# was reported IDLE / NOT_STARTED.
check "live-generating-token.json -> GENERATING"    GENERATING "$(classify live-generating-token.json)"
# Defect 2: a worker thinking before its first token has no counter; the footer
# hint `esc to interrupt` is the only signal.
check "live-generating-pre-token.json -> GENERATING" GENERATING "$(classify live-generating-pre-token.json)"
# Defect 3: the CLI's own 5xx backoff is a live session. Intervening queues the
# keystroke instead of resuming.
check "live-retrying-529.json -> GENERATING"        GENERATING "$(classify live-retrying-529.json)"
# Defect 4: once the retries are exhausted the stale `attempt 10/10` line must
# not read as alive, or the resend path can never fire.
check "live-api-error-exhausted.json -> IDLE"       IDLE       "$(classify live-api-error-exhausted.json)"
# Defect 5, as it happened: the first poll returns the whole buffer including the
# task text, which mentioned rate limits; the old bare anchor matched it and the
# loop typed `a` into two healthy workers.
check "live-generating-task-text-scrollback.json -> GENERATING" GENERATING "$(classify live-generating-task-text-scrollback.json)"
# Defect 5, ordering half: fails if RATE_LIMIT is ever moved ahead of GENERATING.
check "live-generating-rate-limit-source.json -> GENERATING" GENERATING "$(classify live-generating-rate-limit-source.json)"
# Defect 5, anchor half: an idle pane showing rate-limiter source has no
# GENERATING branch to rescue it, so this fails unless the anchor is limited to
# product banner wording.
check "live-idle-rate-limit-source.json -> IDLE"    IDLE       "$(classify live-idle-rate-limit-source.json)"
check "live-idle.json -> IDLE"                      IDLE       "$(classify live-idle.json)"

echo
echo "== fixture fidelity (the root cause of issue 1522 was a bad fixture) =="
live_count=$(ls "$FIXTURES"/live-*.json 2>/dev/null | wc -l | tr -d '[:space:]')
if [ "$live_count" -ge 7 ]; then
  passed=$((passed + 1)); printf 'ok   at least 7 live fixtures present (%s)\n' "$live_count"
else
  failed=$((failed + 1)); printf 'FAIL live fixture glob is empty or short (%s)\n' "$live_count"
fi

for fixture in "$FIXTURES"/live-*.json; do
  name=$(basename "$fixture")
  if grep -q '\\u001b\[[0-9;]*m' "$fixture"; then
    passed=$((passed + 1)); printf 'ok   %s carries JSON-escaped ANSI\n' "$name"
  else
    failed=$((failed + 1)); printf 'FAIL %s has had its ANSI stripped\n' "$name"
  fi
  # ml_json_scalar anchors on exactly two spaces of indent for top-level keys,
  # which is what `JSON.stringify(payload, null, 2)` produces.
  if grep -q '^  "isRunning":' "$fixture"; then
    passed=$((passed + 1)); printf 'ok   %s keeps the pretty-printed capture shape\n' "$name"
  else
    failed=$((failed + 1)); printf 'FAIL %s is not the shape capture --json emits\n' "$name"
  fi
  if grep -qE 'session_01[A-Za-z0-9]+|github_kewton' "$fixture"; then
    failed=$((failed + 1)); printf 'FAIL %s carries an unsanitized session id or checkout path\n' "$name"
  else
    passed=$((passed + 1)); printf 'ok   %s is sanitized\n' "$name"
  fi
done

for fixture in live-generating-token.json live-generating-task-text-scrollback.json live-generating-rate-limit-source.json; do
  # The counter must stay ANSI-split, which is precisely why the pre-1522 anchor
  # `↓ [0-9]` found nothing.
  if grep -q '↓\\u001b\[' "$FIXTURES/$fixture" && ! grep -qE '↓ ?[0-9]' "$FIXTURES/$fixture"; then
    passed=$((passed + 1)); printf 'ok   %s keeps the token counter ANSI-split\n' "$fixture"
  else
    failed=$((failed + 1)); printf 'FAIL %s no longer defeats a naive grep\n' "$fixture"
  fi
done

echo
echo "== verify-completion STARTED guard =="
verify() { bash "$VERIFY" "$@"; }

check "unstarted + idle + no work -> NOT_STARTED" NOT_STARTED \
  "$(verify --started 0 --state IDLE --idle-streak 10 --idle-threshold 5 --commits 0 --uncommitted 0)"
check "started + idle + commits -> COMPLETE" COMPLETE \
  "$(verify --started 1 --state IDLE --idle-streak 10 --idle-threshold 5 --commits 2 --uncommitted 0)"
check "uncommitted-only work counts as completion" COMPLETE \
  "$(verify --started 1 --state IDLE --idle-streak 8 --idle-threshold 5 --commits 0 --uncommitted 3)"
check "started + idle + zero work -> NOT_STARTED" NOT_STARTED \
  "$(verify --started 1 --state IDLE --idle-streak 10 --idle-threshold 5 --commits 0 --uncommitted 0)"
check "generating stays WORKING" WORKING \
  "$(verify --started 1 --state GENERATING --idle-streak 0 --idle-threshold 5 --commits 1 --uncommitted 1)"
check "below the idle threshold stays WORKING" WORKING \
  "$(verify --started 1 --state IDLE --idle-streak 2 --idle-threshold 5 --commits 1 --uncommitted 0)"

echo
echo "== verify-completion: task state is the primary source (Issue #1589) =="
# The six acceptance cases: five task statuses plus the task-absent fallback.
# Every terminal case is fed inputs whose *heuristic* verdict differs from the
# expected one, so a green here cannot come from the fallback path happening to
# agree. The ordering pinned below is CommandMate #1581's, deliberately identical:
#   live pane state -> adjudicated task status -> STARTED guard -> idle + work.

# 1/6 succeeded: the gates already ran server-side, so no commit corroboration is
# needed. Heuristics alone would say WORKING (streak below threshold).
check "1/6 task succeeded -> COMPLETE (heuristics alone would say WORKING)" COMPLETE \
  "$(verify --started 1 --state IDLE --idle-streak 0 --idle-threshold 5 --commits 0 --uncommitted 0 --task-status succeeded)"

# 2/6 failed: the case the whole change exists for. Idle with commits is exactly
# what the old core called COMPLETE — "the worker stopped" is not "the work is good".
check "2/6 task failed -> VERIFY_FAILED (heuristics alone would say COMPLETE)" VERIFY_FAILED \
  "$(verify --started 1 --state IDLE --idle-streak 10 --idle-threshold 5 --commits 3 --uncommitted 0 --task-status failed)"

# 3/6 not_started: work exists on disk but the server never saw the task start.
check "3/6 task not_started -> NOT_STARTED (heuristics alone would say COMPLETE)" NOT_STARTED \
  "$(verify --started 1 --state IDLE --idle-streak 10 --idle-threshold 5 --commits 3 --uncommitted 0 --task-status not_started)"

# 4/6 running: non-terminal, so it does not rule — it falls through to the
# heuristics. Both halves are pinned because the fall-through is the point:
# a short-circuit to WORKING would blind the STARTED guard, which is the only
# thing that catches "the CLI marked it running but Enter never landed".
check "4/6 task running -> WORKING below the idle threshold" WORKING \
  "$(verify --started 1 --state IDLE --idle-streak 2 --idle-threshold 5 --commits 3 --uncommitted 0 --task-status running)"
check "4/6 task running falls through, it does not short-circuit" COMPLETE \
  "$(verify --started 1 --state IDLE --idle-streak 10 --idle-threshold 5 --commits 3 --uncommitted 0 --task-status running)"
check "4/6 the STARTED guard still fires under a running task" NOT_STARTED \
  "$(verify --started 0 --state IDLE --idle-streak 10 --idle-threshold 5 --commits 0 --uncommitted 0 --task-status running)"

# 5/6 verifying: same non-terminal treatment — the gates are still running.
check "5/6 task verifying -> WORKING below the idle threshold" WORKING \
  "$(verify --started 1 --state IDLE --idle-streak 2 --idle-threshold 5 --commits 3 --uncommitted 0 --task-status verifying)"
check "5/6 task verifying falls through, it does not short-circuit" COMPLETE \
  "$(verify --started 1 --state IDLE --idle-streak 10 --idle-threshold 5 --commits 3 --uncommitted 0 --task-status verifying)"

# 6/6 no task: contract-less delegation and pre-ledger CommandMate. The verdicts
# must be exactly what they were before the task source existed — both when the
# flag is empty and when it is absent entirely.
check "6/6 no task, empty flag -> capture heuristics (COMPLETE)" COMPLETE \
  "$(verify --started 1 --state IDLE --idle-streak 10 --idle-threshold 5 --commits 3 --uncommitted 0 --task-status '')"
check "6/6 no task, empty flag -> capture heuristics (NOT_STARTED)" NOT_STARTED \
  "$(verify --started 1 --state IDLE --idle-streak 10 --idle-threshold 5 --commits 0 --uncommitted 0 --task-status '')"
check "6/6 no task, flag absent -> identical verdict" COMPLETE \
  "$(verify --started 1 --state IDLE --idle-streak 10 --idle-threshold 5 --commits 3 --uncommitted 0)"
# The STARTED guard's distinctive branch, pinned here because demoting the
# heuristics must not weaken them: work on disk with the generation anchor never
# latched is "keep watching", not COMPLETE. Mutation-checked — deleting the guard
# leaves every other case in this file green.
check "6/6 the STARTED guard still holds: unlatched work is WORKING" WORKING \
  "$(verify --started 0 --state IDLE --idle-streak 10 --idle-threshold 5 --commits 2 --uncommitted 0)"

# The remaining terminal status, and the two remaining non-terminal ones.
check "task cancelled -> VERIFY_FAILED, never COMPLETE" VERIFY_FAILED \
  "$(verify --started 1 --state IDLE --idle-streak 10 --idle-threshold 5 --commits 3 --uncommitted 0 --task-status cancelled)"
check "task pending falls through to the STARTED guard" NOT_STARTED \
  "$(verify --started 0 --state IDLE --idle-streak 10 --idle-threshold 5 --commits 0 --uncommitted 0 --task-status pending)"
check "task waiting_input falls through to the heuristics" COMPLETE \
  "$(verify --started 1 --state IDLE --idle-streak 10 --idle-threshold 5 --commits 3 --uncommitted 0 --task-status waiting_input)"

# A stale terminal status must not end the watch while the pane is alive: the
# newest `succeeded` may belong to the previous send, not to this turn.
check "a live pane vetoes a stale succeeded" WORKING \
  "$(verify --started 1 --state GENERATING --idle-streak 0 --idle-threshold 5 --commits 0 --uncommitted 0 --task-status succeeded)"
check "an open prompt vetoes a stale succeeded" WORKING \
  "$(verify --started 1 --state PROMPT --idle-streak 0 --idle-threshold 5 --commits 0 --uncommitted 0 --task-status succeeded)"

# Unknown values degrade to the heuristics rather than to an undefined verdict.
# `unavailable` is hooks-task.sh's version-gate sentinel, so this is also what
# keeps it safe in front of a monitor.sh that predates it.
check "the unavailable sentinel falls through to the heuristics" COMPLETE \
  "$(verify --started 1 --state IDLE --idle-streak 10 --idle-threshold 5 --commits 3 --uncommitted 0 --task-status unavailable)"
check "an unrecognised status falls through to the heuristics" NOT_STARTED \
  "$(verify --started 1 --state IDLE --idle-streak 10 --idle-threshold 5 --commits 0 --uncommitted 0 --task-status finished)"

echo
echo "== hooks-task.sh reads the ledger through the CLI =="
# The CLI is the source, not curl: it already resolves base URL and auth token.
# Here it is a shim, so the three answers can be produced deterministically.
HOOKS_TASK="$SCRIPTS/hooks-task.sh"
TASK_SHIM_DIR="$WORK/task-shim"
mkdir -p "$TASK_SHIM_DIR"

# read_task <stdout-file> <exit-code> -> read_task_status's answer
read_task() {
  printf '#!/bin/sh\ncat %s\nexit %s\n' "$1" "$2" > "$TASK_SHIM_DIR/cm"
  chmod +x "$TASK_SHIM_DIR/cm"
  CM="$TASK_SHIM_DIR/cm" bash -c ". \"$HOOKS_TASK\"; read_task_status any-worktree" 2>/dev/null
}

# The real shape, measured 2026-07-31 against CommandMate develop: tab-separated
# id / status / agent / gates / title, newest first.
printf '58d95c4a-ef02-47b9-8411-837cb9e03040\tsucceeded\tclaude\tlint+typecheck\tRun C\n' > "$TASK_SHIM_DIR/succeeded.txt"
printf '307cff97-f3b8-4bae-8704-12460591099c\tfailed\tclaude\tlint\tRun B\n' > "$TASK_SHIM_DIR/failed.txt"
printf 'bf1201cc-dc50-4cc7-ad61-90b6c1bbdda5\tnot_started\tclaude\tlint\tRun A\n' > "$TASK_SHIM_DIR/not-started.txt"
: > "$TASK_SHIM_DIR/empty.txt"

check "a succeeded row yields its status" succeeded "$(read_task "$TASK_SHIM_DIR/succeeded.txt" 0)"
check "a failed row yields its status" failed "$(read_task "$TASK_SHIM_DIR/failed.txt" 0)"
check "a not_started row yields its status" not_started "$(read_task "$TASK_SHIM_DIR/not-started.txt" 0)"
# No tasks: the CLI writes its notice to stderr and exits 0 with empty stdout.
check "a worktree with no tasks yields nothing, not a verdict" "" "$(read_task "$TASK_SHIM_DIR/empty.txt" 0)"
# Only the newest row is consulted, whatever --limit did.
printf 'aaa\trunning\tclaude\tlint\tnewest\nbbb\tsucceeded\tclaude\tlint\tolder\n' > "$TASK_SHIM_DIR/two.txt"
check "only the newest row is read" running "$(read_task "$TASK_SHIM_DIR/two.txt" 0)"
# A changed output format must degrade to "no answer", never to a bogus verdict.
printf 'ID: 123 STATUS: succeeded\n' > "$TASK_SHIM_DIR/reformatted.txt"
check "a changed output format degrades to no answer" "" "$(read_task "$TASK_SHIM_DIR/reformatted.txt" 0)"
# The version gate. Measured non-zero exits: CommandMate 0.10.2 and published
# 0.16.0 have no `task` command (exit 1), a stopped server exits 1, an unknown
# worktree exits 99. `unavailable` is not a TaskStatus, so it can never decide.
check "a CLI without 'task' reports unavailable, not 'no tasks'" unavailable \
  "$(read_task "$TASK_SHIM_DIR/empty.txt" 1)"
check "an unknown worktree (exit 99) reports unavailable" unavailable \
  "$(read_task "$TASK_SHIM_DIR/empty.txt" 99)"
# The exit code must survive: piping the CLI into `head` would hand $? to head
# and turn every failure above into a silent "no tasks".
check "a failing CLI that still printed a row reports unavailable" unavailable \
  "$(read_task "$TASK_SHIM_DIR/succeeded.txt" 1)"

echo
echo "== verify-scope does not false-positive =="
check "prose/comment mentions are not violations" CLEAN "$(bash "$SCOPE" --file "$FIXTURES/scope-clean.txt")"
check "a real bare invocation is counted" VIOLATIONS:1 "$(bash "$SCOPE" --file "$FIXTURES/scope-violation.txt")"

echo
echo "== quality-gate judges by exit code, not by grepping output =="
check "green-looking output + exit 1 -> FAIL" FAIL:1 "$(bash "$GATE" -- bash -c 'echo "Tests 100 passed"; exit 1' 2>/dev/null)"
check "exit 0 -> PASS" PASS "$(bash "$GATE" -- bash -c 'echo "Tests 100 passed"; exit 0' 2>/dev/null)"

echo
echo "== monitor.sh loop =="
# Poll parameters: the decision core counts polls, not seconds, so --interval 0
# removes the wall clock and --max-polls ends the run from the inside. That is
# what makes the loop testable without killing it from the outside.
LOOP_ID=w1

# The fake tmux's world (Issue #1602). Plain globals rather than an env prefix on
# the call, because `VAR=x some_function` leaves VAR set afterwards in bash and a
# leaked session list would silently change a later case. Every override below
# resets them on the next line.
#   LOOP_SESSIONS       space-separated session names the fake tmux believes exist.
#                       `AUTO` = the default CommandMate builds for LOOP_ID; the
#                       empty string = no session exists at all.
#   LOOP_TMUX_SENDFAIL  exit code the fake tmux returns for `send-keys`.
LOOP_SESSIONS=AUTO
LOOP_TMUX_SENDFAIL=0

# run_loop <case-name> <polls> <fixture[,fixture...]> [extra monitor args...]
# Serves fixture N on poll N and repeats the last one afterwards. Sets
# LOOP_STDOUT / LOOP_STDERR / LOOP_STATUS / LOOP_CAPTURES / LOOP_CAPTURE_ARGS /
# LOOP_TMUX.
#
# `commandmate task ...` is answered separately from `capture` so that wiring
# hooks-task.sh cannot disturb the fixture sequence: LOOP_TASK_OUT (a file, empty
# by default) is the stdout and LOOP_TASK_EXIT (0 by default) the exit code, and
# neither advances the capture counter. Runs that never source hooks-task.sh
# never reach that branch, so their capture log is byte-identical to before.
#
# The fake tmux answers `has-session` from LOOP_SESSIONS instead of exiting 0 for
# everything. A shim that accepts every target cannot tell a delivered
# intervention from a misdirected one — which is exactly the blindness #1602 was
# hiding in production, so a green suite against such a shim proves nothing.
run_loop() {
  loop_case=$1; loop_polls=$2; loop_fixtures=$3; shift 3
  loop_dir="$WORK/$loop_case"
  mkdir -p "$loop_dir"
  loop_capture_log="$loop_dir/capture.log"
  loop_tmux_log="$loop_dir/tmux.log"
  : > "$loop_capture_log"
  : > "$loop_tmux_log"
  cp "${LOOP_TASK_OUT:-/dev/null}" "$loop_dir/task-out"
  printf '%s\n' "${LOOP_TASK_EXIT:-0}" > "$loop_dir/task-exit"

  {
    echo '#!/bin/sh'
    echo "printf '%s\\n' \"\$*\" >> \"$loop_capture_log\""
    echo 'case "$1" in'
    echo "  task) cat \"$loop_dir/task-out\"; exit \"\$(cat \"$loop_dir/task-exit\")\" ;;"
    echo 'esac'
    echo "n=\$(cat \"$loop_dir/counter\" 2>/dev/null || echo 0)"
    echo 'n=$((n + 1))'
    echo "echo \"\$n\" > \"$loop_dir/counter\""
    echo 'case "$n" in'
    loop_index=0
    loop_total=0
    for loop_fixture in $(printf '%s' "$loop_fixtures" | tr ',' ' '); do
      loop_total=$((loop_total + 1))
    done
    for loop_fixture in $(printf '%s' "$loop_fixtures" | tr ',' ' '); do
      loop_index=$((loop_index + 1))
      if [ "$loop_index" -eq "$loop_total" ]; then
        echo "  *) cat \"$FIXTURES/$loop_fixture\" ;;"
      else
        echo "  $loop_index) cat \"$FIXTURES/$loop_fixture\" ;;"
      fi
    done
    echo 'esac'
  } > "$loop_dir/fake-cm"

  if [ "$LOOP_SESSIONS" = AUTO ]; then
    loop_sessions="mcbd-claude-${LOOP_ID%%@*}"
  else
    loop_sessions=$LOOP_SESSIONS
  fi
  {
    echo '#!/bin/sh'
    echo "printf '%s\\n' \"\$*\" >> \"$loop_tmux_log\""
    echo "sessions='$loop_sessions'"
    # Target resolution is modelled the way REAL tmux resolves it, because that
    # asymmetry is the whole of #1602's 4th point: `=<name>:` matches exactly,
    # while a bare `<name>` falls back to prefix matching when nothing matches
    # exactly. Measured on real tmux 2026-08-01:
    #   send-keys -t zzprobe-w1      -> accepted; zzprobe-w1-2 received the keys
    #   send-keys -t '=zzprobe-w1:'  -> "can't find session"
    # A shim that only ever matched exactly would let a bare target pass this
    # suite, i.e. it would be green against the very bug being fixed.
    echo 'if [ "$1" = "has-session" ]; then'
    echo '  t=$3'
    echo '  case "$t" in'
    echo '    =*) t=${t#=}; t=${t%:}; exact=1 ;;'
    echo '    *) exact=0 ;;'
    echo '  esac'
    echo '  for s in $sessions; do'
    echo '    if [ "$s" = "$t" ]; then exit 0; fi'
    echo '  done'
    echo '  if [ "$exact" = 0 ]; then'
    echo '    for s in $sessions; do'
    echo '      case "$s" in "$t"*) exit 0 ;; esac'
    echo '    done'
    echo '  fi'
    echo '  exit 1'
    echo 'fi'
    echo "if [ \"\$1\" = \"send-keys\" ]; then exit $LOOP_TMUX_SENDFAIL; fi"
    echo 'exit 0'
  } > "$loop_dir/tmux"
  chmod +x "$loop_dir/fake-cm" "$loop_dir/tmux"

  LOOP_STDOUT=$(PATH="$loop_dir:$PATH" CM="$loop_dir/fake-cm" \
    bash "$MONITOR" --interval 0 --idle-threshold 1 --max-polls "$loop_polls" "$@" "$LOOP_ID" \
    2> "$loop_dir/stderr")
  LOOP_STATUS=$?
  LOOP_STDERR=$(cat "$loop_dir/stderr")
  LOOP_CAPTURES=$(grep -c . "$loop_capture_log" || true)
  LOOP_CAPTURE_ARGS=$(cat "$loop_capture_log")
  LOOP_TMUX=$(cat "$loop_tmux_log")
}

# The stock stream is interventions and terminal verdicts only. Pinned
# byte-for-byte: --verbose is only allowed to *add* to it.
run_loop default-stream 3 live-generating-token.json,live-idle.json
check "default run polls 3 times" 3 "$LOOP_CAPTURES"
check "default run exits 0" 0 "$LOOP_STATUS"
# The `intervention target` line is new in this version (Issue #1602) and is
# deliberately part of the DEFAULT stream, not of --verbose: which pane the loop
# would type into is otherwise invisible until the first intervention is needed,
# and by then a missed approval has already stalled the worker.
expected_default=$(cat <<'EOF'
monitor: watching 1 worker(s), interval=0s, idle-threshold=1, max-resends=2
monitor[w1]: intervention target = mcbd-claude-w1
monitor[w1]: NOT_STARTED — idle with no work; check the composer / Enter
monitor[w1]: NOT_STARTED — idle with no work; check the composer / Enter
monitor: reached --max-polls (3) after 3 poll round(s); stopping
EOF
)
check "default stdout is unchanged by the --verbose feature" "$expected_default" "$LOOP_STDOUT"
# The control arm for the hook cases below: with the stub counters, COMPLETE is
# structurally unreachable.
check_lacks "stub counters never reach COMPLETE" "COMPLETE" "$LOOP_STDOUT"

run_loop verbose-stream 3 live-generating-token.json,live-idle.json --verbose
check "verbose run polls 3 times" 3 "$LOOP_CAPTURES"
poll_lines=$(printf '%s\n' "$LOOP_STDOUT" | grep -E '^monitor\[w1\]: poll [0-9]+ -> ')
check "one poll line per poll" 3 "$(printf '%s\n' "$poll_lines" | grep -c .)"
check "poll 1 records the inputs the verdict was made from" \
  "monitor[w1]: poll 1 -> GENERATING started=1 streak=0 commits=0 uncommitted=0 verdict=WORKING" \
  "$(printf '%s\n' "$poll_lines" | sed -n 1p)"
check "poll 3 records the climbing idle streak" \
  "monitor[w1]: poll 3 -> IDLE started=1 streak=2 commits=0 uncommitted=0 verdict=NOT_STARTED" \
  "$(printf '%s\n' "$poll_lines" | sed -n 3p)"
check "state distribution is recoverable from the log" \
  "1 GENERATING
2 IDLE" \
  "$(printf '%s\n' "$LOOP_STDOUT" | grep -oE 'poll [0-9]+ -> [A-Z_]+' | awk '{print $4}' | sort | uniq -c | sed 's/^ *//')"
check "verbose stdout minus the poll lines equals the default stdout" \
  "$expected_default" \
  "$(printf '%s\n' "$LOOP_STDOUT" | grep -vE '^monitor\[w1\]: poll [0-9]+ -> ')"

# Hooks: the same run reaches COMPLETE once real counters are supplied.
printf 'count_commits() { echo 2; }\ncount_uncommitted() { echo 5; }\n' > "$WORK/hooks-both.sh"
run_loop hooks-both 5 live-generating-token.json,live-idle.json --verbose --hooks "$WORK/hooks-both.sh"
check "hooked run stops at the completing poll" 2 "$LOOP_CAPTURES"
check_contains "hooked run reports COMPLETE" "monitor[w1]: COMPLETE (approvals=0)" "$LOOP_STDOUT"
check_contains "hooked run ends by completion, not by --max-polls" "monitor: all 1 worker(s) complete" "$LOOP_STDOUT"
check_lacks "hooked run does not hit --max-polls" "reached --max-polls" "$LOOP_STDOUT"
check "the completing poll carries the counter values it decided on" \
  "monitor[w1]: poll 2 -> IDLE started=1 streak=1 commits=2 uncommitted=5 verdict=COMPLETE" \
  "$(printf '%s\n' "$LOOP_STDOUT" | grep -E '^monitor\[w1\]: poll 2 ')"

# A hooks file may define one counter and leave the other stubbed.
printf 'count_uncommitted() { echo 3; }\n' > "$WORK/hooks-partial.sh"
MONITOR_HOOKS="$WORK/hooks-partial.sh" run_loop hooks-env 5 live-generating-token.json,live-idle.json --verbose
check "MONITOR_HOOKS from the environment is honoured, partial file included" \
  "monitor[w1]: poll 2 -> IDLE started=1 streak=1 commits=0 uncommitted=3 verdict=COMPLETE" \
  "$(printf '%s\n' "$LOOP_STDOUT" | grep -E '^monitor\[w1\]: poll 2 ')"

# Silently falling back to the stubs would produce "every worker NOT_STARTED",
# which looks plausible and is a lie.
run_loop hooks-missing 1 live-idle.json --hooks /nonexistent/hooks.sh
check "a missing hooks file fails loudly" 2 "$LOOP_STATUS"
check "a missing hooks file polls nothing" 0 "$LOOP_CAPTURES"
check_contains "a missing hooks file says so" "hooks file not found" "$LOOP_STDERR"

echo
echo "== monitor.sh interventions =="
# Retry exhaustion: resend once, then escalate instead of typing forever.
run_loop resend 2 live-api-error-exhausted.json --max-resends 1 --resend-message 'resume please'
check "resend run polls twice" 2 "$LOOP_CAPTURES"
check_contains "resends after the CLI gave up" "resent to mcbd-claude-w1 (1/1)" "$LOOP_STDOUT"
check_contains "escalates once the budget is spent" "resend budget spent" "$LOOP_STDOUT"
check "resend types the message exactly once" "send-keys -t =mcbd-claude-w1: resume please Enter" \
  "$(printf '%s\n' "$LOOP_TMUX" | grep send-keys)"

# The production harm: input sent mid-backoff is queued and delivered later.
run_loop backoff 3 live-retrying-529.json
check "backoff run polls 3 times" 3 "$LOOP_CAPTURES"
check "never types into a worker inside its own backoff" "" "$LOOP_TMUX"
check_lacks "backoff is not read as a rate limit" "rate limit" "$LOOP_STDOUT"
check_lacks "backoff is not read as idle" "NOT_STARTED" "$LOOP_STDOUT"

# The 5th defect at loop level: this frame used to classify RATE_LIMIT and get an
# `a` typed into it.
run_loop healthy-rate-limit-source 3 live-generating-rate-limit-source.json
check "healthy-source run polls 3 times" 3 "$LOOP_CAPTURES"
check "never types into a healthy worker whose pane shows rate-limiter source" "" "$LOOP_TMUX"

# …while a genuine banner is still acted on immediately.
run_loop real-rate-limit 1 rate-limit.json
check_contains "acts on a genuine usage-limit banner" "rate limit -> sent 'a' to mcbd-claude-w1" "$LOOP_STDOUT"
check "sends 'a' once" "send-keys -t =mcbd-claude-w1: a Enter" \
  "$(printf '%s\n' "$LOOP_TMUX" | grep send-keys)"

echo
echo "== session-name derivation (Issue #1602) =="
# Unit level. `cm-<worktree-id>` addressed a session that has never existed, so
# every intervention was a no-op that the log reported as a success. The name is
# now derived from the capture payload's cliToolId, the same way the product
# builds it (BaseCLITool.getSessionName).
mlib() { bash -c ". \"$SCRIPTS/monitor-lib.sh\"; $1" 2>/dev/null; }

# The list is what resolves `--agent` for a `<id>@<instance>` spec. A drifted list
# silently puts the CAPTURE on the wrong pane, so it is pinned against the
# product's CLI_TOOL_IDS (src/lib/cli-tools/types.ts, measured 2026-08-01).
check "the CLI tool id list matches the product's" \
  "claude codex gemini vibe-local opencode copilot antigravity" \
  "$(mlib 'printf "%s" "$ML_CLI_TOOL_IDS"')"

check "the primary session is mcbd-<cliToolId>-<worktree-id>" "mcbd-claude-w1" \
  "$(mlib 'ml_session_name w1 claude "" ""')"
check "a codex worker gets a codex session, with no flag" "mcbd-codex-w1" \
  "$(mlib 'ml_session_name w1 codex "" ""')"
# deriveSessionSuffix: `claude-2` yields `2`, not `claude-2`.
check "a named instance appends only its suffix" "mcbd-claude-w1-2" \
  "$(mlib 'ml_session_name w1 claude claude-2 ""')"
check "the primary instance id is not a suffix" "mcbd-claude-w1" \
  "$(mlib 'ml_session_name w1 claude claude ""')"
# `vibe-local` contains a hyphen, so an id may not be cut at the first one.
check "a hyphenated tool id is not cut at its hyphen" "mcbd-vibe-local-w1-3" \
  "$(mlib 'ml_session_name w1 vibe-local vibe-local-3 ""')"
check "an instance id from another tool keeps its own tool's session" "mcbd-codex-w1-2" \
  "$(mlib 'ml_session_name w1 codex codex-2 ""')"
# Refusing beats inventing: a wrong name is what #1602 was.
check "no cliToolId and no override derives nothing" "" \
  "$(mlib 'ml_session_name w1 "" "" ""')"
check "…and says so with a non-zero exit" 1 \
  "$(mlib 'ml_session_name w1 "" "" "" >/dev/null; printf "%s" $?')"
# The escape hatch replaces the derived head ONLY. A plain `<prefix>-<id>`
# concatenation would re-point `w1@codex-2` at its primary's pane — the same
# misdelivery, reintroduced through the flag meant to work around it.
check "--session-prefix replaces the head but keeps the instance suffix" "zz-w1-2" \
  "$(mlib 'ml_session_name w1 codex codex-2 zz')"
check "--session-prefix on a primary is the plain concatenation" "zz-w1" \
  "$(mlib 'ml_session_name w1 claude "" zz')"

check "an instance id resolves to its CLI tool" "codex" "$(mlib 'ml_agent_from_instance codex-2')"
check "a bare tool id resolves to itself" "claude" "$(mlib 'ml_agent_from_instance claude')"
check "the longest tool id wins" "vibe-local" "$(mlib 'ml_agent_from_instance vibe-local-2')"
check "an unknown instance resolves to nothing" "" "$(mlib 'ml_agent_from_instance mystery-2')"
check "…and exits non-zero so the caller can omit --agent" 1 \
  "$(mlib 'ml_agent_from_instance mystery-2 >/dev/null; printf "%s" $?')"

# `=name:` is the exact-match specifier. Measured on real tmux 2026-08-01: a bare
# `-t zzprobe-w1` was accepted and delivered to `zzprobe-w1-2`, while
# `-t '=zzprobe-w1:'` failed with "can't find session".
check "the tmux target is the exact-match specifier" "=mcbd-claude-w1:" \
  "$(mlib 'ml_tmux_target mcbd-claude-w1')"

echo
echo "== monitor.sh types into the session CommandMate actually creates (Issue #1602) =="
# Acceptance 1/5: the default, with no flag at all, reaches mcbd-claude-<id>.
run_loop target-default 1 rate-limit.json
check "the default target is derived from the payload, not from a prefix" "mcbd-claude-w1" \
  "$(printf '%s\n' "$LOOP_STDOUT" | sed -n 's/^monitor\[w1\]: intervention target = //p')"
check "every tmux call uses the exact-match specifier" \
  "has-session -t =mcbd-claude-w1:
send-keys -t =mcbd-claude-w1: a Enter" "$LOOP_TMUX"
check_lacks "the pre-#1602 cm- prefix is gone" "cm-w1" "$LOOP_TMUX"

# Acceptance 5/5, the leak that survives a merely-corrected name: only the `-2`
# instance is running. A bare `-t mcbd-claude-w1` falls back to prefix matching
# and delivers the keys to `mcbd-claude-w1-2`; `=mcbd-claude-w1:` refuses.
LOOP_SESSIONS="mcbd-claude-w1-2"
run_loop target-prefix-leak 1 rate-limit.json
LOOP_SESSIONS=AUTO
# The fake tmux resolves a bare target by prefix, so this is the real leak, not a
# string comparison: drop the `=`…`:` and the has-session below succeeds against
# mcbd-claude-w1-2 and a send-keys line appears.
check "a stopped primary does not leak into its -2 instance" "has-session -t =mcbd-claude-w1:" "$LOOP_TMUX"
check_contains "the miss is reported" "NOT delivered — no tmux session 'mcbd-claude-w1'" "$LOOP_STDERR"

# Acceptance 3/5: a send to a session that does not exist is detected, not
# swallowed — and it never appears in the intervention stream as a success.
LOOP_SESSIONS=""
run_loop target-missing 1 rate-limit.json
LOOP_SESSIONS=AUTO
check_contains "a missing session is reported on stderr" \
  "monitor[w1]: rate limit 'a' NOT delivered — no tmux session 'mcbd-claude-w1'" "$LOOP_STDERR"
check_contains "the report is actionable" "check 'tmux ls'" "$LOOP_STDERR"
check_lacks "an undelivered intervention is never claimed on stdout" "sent 'a'" "$LOOP_STDOUT"
check "nothing is typed" "has-session -t =mcbd-claude-w1:" "$LOOP_TMUX"

# The third failure mode: the session exists and tmux still refuses the keys.
LOOP_TMUX_SENDFAIL=1
run_loop target-sendfail 1 rate-limit.json
LOOP_TMUX_SENDFAIL=0
check_contains "a refused send-keys is reported too" \
  "NOT delivered — tmux send-keys to 'mcbd-claude-w1' failed" "$LOOP_STDERR"
check_lacks "a refused send is not claimed as sent" "sent 'a'" "$LOOP_STDOUT"

# Acceptance 4/5: a payload with no cliToolId and no override refuses to invent a
# name rather than typing into whatever `cm-w1` happens to match.
run_loop target-no-tool 1 no-clitoolid-rate-limit.json
check_contains "a payload without cliToolId refuses to guess" \
  "NOT delivered — no tmux session could be derived" "$LOOP_STDERR"
check "nothing is typed when no name can be derived" "" "$LOOP_TMUX"
check_lacks "and no target is announced" "intervention target" "$LOOP_STDOUT"

# Acceptance 2/5: a non-default instance. `--agent` is recovered from the instance
# id because the server resolves the tool from the worktree row otherwise, which
# would poll mcbd-claude-w1-codex-2 — a pane that does not exist. Capture and
# intervention therefore move together, onto mcbd-codex-w1-2.
LOOP_ID="w1@codex-2"
LOOP_SESSIONS="mcbd-codex-w1-2"
run_loop target-instance 1 codex-rate-limit.json
check "the instance selects the polled pane" "capture w1 --json --agent codex --instance codex-2" \
  "$LOOP_CAPTURE_ARGS"
check "…and the pane that is typed into" \
  "has-session -t =mcbd-codex-w1-2:
send-keys -t =mcbd-codex-w1-2: a Enter" "$LOOP_TMUX"
check_contains "state and log lines are keyed by <id>@<instance>" \
  "monitor[w1@codex-2]: rate limit -> sent 'a' to mcbd-codex-w1-2" "$LOOP_STDOUT"

# The escape hatch at loop level: the head is replaced, the instance suffix is not.
LOOP_SESSIONS="zz-w1-2"
run_loop target-prefix-instance 1 codex-rate-limit.json --session-prefix zz
LOOP_ID=w1
LOOP_SESSIONS=AUTO
check "--session-prefix does not re-point an instance at its primary" \
  "has-session -t =zz-w1-2:
send-keys -t =zz-w1-2: a Enter" "$LOOP_TMUX"

# Both ids are interpolated into a tmux target, so they are validated before the
# loop starts rather than by whatever tmux makes of them.
bad_status=0
bad_out=$(bash "$MONITOR" --max-polls 1 'w1@' 2>&1) || bad_status=$?
check "an empty instance id is rejected" 2 "$bad_status"
check_contains "…and says which spec was wrong" "'w1@' has no instance id after '@'" "$bad_out"
bad_status=0
bad_out=$(bash "$MONITOR" --max-polls 1 'w1;rm' 2>&1) || bad_status=$?
check "an id that is not safe to interpolate into a tmux target is rejected" 2 "$bad_status"
check_contains "…and names the expected shape" "expected [a-zA-Z0-9][a-zA-Z0-9_-]*" "$bad_out"

echo
echo "== counters and budgets move only on a delivered intervention (Issue #1602) =="
# `approvals=` on the COMPLETE line is the skill's evidence that prompts were
# answered. Before #1602 it counted attempts at a session that never existed, so
# a run that approved nothing reported approvals it had never made. Paired arms:
# same fixtures, same hooks — only whether the session exists differs.
printf 'count_commits() { echo 2; }\ncount_uncommitted() { echo 5; }\n' > "$WORK/hooks-both.sh"
APPROVAL_FIXTURES=live-generating-token.json,prompt-yes-no.json,live-idle.json

run_loop approvals-delivered 5 "$APPROVAL_FIXTURES" --hooks "$WORK/hooks-both.sh"
check_contains "a delivered Enter is counted" "monitor[w1]: COMPLETE (approvals=1)" "$LOOP_STDOUT"
check "the approval is a real Enter to the derived session" \
  "send-keys -t =mcbd-claude-w1: Enter" "$(printf '%s\n' "$LOOP_TMUX" | grep send-keys)"

LOOP_SESSIONS=""
run_loop approvals-undelivered 5 "$APPROVAL_FIXTURES" --hooks "$WORK/hooks-both.sh"
LOOP_SESSIONS=AUTO
check_contains "an undelivered Enter is NOT counted" "monitor[w1]: COMPLETE (approvals=0)" "$LOOP_STDOUT"
check_contains "the missed approval is reported" \
  "prompt approval Enter NOT delivered" "$LOOP_STDERR"

# The resend budget has the same failure shape, one step worse: spending it on a
# no-op escalates to "budget spent — operator needed" without a single resend
# ever having been attempted at a pane.
LOOP_SESSIONS=""
run_loop budget-undelivered 3 live-api-error-exhausted.json --max-resends 1
LOOP_SESSIONS=AUTO
check_lacks "an undelivered resend does not spend the budget" "resend budget spent" "$LOOP_STDOUT"
check_lacks "…and is never reported as sent" "resent to" "$LOOP_STDOUT"
check "the failure is re-reported every poll, so it cannot be missed" 3 \
  "$(printf '%s\n' "$LOOP_STDERR" | grep -c "NOT delivered")"

echo
echo "== monitor.sh with the task ledger wired (Issue #1589) =="
TASK_LOOP_DIR="$WORK/task-loop"
mkdir -p "$TASK_LOOP_DIR"
printf 'aaaaaaaa-0000-0000-0000-000000000001\tsucceeded\tclaude\tlint\tRun C\n' > "$TASK_LOOP_DIR/succeeded.tsv"
printf 'aaaaaaaa-0000-0000-0000-000000000002\tfailed\tclaude\tlint\tRun B\n' > "$TASK_LOOP_DIR/failed.tsv"
printf 'aaaaaaaa-0000-0000-0000-000000000003\trunning\tclaude\tlint\tRun D\n' > "$TASK_LOOP_DIR/running.tsv"

# An adjudicated `succeeded` completes the watch with the work counters still
# stubbed at 0 — the exact input the fallback path reads as "never sent". This is
# the demotion, at loop level: the ledger decides, the heuristics do not veto it.
LOOP_TASK_OUT="$TASK_LOOP_DIR/succeeded.tsv" \
  run_loop task-succeeded 5 live-idle.json --verbose --hooks "$SCRIPTS/hooks-task.sh"
check_contains "an adjudicated succeeded reaches COMPLETE without work counters" \
  "monitor[w1]: COMPLETE (approvals=0)" "$LOOP_STDOUT"
check "the poll line carries the status it decided on" \
  "monitor[w1]: poll 1 -> IDLE started=0 streak=1 commits=0 uncommitted=0 verdict=COMPLETE task=succeeded" \
  "$(printf '%s\n' "$LOOP_STDOUT" | grep -E '^monitor\[w1\]: poll 1 ')"
check_lacks "a wired ledger that answers does not announce the version gate" \
  "FALLBACK MODE" "$LOOP_STDOUT"

# `failed` is terminal but explicitly not a pass. Before #1589 this run reported
# COMPLETE once the counters showed work, which is the misreport the change removes.
LOOP_TASK_OUT="$TASK_LOOP_DIR/failed.tsv" \
  run_loop task-failed 5 live-idle.json --verbose --hooks "$SCRIPTS/hooks-task.sh"
check_contains "a failed contract ends the watch as VERIFY_FAILED" \
  "monitor[w1]: VERIFY_FAILED — contract gates failed; do not merge." "$LOOP_STDOUT"
check_lacks "a failed contract is never reported as COMPLETE" \
  "monitor[w1]: COMPLETE" "$LOOP_STDOUT"
check_contains "a failed contract stops the loop instead of polling forever" \
  "monitor: all 1 worker(s) complete" "$LOOP_STDOUT"

# A live pane vetoes the ledger: poll 1 is GENERATING, so the stale `succeeded`
# cannot end the watch until the worker actually goes idle.
LOOP_TASK_OUT="$TASK_LOOP_DIR/succeeded.tsv" \
  run_loop task-veto 5 live-generating-token.json,live-idle.json --verbose --hooks "$SCRIPTS/hooks-task.sh"
check "a generating pane keeps WORKING even with a succeeded task" \
  "monitor[w1]: poll 1 -> GENERATING started=1 streak=0 commits=0 uncommitted=0 verdict=WORKING task=succeeded" \
  "$(printf '%s\n' "$LOOP_STDOUT" | grep -E '^monitor\[w1\]: poll 1 ')"
check_contains "the same task completes once the pane goes idle" \
  "monitor[w1]: COMPLETE (approvals=0)" "$LOOP_STDOUT"

# A non-terminal status leaves the heuristics in charge — with stub counters that
# means the run never completes, exactly as a contract-less run behaves.
LOOP_TASK_OUT="$TASK_LOOP_DIR/running.tsv" \
  run_loop task-running 3 live-idle.json --verbose --hooks "$SCRIPTS/hooks-task.sh"
check_lacks "a running task does not complete the watch" "COMPLETE" "$LOOP_STDOUT"
check_contains "a running task is recorded in the evidence line" "task=running" "$LOOP_STDOUT"
check_contains "a running task runs to --max-polls" "reached --max-polls (3)" "$LOOP_STDOUT"

# The version gate: hooks-task.sh was wired, so task state was promised, and the
# CLI could not answer (measured exit 1 on every published CommandMate, none of
# which ship `commandmate task`). Degrading quietly here would leave a log full of
# plausible COMPLETE lines with nothing saying they were inferred.
LOOP_TASK_EXIT=1 run_loop task-gate 3 live-idle.json --verbose --hooks "$SCRIPTS/hooks-task.sh"
check_contains "an unreadable ledger announces fallback mode" \
  "monitor[w1]: task state unavailable" "$LOOP_STDOUT"
check_contains "the announcement says completion is inferred, not adjudicated" \
  "FALLBACK MODE: completion is inferred from capture, not adjudicated." "$LOOP_STDOUT"
check_contains "the announcement is actionable" \
  "commandmate task list w1 --limit 1" "$LOOP_STDOUT"
check "it is announced once, not once per poll" 1 \
  "$(printf '%s\n' "$LOOP_STDOUT" | grep -c 'FALLBACK MODE')"
check "the fallback verdicts are the pre-#1589 ones" \
  "monitor[w1]: poll 3 -> IDLE started=0 streak=3 commits=0 uncommitted=0 verdict=NOT_STARTED" \
  "$(printf '%s\n' "$LOOP_STDOUT" | grep -E '^monitor\[w1\]: poll 3 ')"
check_lacks "the sentinel never leaks into the evidence line" "task=unavailable" "$LOOP_STDOUT"

# Two hooks files: work counters from one, task state from the other. Repeatable
# --hooks is what makes the primary source and the fallback source composable.
printf 'count_commits() { echo 4; }\ncount_uncommitted() { echo 0; }\n' > "$WORK/hooks-counters.sh"
LOOP_TASK_OUT="$TASK_LOOP_DIR/failed.tsv" \
  run_loop task-two-hooks 3 live-idle.json --verbose \
  --hooks "$WORK/hooks-counters.sh" --hooks "$SCRIPTS/hooks-task.sh"
check "both hooks files are sourced, left to right" \
  "monitor[w1]: poll 1 -> IDLE started=0 streak=1 commits=4 uncommitted=0 verdict=VERIFY_FAILED task=failed" \
  "$(printf '%s\n' "$LOOP_STDOUT" | grep -E '^monitor\[w1\]: poll 1 ')"
check_contains "a second hooks file that is missing still fails loudly" "hooks file not found" \
  "$(run_loop task-two-hooks-missing 1 live-idle.json --hooks "$WORK/hooks-counters.sh" --hooks /nonexistent/hooks-task.sh; printf '%s' "$LOOP_STDERR")"

echo
echo "== hooks-git.sh reference implementation =="
GIT_REPO="$WORK/repo/myrepo"
mkdir -p "$WORK/repo"
git -c init.defaultBranch=main init --quiet "$GIT_REPO"
printf 'base\n' > "$GIT_REPO/README.md"
git -C "$GIT_REPO" add . >/dev/null
git -C "$GIT_REPO" -c user.email=t@t -c user.name=t commit --quiet -m base
git -C "$GIT_REPO" -c user.email=t@t -c user.name=t worktree add --quiet -b feature/x "$WORK/repo/myrepo-x" >/dev/null 2>&1
printf 'work\n' > "$WORK/repo/myrepo-x/README.md"
git -C "$WORK/repo/myrepo-x" -c user.email=t@t -c user.name=t commit --quiet -am work
printf 'wip\n' > "$WORK/repo/myrepo-x/scratch.txt"
# generateWorktreeId('feature/x', 'myrepo')
WID=myrepo-feature-x

counts=$(MONITOR_HOOKS_REPO="$GIT_REPO" MONITOR_HOOKS_BASE=main bash -c \
  ". \"$HOOKS_GIT\"; printf '%s %s' \"\$(count_commits $WID)\" \"\$(count_uncommitted $WID)\"" 2>/dev/null)
check "counts real commits and uncommitted changes for a worktree-id" "1 1" "$counts"

counts=$(MONITOR_HOOKS_REPO="$GIT_REPO" MONITOR_HOOKS_BASE=main bash -c \
  ". \"$HOOKS_GIT\"; printf '%s %s' \"\$(count_commits nope-nope)\" \"\$(count_uncommitted nope-nope)\"" 2>/dev/null)
check "an id that resolves to no worktree counts 0, it does not error" "0 0" "$counts"

warn=$(MONITOR_HOOKS_REPO="$GIT_REPO" MONITOR_HOOKS_BASE=origin/nope bash -c ". \"$HOOKS_GIT\"" 2>&1 >/dev/null)
check_contains "an unresolvable base ref warns instead of silently counting zero" \
  "base ref 'origin/nope' does not resolve" "$warn"

# End to end: the shipped reference — not a test double — makes COMPLETE reachable.
LOOP_ID=$WID
MONITOR_HOOKS_REPO="$GIT_REPO" MONITOR_HOOKS_BASE=main \
  run_loop hooks-git-e2e 5 live-generating-token.json,live-idle.json --verbose --hooks "$HOOKS_GIT"
check "hooks-git.sh drives the loop to COMPLETE" \
  "monitor[$WID]: poll 2 -> IDLE started=1 streak=1 commits=1 uncommitted=1 verdict=COMPLETE" \
  "$(printf '%s\n' "$LOOP_STDOUT" | grep -E ": poll 2 ")"
LOOP_ID=w1

echo
echo "-------------------------------------------"
printf '%s passed, %s failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ] || exit 1
