#!/usr/bin/env bash
# Regression tests for cmate-delegate.
#
#   bash tests/fixtures/cmate-delegate/run_tests.sh
#
# Five things are proved here, in this order:
#
#  1. **The request template still asks for everything a request needs.** The
#     five fields SKILL.md refuses to send without are present in the ja block,
#     the en block and the key table, and the closing `DONE:` marker is in both
#     languages. A template that quietly loses "do not touch" reads as complete
#     and is discovered to be incomplete only in somebody else's worktree.
#  2. **The checker in 1 is not a rubber stamp.** Every field it claims to
#     require is removed, one at a time, from a copy of the real file, and that
#     exact removal must be the thing it reports. A checker nobody ever saw
#     reject anything is a checker whose green means nothing.
#  3. **`ask.sh` passes `wait`'s exit code through.** 0 / 10 / 21 / 99 / 124 come
#     out of the wrapper unchanged, and stdout carries the reply and nothing
#     else. This is the defect the wrapper exists to prevent: `wait ... ; echo
#     done` returns 0 for a timeout, and the caller then reports a delegation
#     that never happened as finished.
#  4. **The wrapper never answers for the other session.** No branch of it
#     reaches `respond`, `auto-yes`, `interrupt` or `--auto-yes` -- proved both
#     by a `commandmate` stub that records every call and fails loudly on an
#     unexpected subcommand, and by grepping the shipped scripts.
#  5. **SKILL.md section 8 still teaches the relay, and does not declare it
#     absent.** The section that covers `--reply-to` / `--async` has to carry
#     the ledger commands and the four refusals, and must not say the CLI does
#     not exist yet. That sentence is what issue #243 removed: it read as "this
#     whole section is unusable", so an agent skipped the section entirely
#     while the commands were shipping in CommandMate#2377.
#
# Requires bash and the standard POSIX tools. No network and no CommandMate
# server: `commandmate` on PATH is a stub that only writes a log.
set -u

SUITE_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SUITE_DIR/../../.." && pwd)
SKILL_DIR="$REPO_ROOT/skills/cmate-delegate"
BRIEF="$SKILL_DIR/references/delegation-brief.md"
ASK="$SKILL_DIR/scripts/ask.sh"
CHECK_BRIEF="$SUITE_DIR/check-brief.sh"

WORK=$(mktemp -d -t cmate-delegate-tests.XXXXXX)
trap 'rm -rf "$WORK"' EXIT INT TERM

passed=0
failed=0
mutations=0

pass() { passed=$((passed + 1)); printf 'ok   %s\n' "$1"; }
fail() { failed=$((failed + 1)); printf 'FAIL %s\n     %s\n' "$1" "$2"; }

# ---------------------------------------------------------------------------
# The commandmate stub
# ---------------------------------------------------------------------------
mkdir -p "$WORK/bin"
cat > "$WORK/bin/commandmate" <<'STUB'
#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >> "$CMATE_STUB_LOG"
sub="${1:-}"
shift || true
case "$sub" in
  ask)
    if [ "${CMATE_STUB_HAS_ASK:-0}" != "1" ]; then
      printf "error: unknown command 'ask'\n" >&2
      exit 1
    fi
    case "${1:-}" in
      --help) exit 0 ;;
    esac
    printf 'ASK-REPLY\n'
    exit "${CMATE_STUB_ASK_EXIT:-0}"
    ;;
  send)
    printf 'send: delivered\n'
    exit "${CMATE_STUB_SEND_EXIT:-0}"
    ;;
  wait)
    printf 'WAIT-DIAGNOSTIC\n'
    exit "${CMATE_STUB_WAIT_EXIT:-0}"
    ;;
  capture)
    printf 'REPLY-LINE-1\nDONE: ok\n'
    exit "${CMATE_STUB_CAPTURE_EXIT:-0}"
    ;;
  *)
    printf 'stub: cmate-delegate must never call: %s\n' "$sub" >&2
    exit 97
    ;;
esac
STUB
chmod +x "$WORK/bin/commandmate"

PATH="$WORK/bin:$PATH"
export PATH
unset CM 2>/dev/null || true
unset CM_WORKTREE_ID 2>/dev/null || true
unset CM_INSTANCE_ID 2>/dev/null || true

