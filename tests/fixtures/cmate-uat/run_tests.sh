#!/usr/bin/env bash
# Regression tests for cmate-uat.
#
#   bash tests/fixtures/cmate-uat/run_tests.sh
#
# The package is a procedure plus one script, so there are two things to hold and
# they need different techniques. Four sections, in this order:
#
#  1. **scripts/uat-env.sh behaves.** Driven for real against loopback sockets
#     this suite opens itself, including the property the script exists for: a
#     stop that signals a LISTENER but never a process merely CONNECTED to the
#     same port (CommandMate#2473 is the incident where the wrong form killed a
#     browser's network service).
#  2. **The check in 1 is not a rubber stamp.** Mutations are injected into a
#     copy of the real script, one at a time, and each has to be caught. The
#     mutation that matters most is dropping `-sTCP:LISTEN`, because a suite that
#     stays green without it is not testing the one thing this script is for.
#  3. **SKILL.md carries the rules.** One literal per rule that the procedure
#     would still read as complete without: isolation gating, not repairing,
#     manual_pending instead of waiting for a human, the LISTEN filter, no
#     Agent-specific tool name, no project-specific path, and the dollar-digit
#     substitution Claude applies to a SKILL.md body (#247). Each literal is then
#     deleted from a copy and the check has to fail.
#  4. **The run-dir checker.** `check_run.py --selftest` grades the two fixture
#     runs and one injected mutation per rule.
#
# Requires bash (3.2 is enough), python3 (standard library only), lsof or ss, and
# the POSIX tools. No network beyond loopback, no CommandMate server, no Agent.
set -u

SUITE_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SUITE_DIR/../../.." && pwd)
SKILL_DIR="$REPO_ROOT/skills/cmate-uat"
SKILL_MD="$SKILL_DIR/SKILL.md"
SCRIPT="$SKILL_DIR/scripts/uat-env.sh"

