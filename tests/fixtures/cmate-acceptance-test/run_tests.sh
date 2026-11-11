#!/usr/bin/env bash
# Regression tests for the cmate-acceptance-test runner
# (skills/cmate-acceptance-test/scripts/run-acceptance.mjs) and the golden
# result documents under cases/.
#
#   bash tests/fixtures/cmate-acceptance-test/run_tests.sh
#
# The property the runner exists for (commandmate-skills#299): an acceptance
# criterion backed by a command is judged by the command's EXIT CODE, never by
# reading test counts out of its output. The incident was an agent-written
# judge that looked for TAP's `# pass 28` in `node --test` spec output
# (`ℹ pass 28`) and called a 28/28, exit-0 run NO-GO.
#
# The cases:
#   - recorded `node --test` output (node-test-output/), spec and TAP, exit 0
#     and exit 1, replayed by a command that prints it and exits with the code
#   - real `node --test` runs with --test-reporter=spec and =tap, passing and
#     failing
#   - output with no count line at all, exit 0 and exit 1
#   - counts that disagree with the exit code (the exit code wins)
#   - flaky (two attempts, differing exit codes), timeout, confirm_required in a
#     non-interactive run, an invalid plan, redaction, and tail truncation
# Every document the runner writes is held to the acceptance-result.v1 schema,
# the verdict-rubric invariants and the redaction rules by
# check_runner_result.py (which reuses check_result.py's validator).
#
# One mutation is injected as the control: a runner that judges by TAP counts
# instead of the exit code must fail the spec-reporter case — a suite that stays
# green against that runner is not testing what the runner is for.
#
# Requires bash, node (>= 22) and python3. No network.
set -u

SUITE_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SUITE_DIR/../../.." && pwd)
SKILL_DIR="$REPO_ROOT/skills/cmate-acceptance-test"
RUNNER="$SKILL_DIR/scripts/run-acceptance.mjs"
OUTPUTS="$SUITE_DIR/node-test-output"
CHECK="$SUITE_DIR/check_runner_result.py"

for tool in node python3; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'cmate-acceptance-test suite: %s is required\n' "$tool" >&2
    exit 2
  fi
done

WORK=$(mktemp -d "${TMPDIR:-/tmp}/cmate-acceptance-test-tests.XXXXXX")
trap 'rm -rf "$WORK"' EXIT INT TERM
# The physical path: what the runner's realpath sees, without `//` from a
# TMPDIR that ends in a slash.
WORK=$(cd "$WORK" && pwd -P)
PROJ="$WORK/proj"
mkdir -p "$PROJ"
export WORK PROJ

passed=0
failed=0

pass() { passed=$((passed + 1)); printf 'ok   %s\n' "$1"; }
fail() { failed=$((failed + 1)); printf 'FAIL %s\n     %s\n' "$1" "$2"; }

# run_plan <name> <plan json> [runner]  -> $WORK/<name>.json
run_plan() {
  local name=$1 plan=$2 runner=${3:-$RUNNER}
  printf '%s\n' "$plan" > "$WORK/$name.plan.json"
  node "$runner" --plan "$WORK/$name.plan.json" --out "$WORK/$name.json" --cwd "$PROJ" > "$WORK/$name.stdout" 2> "$WORK/$name.stderr"
  echo $? > "$WORK/$name.rc"
}

# check <label> <name> [check_runner_result.py args...]
check() {
  local label=$1 name=$2 out
  shift 2
  if [ "$(cat "$WORK/$name.rc")" != 0 ]; then
    fail "$label" "runner exited $(cat "$WORK/$name.rc"): $(cat "$WORK/$name.stderr")"
    return
  fi
  if out=$(python3 "$CHECK" "$WORK/$name.json" "$@" 2>&1); then
    pass "$label"
  else
    fail "$label" "$out"
  fi
}