reset_stub() {
  CMATE_STUB_LOG="$WORK/calls.log"
  : > "$CMATE_STUB_LOG"
  export CMATE_STUB_LOG
  CMATE_STUB_HAS_ASK=0
  CMATE_STUB_ASK_EXIT=0
  CMATE_STUB_SEND_EXIT=0
  CMATE_STUB_WAIT_EXIT=0
  CMATE_STUB_CAPTURE_EXIT=0
  export CMATE_STUB_HAS_ASK CMATE_STUB_ASK_EXIT CMATE_STUB_SEND_EXIT \
    CMATE_STUB_WAIT_EXIT CMATE_STUB_CAPTURE_EXIT
}

# ---------------------------------------------------------------------------
# 1. The shipped template carries every required field
# ---------------------------------------------------------------------------
printf '\n== 1. delegation-brief carries the five required fields ==\n'

if out=$(bash "$CHECK_BRIEF" "$BRIEF" 2>&1); then
  pass 'delegation-brief.md passes check-brief'
else
  fail 'delegation-brief.md passes check-brief' "$out"
fi

# ---------------------------------------------------------------------------
# 2. The checker is not a rubber stamp
# ---------------------------------------------------------------------------
printf '\n== 2. every rule check-brief claims is exercised by a mutation ==\n'

# expect_rejected <name> <needle removed> <awk-safe literal>
expect_rejected() {
  local name="$1" literal="$2" copy out
  mutations=$((mutations + 1))
  copy="$WORK/mutated.md"
  # Delete the whole line carrying the literal, which is how a field disappears
  # in practice: somebody edits the template and drops a row.
  LITERAL="$literal" awk '
    BEGIN { needle = ENVIRON["LITERAL"] }
    index($0, needle) == 0 { print }
  ' "$BRIEF" > "$copy"
  if cmp -s "$BRIEF" "$copy"; then
    fail "$name" "the mutation removed nothing: literal not found in the source ($literal)"
    return
  fi
  if out=$(bash "$CHECK_BRIEF" "$copy" 2>&1); then
    fail "$name" "check-brief accepted a template with '$literal' removed"
  else
    pass "$name"
  fi
}

expect_rejected 'ja: 目的 removed is rejected'                 '■ 目的'
expect_rejected 'ja: 対象 removed is rejected'                 '■ 対象'
expect_rejected 'ja: 出力の形 removed is rejected'             '■ 出力の形'
expect_rejected 'ja: 触ってはいけないもの removed is rejected' '■ 触ってはいけないもの'
expect_rejected 'ja: 締め方 removed is rejected'               '■ 締め方'
expect_rejected 'en: Purpose removed is rejected'              '# Purpose'
expect_rejected 'en: Target removed is rejected'               '# Target'
expect_rejected 'en: Expected output removed is rejected'      '# Expected output'
expect_rejected 'en: Do not touch removed is rejected'         '# Do not touch'
expect_rejected 'en: How to close removed is rejected'         '# How to close'
expect_rejected 'the ja BEGIN marker removed is rejected'      '<!-- BEGIN TEMPLATE ja -->'
expect_rejected 'the en BEGIN marker removed is rejected'      '<!-- BEGIN TEMPLATE en -->'

# The key table is a separate rule from the templates: it is the vocabulary the
# CommandMate side is meant to be reconciled against, so losing a key has to
# fire even while both templates still read fine.
expect_rejected 'the forbidden key removed from the table is rejected' '| `forbidden` |'
expect_rejected 'the closing key removed from the table is rejected'   '| `closing` |'

# ---------------------------------------------------------------------------
# 3. ask.sh passes wait's exit code through
# ---------------------------------------------------------------------------
printf '\n== 3. ask.sh returns the exit code of wait, unchanged ==\n'

# expect_exit <name> <wait exit> <expected ask.sh exit>
expect_exit() {
  local name="$1" wait_exit="$2" want="$3" got
  reset_stub
  CMATE_STUB_WAIT_EXIT="$wait_exit"
  export CMATE_STUB_WAIT_EXIT
  bash "$ASK" wt-b codex-2 'please review' --timeout 5 >/dev/null 2>&1
  got=$?
  if [ "$got" -eq "$want" ]; then
    pass "$name"
  else
    fail "$name" "wait exited $wait_exit, ask.sh exited $got, expected $want"
  fi
}

expect_exit 'wait 0   (turn ended)   is passed through' 0 0
expect_exit 'wait 10  (prompt)       is passed through' 10 10
expect_exit 'wait 21  (not started)  is passed through' 21 21
expect_exit 'wait 99  (unresolved)   is passed through' 99 99
expect_exit 'wait 124 (timeout)      is passed through' 124 124

