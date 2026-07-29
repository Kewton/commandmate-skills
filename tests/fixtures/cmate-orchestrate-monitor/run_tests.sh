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

# run_loop <case-name> <polls> <fixture[,fixture...]> [extra monitor args...]
# Serves fixture N on poll N and repeats the last one afterwards. Sets
# LOOP_STDOUT / LOOP_STDERR / LOOP_STATUS / LOOP_CAPTURES / LOOP_TMUX.
run_loop() {
  loop_case=$1; loop_polls=$2; loop_fixtures=$3; shift 3
  loop_dir="$WORK/$loop_case"
  mkdir -p "$loop_dir"
  loop_capture_log="$loop_dir/capture.log"
  loop_tmux_log="$loop_dir/tmux.log"
  : > "$loop_capture_log"
  : > "$loop_tmux_log"

  {
    echo '#!/bin/sh'
    echo "printf '%s\\n' \"\$*\" >> \"$loop_capture_log\""
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

  printf '#!/bin/sh\nprintf %s\\\\n "$*" >> "%s"\nexit 0\n' '"%s"' "$loop_tmux_log" > "$loop_dir/tmux"
  chmod +x "$loop_dir/fake-cm" "$loop_dir/tmux"

  LOOP_STDOUT=$(PATH="$loop_dir:$PATH" CM="$loop_dir/fake-cm" \
    bash "$MONITOR" --interval 0 --idle-threshold 1 --max-polls "$loop_polls" "$@" "$LOOP_ID" \
    2> "$loop_dir/stderr")
  LOOP_STATUS=$?
  LOOP_STDERR=$(cat "$loop_dir/stderr")
  LOOP_CAPTURES=$(grep -c . "$loop_capture_log" || true)
  LOOP_TMUX=$(cat "$loop_tmux_log")
}

# The stock stream is interventions and terminal verdicts only. Pinned
# byte-for-byte: --verbose is only allowed to *add* to it.
run_loop default-stream 3 live-generating-token.json,live-idle.json
check "default run polls 3 times" 3 "$LOOP_CAPTURES"
check "default run exits 0" 0 "$LOOP_STATUS"
expected_default=$(cat <<'EOF'
monitor: watching 1 worker(s), interval=0s, idle-threshold=1, max-resends=2
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
check_contains "resends after the CLI gave up" "resending (1/1)" "$LOOP_STDOUT"
check_contains "escalates once the budget is spent" "resend budget spent" "$LOOP_STDOUT"
check "resend types the message exactly once" "send-keys -t cm-w1 resume please Enter" "$LOOP_TMUX"

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
check_contains "acts on a genuine usage-limit banner" "rate limit -> sending 'a'" "$LOOP_STDOUT"
check "sends 'a' once" "send-keys -t cm-w1 a Enter" "$LOOP_TMUX"

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