# expect <label> <name> <js expression over d>
expect() {
  local label=$1 name=$2 expr=$3 out
  if out=$(node -e '
    const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const c = (id) => d.criteria.find((x) => x.id === id);
    const ev = (id) => d.evidence.find((x) => x.id === id);
    const k = (id) => d.checks.find((x) => x.id === id);
    const v = eval(process.argv[2]);
    if (v !== true) { console.log(JSON.stringify(v)); process.exit(1); }
  ' "$WORK/$name.json" "$expr" 2>&1); then
    pass "$label"
  else
    fail "$label" "expected: $expr (got: $out)"
  fi
}

# replay <file> <exit code>  -> a shell command printing recorded output
replay() { printf "cat '%s'; exit %s" "$OUTPUTS/$1" "$2"; }

# JSON string literal of $1
js() { node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"; }

one_criterion() { printf '{"issue_ref":"#299","environment":{"agent":"suite"},"criteria":[{"text":%s,"command":%s}]}' "$(js "$1")" "$(js "$2")"; }

# ---------------------------------------------------------------------------
# 0. The golden cases and the package shape.
# ---------------------------------------------------------------------------
if out=$(python3 "$SUITE_DIR/check_result.py" 2>&1); then
  pass "golden cases pass check_result.py"
else
  fail "golden cases pass check_result.py" "$out"
fi

manifest_version=$(sed -n 's/^version: //p' "$SKILL_DIR/commandmate.skill.yaml")
runner_version=$(sed -n "s/^export const SKILL_VERSION = '\\(.*\\)';$/\\1/p" "$RUNNER")
if [ -n "$manifest_version" ] && [ "$manifest_version" = "$runner_version" ]; then
  pass "SKILL_VERSION ($runner_version) matches the manifest"
else
  fail "SKILL_VERSION matches the manifest" "runner=$runner_version manifest=$manifest_version"
fi

if [ -x "$RUNNER" ]; then
  fail "runner has no executable bit" "an executable file raises the computed risk to high"
else
  pass "runner has no executable bit"
fi

if grep -nE "from '" "$RUNNER" | grep -v "from 'node:" >/dev/null; then
  fail "runner imports only node: built-ins" "$(grep -nE "from '" "$RUNNER" | grep -v "from 'node:")"
else
  pass "runner imports only node: built-ins"
fi

grep -q '合否は exit code で判定する' "$SKILL_DIR/SKILL.md" \
  && pass "SKILL.md states that the verdict is decided by exit code" \
  || fail "SKILL.md states that the verdict is decided by exit code" "phrase missing"

# ---------------------------------------------------------------------------
# 1. Recorded node --test output: spec and TAP, exit 0 and exit 1.
# ---------------------------------------------------------------------------
for reporter in spec tap; do
  run_plan "$reporter-pass" "$(one_criterion "npm test が通る ($reporter)" "$(replay "$reporter-pass.txt" 0)")"
  check "$reporter reporter, exit 0 -> pass / go (schema + rubric)" "$reporter-pass" --status success --verdict go --outcome AC-01=pass
  expect "$reporter reporter, exit 0: exit_code 0 is the recorded evidence" "$reporter-pass" \
    'ev("EV-01").exit_code === 0 && c("AC-01").evidence_ids[0] === "EV-01" && k("CK-01").executed === true'
  expect "$reporter reporter: counts are kept as reference text" "$reporter-pass" \
    "ev('EV-01').summary.includes('参考, $reporter') && ev('EV-01').summary.includes('tests 28 / pass 28')"

  run_plan "$reporter-fail" "$(one_criterion "npm test が通る ($reporter)" "$(replay "$reporter-fail.txt" 1)")"
  check "$reporter reporter, exit 1 -> fail / no_go (schema + rubric)" "$reporter-fail" --status success --verdict no_go --outcome AC-01=fail
  expect "$reporter reporter, exit 1: the output tail is the excerpt" "$reporter-fail" \
    'ev("EV-01").exit_code === 1 && ev("EV-01").output_excerpt.includes("fail 1") && d.blocking_reasons.length > 0'
done

# ---------------------------------------------------------------------------
# 2. Real node --test, both reporters, passing and failing projects.
# ---------------------------------------------------------------------------
mkdir -p "$PROJ/ok" "$PROJ/ng"
cat > "$PROJ/ok/a.test.mjs" <<'EOF'
import test from 'node:test';
import assert from 'node:assert/strict';
test('adds', () => assert.equal(1 + 1, 2));
test('concats', () => assert.equal('a' + 'b', 'ab'));
EOF
cat > "$PROJ/ng/a.test.mjs" <<'EOF'
import test from 'node:test';
import assert from 'node:assert/strict';
test('adds', () => assert.equal(1 + 1, 2));
test('broken', () => assert.equal(1, 2));
EOF
real_plan='{"issue_ref":"#299","environment":{"agent":"suite"},"criteria":[
  {"text":"spec pass","kind":"test","command":"cd ok && node --test --test-reporter=spec"},
  {"text":"tap pass","kind":"test","command":"cd ok && node --test --test-reporter=tap"},
  {"text":"spec fail","kind":"test","command":"cd ng && node --test --test-reporter=spec"},
  {"text":"tap fail","kind":"test","command":"cd ng && node --test --test-reporter=tap"}]}'