# 10 and 124 are the two the acceptance criterion names, so they are also held
# against the failure mode that produced this wrapper: a trailing capture whose
# own success would otherwise become the reported result.
reset_stub
CMATE_STUB_WAIT_EXIT=124
export CMATE_STUB_WAIT_EXIT
bash "$ASK" wt-b codex-2 'please review' --timeout 5 >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 124 ] && grep -q '^capture ' "$CMATE_STUB_LOG"; then
  pass 'a timed-out wait still captures, and still exits 124'
else
  rc_log=$(cat "$CMATE_STUB_LOG")
  fail 'a timed-out wait still captures, and still exits 124' "exit=$rc calls:
$rc_log"
fi

reset_stub
CMATE_STUB_WAIT_EXIT=10
export CMATE_STUB_WAIT_EXIT
bash "$ASK" wt-b codex-2 'please review' --timeout 5 >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 10 ] && grep -q '^capture ' "$CMATE_STUB_LOG"; then
  pass 'a prompt-detecting wait still captures, and still exits 10'
else
  rc_log=$(cat "$CMATE_STUB_LOG")
  fail 'a prompt-detecting wait still captures, and still exits 10' "exit=$rc calls:
$rc_log"
fi

# A capture that fails must not overwrite the verdict either.
reset_stub
CMATE_STUB_WAIT_EXIT=10
CMATE_STUB_CAPTURE_EXIT=99
export CMATE_STUB_WAIT_EXIT CMATE_STUB_CAPTURE_EXIT
bash "$ASK" wt-b codex-2 'please review' --timeout 5 >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 10 ]; then
  pass 'a failing capture does not overwrite wait 10'
else
  fail 'a failing capture does not overwrite wait 10' "ask.sh exited $rc, expected 10"
fi

# stdout purity: the reply, and nothing else.
reset_stub
out=$(bash "$ASK" wt-b codex-2 'please review' --timeout 5 2>/dev/null)
want=$(printf 'REPLY-LINE-1\nDONE: ok')
if [ "$out" = "$want" ]; then
  pass 'stdout carries the captured reply and nothing else'
else
  fail 'stdout carries the captured reply and nothing else' "got:
$out"
fi

# send failing means nothing was delegated: its code comes back and wait is
# never reached.
reset_stub
CMATE_STUB_SEND_EXIT=99
export CMATE_STUB_SEND_EXIT
bash "$ASK" wt-b codex-2 'please review' --timeout 5 >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 99 ] && ! grep -q '^wait ' "$CMATE_STUB_LOG"; then
  pass 'a failed send returns its own code and never waits'
else
  rc_log=$(cat "$CMATE_STUB_LOG")
  fail 'a failed send returns its own code and never waits' "exit=$rc calls:
$rc_log"
fi

# --on-prompt: agent by default (so exit 10 can reach the caller), human only
# when asked for.
reset_stub
bash "$ASK" wt-b codex-2 'please review' --timeout 5 >/dev/null 2>&1
if grep -q '^wait .*--on-prompt agent' "$CMATE_STUB_LOG"; then
  pass 'wait is called with --on-prompt agent by default'
else
  rc_log=$(cat "$CMATE_STUB_LOG")
  fail 'wait is called with --on-prompt agent by default' "calls:
$rc_log"
fi

reset_stub
bash "$ASK" wt-b codex-2 'please review' --timeout 5 --on-prompt human >/dev/null 2>&1
if grep -q '^wait .*--on-prompt human' "$CMATE_STUB_LOG"; then
  pass '--on-prompt human is passed through when asked for'
else
  rc_log=$(cat "$CMATE_STUB_LOG")
  fail '--on-prompt human is passed through when asked for' "calls:
$rc_log"
fi

# When `commandmate ask` exists the wrapper gets out of the way entirely.
reset_stub
CMATE_STUB_HAS_ASK=1
CMATE_STUB_ASK_EXIT=10
export CMATE_STUB_HAS_ASK CMATE_STUB_ASK_EXIT
out=$(bash "$ASK" wt-b codex-2 'please review' --timeout 5 2>/dev/null)
rc=$?
if [ "$rc" -eq 10 ] && [ "$out" = "ASK-REPLY" ] && ! grep -q '^send ' "$CMATE_STUB_LOG"; then
  pass 'a real `commandmate ask` is delegated to, exit code included'
else
  rc_log=$(cat "$CMATE_STUB_LOG")
  fail 'a real `commandmate ask` is delegated to, exit code included' "exit=$rc out=$out calls:
$rc_log"
fi

# Argument handling
reset_stub
bash "$ASK" wt-b codex-2 >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 2 ]; then
  pass 'a missing message is exit 2, not a send of nothing'
else
  fail 'a missing message is exit 2, not a send of nothing' "exit=$rc"