pass=0; fail=0
ok()   { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad()  { fail=$((fail + 1)); printf '  FAIL %s\n' "$1"; }
check(){ if [ "$1" = 0 ]; then ok "$2"; else bad "$2"; fi; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/cmate-uat-suite.XXXXXX") || exit 2
cleanup() {
  # Any listener this suite opened, and any child it spawned, dies with it.
  if [ -n "${LISTENER_PID:-}" ]; then kill -KILL "$LISTENER_PID" 2>/dev/null; fi
  if [ -n "${CLIENT_PID:-}" ]; then kill -KILL "$CLIENT_PID" 2>/dev/null; fi
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

python3 - <<'PY' || { echo "python3 is required" >&2; exit 2; }
import sys
sys.exit(0)
PY

if ! command -v lsof >/dev/null 2>&1 && ! command -v ss >/dev/null 2>&1; then
  echo "run_tests.sh: neither lsof nor ss is available; the script cannot be exercised" >&2
  exit 2
fi

# A listener and a client on the same port, so "listening" and "connected" can be
# told apart. Both are python so this needs no extra dependency. Their bodies live
# in files because a background job cannot take a heredoc plus arguments portably.
cat > "$WORK/listen.py" <<'PY'
import socket, sys, time
port = int(sys.argv[1])
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", port))
s.listen(8)
# Accept and HOLD. The connection has to stay ESTABLISHED, because "a process
# merely connected to this port" is the state the LISTEN filter has to exclude —
# closing each accepted socket would make that state never exist and the whole
# section would pass without testing anything.
held = []
while True:
    try:
        c, _ = s.accept()
        held.append(c)
    except Exception:
        time.sleep(0.05)
PY

cat > "$WORK/connect.py" <<'PY'
import pathlib, socket, sys, time
port, marker = int(sys.argv[1]), pathlib.Path(sys.argv[2])
# Hold an established connection open, without ever listening. The marker is
# written only AFTER the connection is up: the suite has to wait for the socket
# to exist, not merely for this process to start. Proceeding early was how the
# LISTEN-filter assertions passed without a connected process to exclude.
c = socket.create_connection(("127.0.0.1", port), timeout=5)
marker.write_text("connected\n", encoding="utf-8")
while True:
    time.sleep(1)
PY

free_port() {
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
}

echo "cmate-uat: 1. scripts/uat-env.sh behaves"

bash -n "$SCRIPT"; check $? "the script passes bash -n"

# --- port-find ---------------------------------------------------------------
PORT=$(free_port)
out=$(bash "$SCRIPT" port-find "$PORT" "$PORT" 2>/dev/null); rc=$?
[ "$rc" = 0 ] && [ "$out" = "$PORT" ]; check $? "port-find returns a free port"

python3 "$WORK/listen.py" "$PORT" >"$WORK/listener.log" 2>&1 &
LISTENER_PID=$!
# Wait for the socket to be up rather than sleeping a guessed amount.
i=0; while [ $i -lt 50 ]; do
  if bash "$SCRIPT" port-find "$PORT" "$PORT" >/dev/null 2>&1; then :; else break; fi
  i=$((i + 1)); sleep 0.1
done

bash "$SCRIPT" port-find "$PORT" "$PORT" >/dev/null 2>&1
[ $? = 1 ]; check $? "port-find exits 1 when the whole range is taken"

HIGHER=$((PORT + 1))
out=$(bash "$SCRIPT" port-find "$PORT" "$HIGHER" 2>/dev/null); rc=$?
[ "$rc" = 0 ] && [ "$out" = "$HIGHER" ]; check $? "port-find skips an occupied port and returns the next"

bash "$SCRIPT" port-find 10 5 >/dev/null 2>&1
[ $? = 2 ]; check $? "port-find rejects an inverted range (exit 2, not a silent empty answer)"

# --- wait-health -------------------------------------------------------------
out=$(bash "$SCRIPT" wait-health "true" 3 2>/dev/null); rc=$?
[ "$rc" = 0 ] && [ "$out" = "0" ]; check $? "wait-health accepts a command and reports 0 elapsed seconds"

bash "$SCRIPT" wait-health "false" 2 >/dev/null 2>&1
[ $? = 1 ]; check $? "wait-health exits 1 on timeout"

# A URL whose scheme is https but which cannot connect: proves the URL branch is
# reached (curl runs and fails) rather than the string being shell-executed.
bash "$SCRIPT" wait-health "https://127.0.0.1:1/nope" 1 >/dev/null 2>&1
[ $? = 1 ]; check $? "wait-health routes a scheme-bearing value to the URL branch"

# --- stop-listen: the property the script exists for -------------------------
rm -f "$WORK/connected"
python3 "$WORK/connect.py" "$PORT" "$WORK/connected" >"$WORK/client.log" 2>&1 &
CLIENT_PID=$!
i=0; while [ $i -lt 100 ]; do
  [ -s "$WORK/connected" ] && break
  i=$((i + 1)); sleep 0.1
done
[ -s "$WORK/connected" ] && kill -0 "$CLIENT_PID" 2>/dev/null
check $? "a client holds an established connection to the port (test precondition)"

# `x=$(cmd | head -1); rc=$?` would capture head's status, not the script's, so
# the two are measured separately.
bash "$SCRIPT" stop-listen "$PORT" --force-after 3 >"$WORK/stop.out" 2>/dev/null
rc=$?
signalled=$(head -1 "$WORK/stop.out")
[ "$rc" = 0 ]; check $? "stop-listen exits 0 once the port is released"

echo "$signalled" | tr ' ' '\n' | grep -qx "$LISTENER_PID"
check $? "stop-listen signalled the LISTENER"

echo "$signalled" | tr ' ' '\n' | grep -qx "$CLIENT_PID"
[ $? = 1 ]; check $? "stop-listen did NOT signal the merely CONNECTED process (CommandMate#2473)"

kill -0 "$CLIENT_PID" 2>/dev/null
check $? "the connected process is still alive after stop-listen"

kill -KILL "$CLIENT_PID" 2>/dev/null; CLIENT_PID=""
LISTENER_PID=""

bash "$SCRIPT" stop-listen "$(free_port)" >/dev/null 2>&1
check $? "stop-listen on an already-free port is exit 0, not an error"

bash "$SCRIPT" stop-listen notaport >/dev/null 2>&1
[ $? = 2 ]; check $? "stop-listen rejects a non-numeric port"

bash "$SCRIPT" nosuchsub >/dev/null 2>&1
[ $? = 2 ]; check $? "an unknown subcommand is exit 2"

echo
echo "cmate-uat: 2. the script checks are not a rubber stamp"

# Each mutation is described by the property it breaks. The suite re-runs the
# relevant assertion against a mutated copy and requires it to fail.
mutate_and_expect_fail() {
  label=$1; sed_expr=$2; shift 2
  copy="$WORK/mutant.sh"
  sed "$sed_expr" "$SCRIPT" > "$copy"
  if cmp -s "$copy" "$SCRIPT"; then
    bad "mutation '$label' did not change the script (the pattern no longer matches)"
    return
  fi
  if "$@" "$copy"; then
    bad "mutation '$label' was NOT caught"
  else
    ok "mutation '$label' is caught"
  fi
}

# The one that matters: without -sTCP:LISTEN, lsof returns connected processes
# too, so stop-listen would signal the client.
probe_listen_filter() {
  copy=$1
  p=$(free_port)
  python3 "$WORK/listen.py" "$p" >"$WORK/m-listener.log" 2>&1 &
  ml=$!
  i=0; while [ $i -lt 50 ]; do
    if bash "$SCRIPT" port-find "$p" "$p" >/dev/null 2>&1; then i=$((i + 1)); sleep 0.1; else break; fi
  done
  rm -f "$WORK/m-connected"
  python3 "$WORK/connect.py" "$p" "$WORK/m-connected" >"$WORK/m-client.log" 2>&1 &
  mc=$!
  i=0; while [ $i -lt 100 ]; do
    [ -s "$WORK/m-connected" ] && break
    i=$((i + 1)); sleep 0.1
  done
  if [ ! -s "$WORK/m-connected" ]; then
    # No connected process means the probe would pass for the wrong reason.
    kill -KILL "$ml" 2>/dev/null; kill -KILL "$mc" 2>/dev/null
    return 0
  fi
  got=$(bash "$copy" stop-listen "$p" --force-after 2 2>/dev/null | head -1)
  kill -KILL "$ml" 2>/dev/null; kill -KILL "$mc" 2>/dev/null
  # "Caught" means the mutant DID signal the connected pid, so we return 1 (the
  # assertion fails) when the client is absent from the list.
  echo "$got" | tr ' ' '\n' | grep -qx "$mc" && return 1
  return 0
}
if command -v lsof >/dev/null 2>&1; then
  mutate_and_expect_fail "drop -sTCP:LISTEN from the lsof call" \
    's/ -sTCP:LISTEN//' probe_listen_filter
else
  ok "mutation 'drop -sTCP:LISTEN' skipped (lsof not present; ss path is filtered by -l)"
fi

# port-find must not report an occupied port as free.
probe_port_find() {
  copy=$1
  p=$(free_port)
  python3 "$WORK/listen.py" "$p" >"$WORK/m2.log" 2>&1 &
  ml=$!
  i=0; while [ $i -lt 50 ]; do
    if bash "$SCRIPT" port-find "$p" "$p" >/dev/null 2>&1; then i=$((i + 1)); sleep 0.1; else break; fi
  done
  bash "$copy" port-find "$p" "$p" >/dev/null 2>&1
  rc=$?
  kill -KILL "$ml" 2>/dev/null
  [ "$rc" = 1 ]
}
mutate_and_expect_fail "make port_is_free always true" \
  's/^  \[ -z "\$found" \]$/  return 0/' probe_port_find

# wait-health must not report a timeout as success.
probe_wait_health() {
  copy=$1
  bash "$copy" wait-health "false" 1 >/dev/null 2>&1
  [ $? = 1 ]
}
mutate_and_expect_fail "return 0 after the wait-health deadline" \
  's/^  note "wait-health: .*$/  return 0/' probe_wait_health

# A missing lsof AND ss must be exit 2, never an empty listener list.
probe_no_tool_fails_loud() {
  copy=$1
  # Simulate both tools missing by stubbing command -v inside a sandboxed PATH.
  sandbox="$WORK/nobin"; mkdir -p "$sandbox"
  out=$(PATH="$sandbox" /bin/bash "$copy" stop-listen 65000 2>&1)
  rc=$?
  [ "$rc" = 2 ]
}
mutate_and_expect_fail "treat a missing lsof/ss as 'no listeners'" \
  's/^  die "neither lsof nor ss.*$/  return 0/' probe_no_tool_fails_loud

echo
echo "cmate-uat: 3. SKILL.md carries the rules"

# One literal per rule. Chosen so that a SKILL.md which quietly loses the rule
# still reads as a complete procedure — that is exactly the drift this catches.
RULES="
`isolation.checks` を全部実行する|環境の隔離を実測してからテストを始める規律
テストケースを 1 つも実行しない|隔離が落ちたらテストへ進まないこと
この Skill は実装も修正もしない|修正しない規律
人に問い合わせて待たない|画面 TC で人を待たない規律
-sTCP:LISTEN|停止をポートの LISTEN に絞る規律
uat_yaml_missing|無人 run で uat.yaml が無いときの停止
manual_pending|未確認を pass に丸めない outcome
cmate-uat|result document の skill.id
"

skill_md_holds_rules() {
  target=$1
  missing=""
  printf '%s\n' "$RULES" | while IFS='|' read -r literal _desc; do
    [ -n "$literal" ] || continue
    grep -qF -- "$literal" "$target" || printf 'x'
  done > "$WORK/missing.txt"
  [ ! -s "$WORK/missing.txt" ]
}

skill_md_holds_rules "$SKILL_MD"; check $? "every rule literal is present in the real SKILL.md"

# ...and the check above is not vacuous: delete each literal in turn.
printf '%s\n' "$RULES" | while IFS='|' read -r literal desc; do
  [ -n "$literal" ] || continue
  copy="$WORK/skill-mutant.md"
  grep -vF -- "$literal" "$SKILL_MD" > "$copy"
  if cmp -s "$copy" "$SKILL_MD"; then
    printf '  FAIL rule literal "%s" is not in SKILL.md at all\n' "$literal"
  elif skill_md_holds_rules "$copy"; then
    printf '  FAIL removing "%s" (%s) was NOT caught\n' "$literal" "$desc"
  else
    printf '  ok   removing "%s" is caught\n' "$literal"
  fi
done > "$WORK/rule-mutations.txt"
cat "$WORK/rule-mutations.txt"
grep -q FAIL "$WORK/rule-mutations.txt"
if [ $? = 0 ]; then fail=$((fail + 1)); else pass=$((pass + 1)); fi

# Agent-specific tool names and project-specific paths must not appear: the
# package is read by Agents other than Claude and by repositories other than
# CommandMate.
grep -nE 'TodoWrite|AskUserQuestion|model: opus' "$SKILL_MD" >/dev/null 2>&1
[ $? = 1 ]; check $? "SKILL.md names no Agent-specific tool"

grep -n 'dev-reports/' "$SKILL_MD" >/dev/null 2>&1
[ $? = 1 ]; check $? "SKILL.md assumes no project-specific report path"

# Claude Code substitutes a dollar sign followed by a digit, and $ARGUMENTS, in
# a SKILL.md body with the slash invocation's arguments (#247). A bash snippet
# holding $1 becomes something else entirely.
grep -nE '\$[0-9]|\$ARGUMENTS' "$SKILL_MD" >/dev/null 2>&1
[ $? = 1 ]; check $? "SKILL.md holds no \$<digit> or \$ARGUMENTS (#247)"

for f in "$SKILL_DIR"/references/*.md; do
  grep -nE '\$[0-9]|\$ARGUMENTS' "$f" >/dev/null 2>&1
  if [ $? = 1 ]; then :; else bad "$(basename "$f") holds a \$<digit> or \$ARGUMENTS"; fi
done
ok "references hold no \$<digit> or \$ARGUMENTS"

# The schema must not be duplicated into this package: cmate-acceptance-test
# owns the only copy, and two copies drift.
[ ! -d "$SKILL_DIR/schemas" ]; check $? "the package ships no schemas/ copy (the schema stays in cmate-acceptance-test)"

echo
echo "cmate-uat: 4. the run-dir checker"

python3 "$SUITE_DIR/check_run.py" --selftest
check $? "check_run.py --selftest"

echo
printf 'cmate-uat: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" = 0 ] || exit 1