run_plan real "$real_plan"
check "real node --test: spec/tap exit 0 -> pass, exit 1 -> fail" real --status success --verdict no_go \
  --outcome AC-01=pass --outcome AC-02=pass --outcome AC-03=fail --outcome AC-04=fail
expect "real node --test: counts read from both reporters" real \
  'ev("EV-01").summary.includes("参考, spec") && ev("EV-02").summary.includes("参考, tap") && k("CK-01").kind === "test"'

# ---------------------------------------------------------------------------
# 3. No count line at all: the exit code alone decides.
# ---------------------------------------------------------------------------
run_plan nocount-pass "$(one_criterion "build が通る" "echo 'build finished'; exit 0")"
check "no counts, exit 0 -> pass" nocount-pass --verdict go --outcome AC-01=pass
expect "no counts: no count text is invented" nocount-pass '!ev("EV-01").summary.includes("参考")'
run_plan nocount-fail "$(one_criterion "build が通る" "echo 'build finished'; exit 2")"
check "no counts, exit 2 -> fail" nocount-fail --verdict no_go --outcome AC-01=fail

# Counts and exit code disagree: the exit code wins, and the note says so.
run_plan disagree "$(one_criterion "npm test が通る" "$(replay spec-fail.txt 0)")"
check "counts say fail 1 but exit 0 -> pass" disagree --verdict go --outcome AC-01=pass
expect "disagreement is written into the notes" disagree 'c("AC-01").notes.includes("判定には使わない")'

# ---------------------------------------------------------------------------
# 4. Rubric paths: flaky, timeout, confirm_required, manual, invalid plan.
# ---------------------------------------------------------------------------
flaky_cmd='if [ -f flag ]; then rm flag; exit 0; else touch flag; exit 1; fi'
run_plan flaky "$(printf '{"issue_ref":"#299","criteria":[{"text":"安定して通る","command":%s,"attempts":2,"next_action":{"action":"flaky の原因を調べる","owner":"開発リーダー"}}]}' "$(js "$flaky_cmd")")"
check "differing exit codes -> flaky / conditional_go" flaky --status partial --verdict conditional_go --outcome AC-01=flaky
expect "flaky keeps every attempt" flaky 'ev("EV-01").attempts.length === 2 && ev("EV-01").attempts[0].exit_code === 1 && ev("EV-01").attempts[1].exit_code === 0'