fi

reset_stub
bash "$ASK" wt-b codex-2 'msg' --on-prompt maybe >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 2 ] && [ ! -s "$CMATE_STUB_LOG" ]; then
  pass 'an unknown --on-prompt mode is refused before anything is sent'
else
  fail 'an unknown --on-prompt mode is refused before anything is sent' "exit=$rc"
fi

reset_stub
CM='commandmate --token $(cat /etc/passwd)' bash "$ASK" wt-b codex-2 'msg' >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 2 ] && [ ! -s "$CMATE_STUB_LOG" ]; then
  pass 'a launcher carrying shell syntax is refused, not run'
else
  fail 'a launcher carrying shell syntax is refused, not run' "exit=$rc"
fi

reset_stub
CM_WORKTREE_ID=wt-b CM_INSTANCE_ID=codex-2 bash "$ASK" wt-b codex-2 'msg' >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 2 ] && [ ! -s "$CMATE_STUB_LOG" ]; then
  pass 'delegating to this very session is refused before sending'
else
  rc_log=$(cat "$CMATE_STUB_LOG")
  fail 'delegating to this very session is refused before sending' "exit=$rc calls:
$rc_log"
fi

reset_stub
CM_WORKTREE_ID=wt-b CM_INSTANCE_ID=claude bash "$ASK" wt-b codex-2 'msg' --timeout 5 >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 0 ] && grep -q '^send ' "$CMATE_STUB_LOG"; then
  pass 'a different instance in the same worktree is still a valid target'
else
  rc_log=$(cat "$CMATE_STUB_LOG")
  fail 'a different instance in the same worktree is still a valid target' "exit=$rc calls:
$rc_log"
fi

# A brief that opens with a dash is a message, not a flag.
reset_stub
bash "$ASK" --timeout 5 -- wt-b codex-2 '--- please review ---' >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 0 ] && grep -q 'send wt-b --- please review --- --instance codex-2' "$CMATE_STUB_LOG"; then
  pass 'a message starting with a dash survives -- and is sent verbatim'
else
  rc_log=$(cat "$CMATE_STUB_LOG")
  fail 'a message starting with a dash survives -- and is sent verbatim' "exit=$rc calls:
$rc_log"
fi

# ---------------------------------------------------------------------------
# 4. The wrapper never answers for the other session
# ---------------------------------------------------------------------------
printf '\n== 4. no branch of the wrapper answers a prompt or touches auto-yes ==\n'

forbidden_calls=0
for wait_exit in 0 10 21 99 124; do
  reset_stub
  CMATE_STUB_WAIT_EXIT="$wait_exit"
  export CMATE_STUB_WAIT_EXIT
  bash "$ASK" wt-b codex-2 'please review' --timeout 5 >/dev/null 2>&1
  if grep -Eq '^(respond|auto-yes|interrupt)( |$)|--auto-yes' "$CMATE_STUB_LOG"; then
    forbidden_calls=$((forbidden_calls + 1))
    printf '     wait %s produced: %s\n' "$wait_exit" "$(cat "$CMATE_STUB_LOG")"
  fi
done
if [ "$forbidden_calls" -eq 0 ]; then
  pass 'no wait outcome makes the wrapper respond, interrupt or enable auto-yes'
else
  fail 'no wait outcome makes the wrapper respond, interrupt or enable auto-yes' \
    "$forbidden_calls of 5 outcomes reached a forbidden command"
fi