run_plan timeout '{"issue_ref":"#299","criteria":[{"text":"終わる","command":"sleep 5","timeout_sec":1}]}'
check "timeout -> not_run, no owner -> no_go" timeout --status partial --verdict no_go --outcome AC-01=not_run
expect "timeout: exit_code is null, never 0" timeout 'ev("EV-01").exit_code === null && ev("EV-01").summary.includes("timed out")'

run_plan confirm '{"issue_ref":"#299","environment":{"invocation":"non_interactive"},"criteria":[
  {"text":"DB に書く","command":"touch touched","risk_tier":"confirm_required","confirmation":{"granted":true,"cleanup_plan":"touched を削除する"},"next_action":{"action":"対話実行で承認を取る","owner":"user"}},
  {"text":"画面の表示","next_action":{"action":"画面を目視確認する","owner":"user"}}]}'
check "confirm_required in a non-interactive run -> not_run, manual -> manual_pending" confirm \
  --status partial --verdict conditional_go --outcome AC-01=not_run --outcome AC-02=manual_pending
if [ -e "$PROJ/touched" ]; then
  fail "confirm_required command was not executed" "touched exists"
else
  pass "confirm_required command was not executed"
fi
expect "non-interactive confirmation is recorded as not granted" confirm \
  'd.confirmations[0].granted === null && d.confirmations[0].requested === false && k("CK-01").executed === false'

run_plan invalid '{"issue_ref":"#299","criteria":[]}'
check "no criteria -> failure / no_go, still written" invalid --status failure --verdict no_go
printf 'not json' > "$WORK/broken.plan.json"
node "$RUNNER" --plan "$WORK/broken.plan.json" --out "$WORK/broken.json" --cwd "$PROJ" > /dev/null 2>&1; echo $? > "$WORK/broken.rc"
check "unreadable plan -> failure / no_go, still written" broken --status failure --verdict no_go
expect "unreadable plan: issue_ref is 'unspecified', not guessed" broken 'd.target.issue_ref === "unspecified"'

# ---------------------------------------------------------------------------
# 5. Redaction and truncation.
# ---------------------------------------------------------------------------
FAKE_TOKEN="ghp_$(printf 'A%.0s' $(seq 1 36))"
redact_cmd="echo \"token $FAKE_TOKEN in $PROJ/x\"; exit 0"
run_plan redact "$(one_criterion "secret を出す" "$redact_cmd")"
check "redacted output passes the redaction rules" redact --outcome AC-01=pass
if grep -q "$FAKE_TOKEN" "$WORK/redact.json" || grep -qF "$PROJ" "$WORK/redact.json"; then
  fail "token and absolute path are not written" "found in $WORK/redact.json"
else
  pass "token and absolute path are not written"
fi
expect "redacted entry is marked" redact 'ev("EV-01").redacted === true && ev("EV-01").output_excerpt.includes("<redacted:token>")'

run_plan long "$(one_criterion "大量出力" "i=0; while [ \$i -lt 5000 ]; do echo line-\$i; i=\$((i+1)); done; echo LAST-LINE; exit 0")"
check "long output -> pass, schema holds" long --outcome AC-01=pass
expect "long output keeps the tail and says it was cut" long \
  'ev("EV-01").truncated === true && ev("EV-01").output_excerpt.trimEnd().endsWith("LAST-LINE") && [...ev("EV-01").output_excerpt].length <= 4000'

# ---------------------------------------------------------------------------
# 5b. mem (CommandMate#4228 contract 2): an unreflected decision keeps an
#     all-pass run from `go` (verdict-rubric row 3b). mode off / no mem means
#     the caller passes no decisions and the run is exactly the old one.
# ---------------------------------------------------------------------------
mem_plan() { printf '{"issue_ref":"#4228","environment":{"agent":"suite"},%s"criteria":[{"text":"build が通る","command":"exit 0"}]}' "$1"; }
run_plan mem-off "$(mem_plan '')"
check "mem off / unavailable: no decisions -> go (unchanged)" mem-off --status success --verdict go --outcome AC-01=pass
expect "mem off: next_actions stays empty" mem-off 'd.next_actions.length === 0'
run_plan mem-empty "$(mem_plan '"unreflected_decisions":[],')"
check "mem on, nothing unreflected -> go" mem-empty --status success --verdict go --outcome AC-01=pass
run_plan mem-on "$(mem_plan '"unreflected_decisions":["dec-7"],')"
check "mem on, unreflected decision -> conditional_go (schema + rubric)" mem-on --status success --verdict conditional_go --outcome AC-01=pass
expect "mem on: the decision id is a next action owned by a person" mem-on \
  'd.next_actions.some((a) => a.action.includes("decision dec-7") && a.owner === "user") && d.verdict_reason.includes("dec-7")'
run_plan mem-fail "$(printf '{"issue_ref":"#4228","environment":{"agent":"suite"},"unreflected_decisions":["dec-7"],"criteria":[{"text":"x","command":"exit 1"}]}')"
check "mem on, a failing criterion still -> no_go" mem-fail --verdict no_go --outcome AC-01=fail

# D-12 / D-14: the summary names the branch mem was read from, only when mode was on.
# Structured fields and summary inclusion are checked separately (summary carries
# generated_at, so it is never compared byte for byte).
run_plan mem-br-on "$(mem_plan '"mem_read_branch":"h-on-cl","unreflected_decisions":["dec-7"],')"
check "mem on with a branch: structured result unchanged (conditional_go)" mem-br-on --status success --verdict conditional_go --outcome AC-01=pass
expect "mem on: summary_text names the branch that was read" mem-br-on 'd.summary_text.includes("読んだ枝 h-on-cl")'
run_plan mem-br-on0 "$(mem_plan '"mem_read_branch":"h-acc0",')"
check "mem on, no decision: go" mem-br-on0 --status success --verdict go --outcome AC-01=pass
expect "mem on, no decision: the branch is still named" mem-br-on0 'd.summary_text.includes("読んだ枝 h-acc0")'
expect "mem off: summary_text has no read-branch sentence" mem-off '!d.summary_text.includes("読んだ枝")'
# mem off and mem on0 (nothing unreflected) must agree on the structured fields.
off_s=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(JSON.stringify([d.status,d.verdict,d.unreflected_decisions||null,d.next_actions]))' "$WORK/mem-off.json")
on0_s=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(JSON.stringify([d.status,d.verdict,d.unreflected_decisions||null,d.next_actions]))' "$WORK/mem-br-on0.json")
[ "$off_s" = "$on0_s" ] && [ "$off_s" = '["success","go",null,[]]' ] \
  && pass "mem off and mem on0 agree on status, verdict, unreflected_decisions, next_actions" \
  || fail "mem off and mem on0 agree on status, verdict, unreflected_decisions, next_actions" "off=$off_s on0=$on0_s"
MEMB="$WORK/mutant-membr"
mkdir -p "$MEMB"
cp "$RUNNER" "$MEMB/run-acceptance.mjs"
sed -i.bak "s/  if (memBranch) lines.push(/  if (false \&\& memBranch) lines.push(/" "$MEMB/run-acceptance.mjs"
if cmp -s "$MEMB/run-acceptance.mjs" "$RUNNER"; then
  fail "read-branch mutation applied" "the summary line was not found"
else
  run_plan mutant-membr "$(mem_plan '"mem_read_branch":"h-on-cl",')" "$MEMB/run-acceptance.mjs"
  if node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(d.summary_text.includes("読んだ枝 h-on-cl")?0:1)' "$WORK/mutant-membr.json"; then
    fail "read-branch mutation killed" "a runner that drops the sentence still names the branch"
  else
    pass "read-branch mutation killed: dropping the sentence loses the branch name"
  fi
fi