# Static reading of the shipped scripts, so a branch this suite does not reach
# cannot smuggle one in either.
static_hits=$(grep -HnE '(^|[^-[:alnum:]])(respond|interrupt)[[:space:]]|--auto-yes|auto-yes[[:space:]]+--enable' \
  "$SKILL_DIR"/scripts/*.sh 2>/dev/null | grep -vE ':[0-9]+:[[:space:]]*#' || true)
if [ -z "$static_hits" ]; then
  pass 'the shipped scripts contain no respond / interrupt / auto-yes invocation'
else
  fail 'the shipped scripts contain no respond / interrupt / auto-yes invocation' "$static_hits"
fi

# ---------------------------------------------------------------------------
# 5. SKILL.md section 8 teaches the relay ledger, not its absence
# ---------------------------------------------------------------------------
printf '\n== 5. section 8 teaches the relay ledger, not its absence ==\n'

SKILL_MD="$SKILL_DIR/SKILL.md"

# The literals section 8 has to keep. Each one is a thing an agent cannot work
# out from the rest of the file: the two ledger commands, the two asynchronous
# forms, the limits the server refuses on, and the header a delivered reply
# arrives under.
SECTION8_REQUIRED='commandmate relays
relays cancel <relay-id>
--reply-to
--async
--allow-relay-chain
3 hops
24h
exit 2
[from '

# check_section8 <file> -- exit 0 when the section carries every literal above
# and does not declare the CLI absent. Names what is wrong on stderr.
check_section8() {
  local file="$1" lit oldifs missing=0
  oldifs="$IFS"
  IFS='
'
  for lit in $SECTION8_REQUIRED; do
    IFS="$oldifs"
    if ! grep -qF -- "$lit" "$file"; then
      printf 'section 8 no longer mentions: %s\n' "$lit" >&2
      missing=$((missing + 1))
    fi
    IFS='
'
  done
  IFS="$oldifs"
  # 「まだ存在しない」 -- the assertion #243 removed. A sentence that dates a
  # shipped CLI as unbuilt kills the section it closes.
  if grep -qF -- 'まだ存在しない' "$file"; then
    printf 'section 8 declares the CLI absent again\n' >&2
    missing=$((missing + 1))
  fi
  [ "$missing" -eq 0 ]
}

# The extraction has to be anchored at both ends: a renamed heading 9 would let
# section 8 swallow the rest of the file, and every check below would pass on
# text that is not section 8 at all.
SECTION8="$WORK/section8.md"
awk '/^## 8\./ { inside = 1 } /^## 9\./ { inside = 0 } inside { print }' \
  "$SKILL_MD" > "$SECTION8"

if [ "$(grep -c '^## 8\.' "$SKILL_MD")" -eq 1 ] \
  && [ "$(grep -c '^## 9\.' "$SKILL_MD")" -eq 1 ] \
  && [ -s "$SECTION8" ]; then
  pass 'section 8 is bounded by exactly one "## 8." and one "## 9." heading'
else
  fail 'section 8 is bounded by exactly one "## 8." and one "## 9." heading' \
    'the extraction is empty or the headings moved; every check below would be vacuous'
fi

if out=$(check_section8 "$SECTION8" 2>&1); then
  pass 'section 8 carries the relay commands, the refusals and no "not built yet"'
else
  fail 'section 8 carries the relay commands, the refusals and no "not built yet"' "$out"
fi

# The checker is held to the same standard as check-brief: every literal it
# claims to require is deleted from a copy, and that deletion has to be what it
# reports.
expect_section8_rejected() { # expect_section8_rejected <name> <literal>
  local name="$1" literal="$2" copy out
  mutations=$((mutations + 1))
  copy="$WORK/section8-mutated.md"
  LITERAL="$literal" awk '
    BEGIN { needle = ENVIRON["LITERAL"] }
    index($0, needle) == 0 { print }
  ' "$SECTION8" > "$copy"
  if cmp -s "$SECTION8" "$copy"; then
    fail "$name" "the mutation removed nothing: literal not found in section 8 ($literal)"
    return
  fi
  if out=$(check_section8 "$copy" 2>&1); then
    fail "$name" "check_section8 accepted a section 8 with '$literal' removed"
  else
    pass "$name"
  fi
}

expect_section8_rejected 'the relays listing removed is rejected'   'commandmate relays'
expect_section8_rejected 'relays cancel removed is rejected'        'relays cancel <relay-id>'
expect_section8_rejected '--reply-to removed is rejected'           '--reply-to'
expect_section8_rejected '--async removed is rejected'              '--async'
expect_section8_rejected 'the chain override removed is rejected'   '--allow-relay-chain'
expect_section8_rejected 'the hop limit removed is rejected'        '3 hops'
expect_section8_rejected 'the 24h deadline removed is rejected'     '24h'
expect_section8_rejected 'the refusal exit code removed is rejected' 'exit 2'
expect_section8_rejected 'the [from header removed is rejected'     '[from '

# And the sentence #243 deleted must not be able to come back unnoticed.
mutations=$((mutations + 1))
copy="$WORK/section8-stale.md"
cp "$SECTION8" "$copy"
printf 'この節の CLI は**まだ存在しない**。\n' >> "$copy"
if check_section8 "$copy" >/dev/null 2>&1; then
  fail 'a re-added "まだ存在しない" is rejected' 'check_section8 accepted the stale assertion'
else
  pass 'a re-added "まだ存在しない" is rejected'
fi

# ---------------------------------------------------------------------------
printf '\n%s passed, %s failed (%s mutations exercised)\n' "$passed" "$failed" "$mutations"
[ "$failed" -eq 0 ] || exit 1
exit 0