grep -q 'mode が `on` のときだけ、読んだ枝の名を' "$SKILL_DIR/SKILL.md" \
  && grep -q '`mem_read_branch` に入れ' "$SKILL_DIR/SKILL.md" \
  && grep -q '`on` でないときは書かない' "$SKILL_DIR/SKILL.md" \
  && pass "SKILL.md: mem_read_branch only when mode is on, else no sentence" \
  || fail "SKILL.md: mem_read_branch only when mode is on, else no sentence" "sentence missing"
grep -q '`commandmate mem mode --json` の `branch`' "$SKILL_DIR/SKILL.md" \
  && pass "SKILL.md: mem_read_branch comes from mem mode --json branch" \
  || fail "SKILL.md: mem_read_branch comes from mem mode --json branch" "sentence missing"
grep -q 'mem mode --json' "$SKILL_DIR/SKILL.md" && ! grep -qE 'commandmate mem (add|update|close|promote)' "$SKILL_DIR/SKILL.md" \
  && pass "SKILL.md gates mem on mode and never writes to it" \
  || fail "SKILL.md gates mem on mode and never writes to it" "mode check missing or a mem write command is present"

# Control: a runner that ignores the decisions says `go`; the mem-on case must fail.
MEM="$WORK/mutant-mem"
mkdir -p "$MEM"
cp "$RUNNER" "$MEM/run-acceptance.mjs"
sed -i.bak "s/return decisions.length ? 'conditional_go' : 'go';/return 'go';/" "$MEM/run-acceptance.mjs"
if cmp -s "$MEM/run-acceptance.mjs" "$RUNNER"; then
  fail "mem mutation applied" "the decisions row was not found"
else
  run_plan mutant-mem-on "$(mem_plan '"unreflected_decisions":["dec-7"],')" "$MEM/run-acceptance.mjs"
  run_plan mutant-mem-off "$(mem_plan '')" "$MEM/run-acceptance.mjs"
  if python3 "$CHECK" "$WORK/mutant-mem-on.json" --verdict conditional_go >/dev/null 2>&1; then
    fail "mem mutation killed" "a runner that ignores decisions still said conditional_go"
  elif python3 "$CHECK" "$WORK/mutant-mem-off.json" --verdict go >/dev/null 2>&1; then
    pass "mem mutation killed: ignoring decisions turns mem-on into go (mem-off still go)"
  else
    fail "mem mutation killed" "the mutant broke the mem-off case too"
  fi
fi

# ---------------------------------------------------------------------------
# 6. Control: a runner that judges by TAP counts fails the spec case.
# ---------------------------------------------------------------------------
MUT="$WORK/mutant"
mkdir -p "$MUT"
cp "$RUNNER" "$MUT/run-acceptance.mjs"
sed -i.bak "s/^  return exitCode === 0 ? 'pass' : 'fail';\$/  return _counts \&\& _counts.format === 'tap' \&\& _counts.pass === _counts.tests ? 'pass' : 'fail';/" "$MUT/run-acceptance.mjs"
if cmp -s "$MUT/run-acceptance.mjs" "$RUNNER"; then
  fail "mutation applied" "the exit-code return line was not found"
else
  run_plan mutant-spec "$(one_criterion "npm test が通る (spec)" "$(replay spec-pass.txt 0)")" "$MUT/run-acceptance.mjs"
  run_plan mutant-tap "$(one_criterion "npm test が通る (tap)" "$(replay tap-pass.txt 0)")" "$MUT/run-acceptance.mjs"
  if python3 "$CHECK" "$WORK/mutant-spec.json" --verdict go --outcome AC-01=pass >/dev/null 2>&1; then
    fail "mutation killed" "a count-reading runner still passed the spec case"
  elif python3 "$CHECK" "$WORK/mutant-tap.json" --verdict go --outcome AC-01=pass >/dev/null 2>&1; then
    pass "mutation killed: a TAP-count judge calls spec exit 0 NO-GO (TAP still GO)"
  else
    fail "mutation killed" "the mutant broke the TAP case too; the control is not isolating the reporter"
  fi
fi

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
