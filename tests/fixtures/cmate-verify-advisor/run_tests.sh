#!/usr/bin/env bash
# Regression tests for the cmate-verify-advisor layer-1 analyser.
#
#   bash tests/fixtures/cmate-verify-advisor/run_tests.sh
#   bash tests/fixtures/cmate-verify-advisor/run_tests.sh --mutants
#
# The three properties the acceptance criteria name are proved here, and each of
# them is shown to be load-bearing by `--mutants`, which breaks one guard at a
# time and requires the suite to go red:
#
#  1. **Determinism.** The same history produces the same report and the same
#     diff, byte for byte — including when the history array arrives in a
#     different order.
#  2. **The asymmetric rule.** A weakening is proposed and NOT applied, whatever
#     flags are passed; a layer-2 proposal is not applied even when it points in
#     the strengthening direction.
#  3. **Truncated log detection.** A failing gate whose stored log tail reached
#     the configured budget with no summary line in it produces a proposal to
#     RAISE the budget — and the same runs with a complete tail produce none.
#
# Two further properties are checked because getting them wrong is silent:
# no gate log body ever reaches the output (indirect prompt injection), and a
# file the tool writes is still parseable by cmate-verify's own runner.
#
# Requires bash, node and git. No network: every input is a fixture, and the
# `commandmate` the environment tests see is a shim.
set -u

SUITE_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SUITE_DIR/../../.." && pwd)
REAL_ADVISOR="$REPO_ROOT/skills/cmate-verify-advisor/scripts/verify-advisor.mjs"
VERIFY_RUN="$REPO_ROOT/skills/cmate-verify/scripts/verify-run.sh"
CASES="$SUITE_DIR/cases"
BASE="$CASES/baseline.yaml"
CANARY="CMATE-ADVISOR-INJECTION-CANARY"

ADVISOR=${ADVISOR:-$REAL_ADVISOR}

WORK=$(mktemp -d -t cmate-verify-advisor-tests.XXXXXX)
trap 'rm -rf "$WORK"' EXIT INT TERM

# --- mutation driver ---------------------------------------------------------
# `--mutants` re-runs this whole suite against a deliberately broken copy of the
# analyser, once per mutation, and requires each one to be caught. A surviving
# mutant is a guard nothing is testing.
if [ "${1:-}" = "--mutants" ]; then
  survivors=0
  mutants=0
  printf '== mutation injection ==\n'
  for name in $(node "$SUITE_DIR/mutate.mjs" --list | cut -f1); do
    mutants=$((mutants + 1))
    if ! node "$SUITE_DIR/mutate.mjs" "$REAL_ADVISOR" "$name" > "$WORK/mutant-$name.mjs" 2> "$WORK/mutant-$name.err"; then
      printf 'FAIL %s\n     the mutation could not be applied: %s\n' "$name" "$(cat "$WORK/mutant-$name.err")"
      survivors=$((survivors + 1))
      continue
    fi
    ADVISOR="$WORK/mutant-$name.mjs" bash "$0" > "$WORK/mutant-$name.log" 2>&1
    red=$(sed -n 's/^\([0-9]*\) passed, \([0-9]*\) failed$/\2/p' "$WORK/mutant-$name.log" | tail -1)
    red=${red:-0}
    if [ "$red" -gt 0 ]; then
      printf 'ok   %-40s %s assertion(s) went red\n' "$name" "$red"
    else
      printf 'FAIL %-40s SURVIVED — no assertion noticed\n' "$name"
      survivors=$((survivors + 1))
    fi
  done
  printf '\n%s mutant(s), %s survivor(s)\n' "$mutants" "$survivors"
  [ "$survivors" -eq 0 ] || exit 1
  exit 0
fi

passed=0
failed=0

pass() { passed=$((passed + 1)); printf 'ok   %s\n' "$1"; }
fail() { failed=$((failed + 1)); printf 'FAIL %s\n     %s\n' "$1" "$2"; }

# advise <case-file> [extra args...] -> stdout in $OUT, stderr in $ERR, status in $STATUS
OUT=""
ERR=""
STATUS=0
advise() {
  local input="$1"
  shift
  OUT="$WORK/out.$$.txt"
  ERR="$WORK/err.$$.txt"
  node "$ADVISOR" --cwd "$CASES" --config "$BASE" --input "$input" "$@" > "$OUT" 2> "$ERR"
  STATUS=$?
}

# assert_contains <name> <file> <needle>
assert_contains() {
  if grep -Fq -e "$3" "$2"; then pass "$1"; else fail "$1" "expected to find: $3"; fi
}

# assert_absent <name> <file> <needle>
assert_absent() {
  if grep -Fq -e "$3" "$2"; then fail "$1" "must not appear but did: $3"; else pass "$1"; fi
}

# assert_status <name> <expected>
assert_status() {
  if [ "$STATUS" -eq "$2" ]; then pass "$1"; else fail "$1" "expected exit $2, got $STATUS: $(head -3 "$ERR" 2>/dev/null)"; fi
}

# --- a worktree copy of a config, so --apply has something to write to
scratch_config() {
  local dir="$WORK/$1"
  mkdir -p "$dir"
  cp "${2:-$BASE}" "$dir/verify.yaml"
  printf '%s' "$dir"
}

printf '== the run itself failing is not the config failing ==\n'
node "$ADVISOR" --help > "$WORK/help.txt" 2>&1
[ $? -eq 0 ] && pass '--help exits 0' || fail '--help exits 0' "$(cat "$WORK/help.txt")"

node "$ADVISOR" --cwd "$CASES" --config "$CASES/does-not-exist.yaml" --input "$CASES/steady.json" > /dev/null 2> "$WORK/e1.txt"
[ $? -eq 2 ] && pass 'a missing config is exit 2' || fail 'a missing config is exit 2' "$(cat "$WORK/e1.txt")"

node "$ADVISOR" --cwd "$CASES" --config "$CASES/bad-config.yaml" --input "$CASES/steady.json" > /dev/null 2> "$WORK/e2.txt"
[ $? -eq 2 ] && pass 'a config outside the accepted subset is exit 2' || fail 'a config outside the accepted subset is exit 2' "$(cat "$WORK/e2.txt")"
assert_contains 'the rejected config says which line and why' "$WORK/e2.txt" 'unknown gate key: retries'

node "$ADVISOR" --cwd "$WORK" --config "$BASE" --input "$CASES/steady.json" > /dev/null 2> "$WORK/e3.txt"
[ $? -eq 2 ] && pass 'a config outside --cwd is refused' || fail 'a config outside --cwd is refused' "$(cat "$WORK/e3.txt")"

advise "$CASES/steady.json" --days 0
assert_status 'an out-of-range --days is exit 2' 2

printf '\n== no verification history is a stop, not a downgrade ==\n'
advise "$CASES/empty.json"
assert_status 'an empty history is exit 3' 3
assert_contains 'the empty-history message says nothing was guessed' "$ERR" 'nothing is proposed and nothing is guessed'

# A `commandmate` that predates `verify history`. The tool must stop with the
# version named, not fall back to some partial analysis.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/commandmate" <<'SHIM'
#!/usr/bin/env bash
case "$1" in
  --version) echo "0.10.2"; exit 0;;
  *) echo "error: unknown command 'verify'" >&2; exit 1;;
esac
SHIM
chmod +x "$WORK/bin/commandmate"
PATH="$WORK/bin:$PATH" node "$ADVISOR" --cwd "$CASES" --config "$BASE" > /dev/null 2> "$WORK/e4.txt"
[ $? -eq 3 ] && pass 'a CommandMate without verify history is exit 3' || fail 'a CommandMate without verify history is exit 3' "$(cat "$WORK/e4.txt")"
assert_contains 'the version gate names the version it found' "$WORK/e4.txt" '0.10.2'
assert_contains 'the version gate names the version it needs' "$WORK/e4.txt" '0.17.0'

node "$ADVISOR" --cwd "$CASES" --config "$BASE" --cli commandmate-does-not-exist > /dev/null 2> "$WORK/e5.txt"
[ $? -eq 3 ] && pass 'a missing CommandMate is exit 3' || fail 'a missing CommandMate is exit 3' "$(cat "$WORK/e5.txt")"

printf '\n== 1. layer 1 is deterministic ==\n'
advise "$CASES/steady.json"; cp "$OUT" "$WORK/run-a.txt"
advise "$CASES/steady.json"; cp "$OUT" "$WORK/run-b.txt"
if cmp -s "$WORK/run-a.txt" "$WORK/run-b.txt"; then
  pass 'the same history produces a byte-identical report'
else
  fail 'the same history produces a byte-identical report' "$(diff "$WORK/run-a.txt" "$WORK/run-b.txt" | head -20)"
fi

advise "$CASES/steady.json" --json; cp "$OUT" "$WORK/json-a.txt"
advise "$CASES/steady.json" --json; cp "$OUT" "$WORK/json-b.txt"
cmp -s "$WORK/json-a.txt" "$WORK/json-b.txt" \
  && pass 'the same history produces a byte-identical --json report' \
  || fail 'the same history produces a byte-identical --json report' "$(diff "$WORK/json-a.txt" "$WORK/json-b.txt" | head -20)"

# The same runs, handed over in a different order. A report that changes here is
# reading the order the CLI happened to return rather than the history itself.
node -e '
  const {readFileSync, writeFileSync} = require("node:fs");
  const s = JSON.parse(readFileSync(process.argv[1], "utf8"));
  s.history = [...s.history].sort((a, b) => a.id - b.id);
  s.details = [...s.details].reverse();
  writeFileSync(process.argv[2], JSON.stringify(s, null, 2) + "\n");
' "$CASES/steady.json" "$WORK/steady-shuffled.json"
advise "$WORK/steady-shuffled.json"
if cmp -s <(sed 's#^advisor: source=.*#advisor: source=X#' "$OUT") <(sed 's#^advisor: source=.*#advisor: source=X#' "$WORK/run-a.txt"); then
  pass 'a reordered history produces the same report'
else
  fail 'a reordered history produces the same report' "$(diff "$WORK/run-a.txt" "$OUT" | head -20)"
fi

# Two independent applications of the same proposals must produce the same file.
# The presentation order is part of the output, not an accident of the order the
# analyses happen to run in.
grep -o 'PROPOSAL [a-z0-9:-]*' "$WORK/run-a.txt" | sed 's/PROPOSAL //' > "$WORK/order.txt"
printf 'order:gates\ntimeout:build\ntimeout:lint\ntimeout:typecheck\ntimeout:unit\n' > "$WORK/order-expected.txt"
cmp -s "$WORK/order.txt" "$WORK/order-expected.txt" \
  && pass 'proposals are presented in a fixed order' \
  || fail 'proposals are presented in a fixed order' "$(cat "$WORK/order.txt")"

# A nearest-rank p99 over 120 samples sits below the maximum. A timeout under a
# duration that has actually been observed manufactures failures.
node "$ADVISOR" --cwd "$CASES" --config "$CASES/outlier.yaml" --input "$CASES/outlier.json" > "$WORK/outlier.txt" 2>&1
assert_contains 'a shortened timeout is floored at the slowest observed run' "$WORK/outlier.txt" 'change: 900 -> 400'

D1=$(scratch_config det1); D2=$(scratch_config det2)
node "$ADVISOR" --cwd "$D1" --config "$D1/verify.yaml" --input "$CASES/steady.json" --apply > /dev/null 2>&1
node "$ADVISOR" --cwd "$D2" --config "$D2/verify.yaml" --input "$CASES/steady.json" --apply > /dev/null 2>&1
cmp -s "$D1/verify.yaml" "$D2/verify.yaml" \
  && pass '--apply writes byte-identical files from the same history' \
  || fail '--apply writes byte-identical files from the same history' "$(diff "$D1/verify.yaml" "$D2/verify.yaml")"

# Applying twice is a no-op: the second run has no evidence for a change.
node "$ADVISOR" --cwd "$D1" --config "$D1/verify.yaml" --input "$CASES/steady.json" --apply > "$WORK/second-apply.txt" 2>&1
assert_contains '--apply is idempotent (the second run proposes nothing)' "$WORK/second-apply.txt" 'RESULT proposals=0'

assert_contains 'the gate comment travelled with its gate through the reorder' "$D1/verify.yaml" '# 1800s because'
if [ "$(grep -c 'id: ' "$D1/verify.yaml")" -eq 4 ]; then
  pass '--apply neither added nor dropped a gate'
else
  fail '--apply neither added nor dropped a gate' "$(cat "$D1/verify.yaml")"
fi

printf '\n== 2. the asymmetric rule ==\n'
advise "$CASES/slow.json"
assert_status 'a history full of weakenings still exits 0' 0
assert_contains 'a longer timeout is classified as a weakening' "$OUT" 'timeout:unit layer=1 kind=set-timeout direction=weaken applicable=no'
assert_contains 'a shorter timeout is classified as a strengthening' "$OUT" 'timeout:lint layer=1 kind=set-timeout direction=strengthen applicable=yes'
assert_contains 'the weakening is still proposed, with the human named as the gate' "$OUT" 'a human must review and merge it'

D3=$(scratch_config asym)
node "$ADVISOR" --cwd "$D3" --config "$D3/verify.yaml" --input "$CASES/slow.json" --apply > "$WORK/asym.txt" 2>&1
status=$?
[ "$status" -eq 0 ] && pass '--apply over a mixed proposal set exits 0' || fail '--apply over a mixed proposal set exits 0' "$(cat "$WORK/asym.txt")"
if grep -A2 'id: unit' "$D3/verify.yaml" | grep -q 'timeoutSec: 1800'; then
  pass '--apply did NOT raise the timeout it was asked to raise'
else
  fail '--apply did NOT raise the timeout it was asked to raise' "$(cat "$D3/verify.yaml")"
fi
if grep -A2 'id: lint' "$D3/verify.yaml" | grep -q 'timeoutSec: 30'; then
  pass '--apply did write the strengthening in the same run'
else
  fail '--apply did write the strengthening in the same run' "$(cat "$D3/verify.yaml")"
fi
assert_contains 'the withheld weakening is counted in the result line' "$WORK/asym.txt" 'withheld=1'

printf '\n-- layer 2 is proposal-only in BOTH directions --\n'
advise "$CASES/steady.json" --proposals "$CASES/layer2-mixed.json"
assert_status 'a layer-2 proposal file is accepted' 0
assert_contains 'a layer-2 gate addition is a strengthening' "$OUT" 'layer2:add-gate:migration-check layer=2 kind=add-gate direction=strengthen applicable=no'
assert_contains 'a strengthening from layer 2 is still not applicable' "$OUT" 'layer-2 proposals are never applied by this script'
assert_contains 'a layer-2 gate removal is a weakening' "$OUT" 'layer2:remove-gate:build layer=2 kind=remove-gate direction=weaken applicable=no'
assert_contains 'a smaller log budget is a weakening' "$OUT" 'layer2:option:maxLogTailBytes layer=2 kind=set-option direction=weaken applicable=no'
assert_contains 'the proposed diff still shows the gate being removed' "$OUT" '-  - id: build'
assert_contains 'the proposed diff still shows the gate being added' "$OUT" '+    command: "npm run check:migrations"'

D4=$(scratch_config layer2)
node "$ADVISOR" --cwd "$D4" --config "$D4/verify.yaml" --input "$CASES/steady.json" \
  --proposals "$CASES/layer2-mixed.json" --apply > "$WORK/layer2-apply.txt" 2>&1
status=$?
[ "$status" -eq 0 ] && pass '--apply with layer-2 proposals exits 0' || fail '--apply with layer-2 proposals exits 0' "$(cat "$WORK/layer2-apply.txt")"
assert_contains '--apply did not remove the gate layer 2 asked to remove' "$D4/verify.yaml" 'id: build'
assert_absent '--apply did not add the gate layer 2 asked to add' "$D4/verify.yaml" 'migration-check'
assert_contains '--apply did not shrink the log budget' "$D4/verify.yaml" 'maxLogTailBytes: 4096'

# A diff a human might merge has to leave a file the runner can still read.
node -e '
  const {writeFileSync} = require("node:fs");
  const gates = ["lint", "typecheck", "unit", "build"];
  writeFileSync(process.argv[1], JSON.stringify({proposals: gates.map((id) => ({
    kind: "remove-gate", gateId: id, rationale: "remove everything", evidence: [{runId: 108}],
  }))}));
' "$WORK/remove-all.json"
advise "$CASES/steady.json" --proposals "$WORK/remove-all.json"
assert_status 'a proposal set that empties the config still reports' 0
assert_contains 'a proposed config the runner would reject is called out' "$OUT" 'OBSERVATION proposed-config-invalid'

printf '\n-- a proposal nobody can review is refused --\n'
printf '{"proposals":[{"kind":"remove-gate","gateId":"build","evidence":[{"runId":1}]}]}' > "$WORK/no-rationale.json"
advise "$CASES/steady.json" --proposals "$WORK/no-rationale.json"
assert_status 'a layer-2 proposal without a rationale is exit 2' 2
printf '{"proposals":[{"kind":"remove-gate","gateId":"build","rationale":"x","evidence":[]}]}' > "$WORK/no-evidence.json"
advise "$CASES/steady.json" --proposals "$WORK/no-evidence.json"
assert_status 'a layer-2 proposal without evidence is exit 2' 2
printf '{"proposals":[{"kind":"reorder-gates","rationale":"x","evidence":[{"runId":1}]}]}' > "$WORK/layer1-kind.json"
advise "$CASES/steady.json" --proposals "$WORK/layer1-kind.json"
assert_status 'layer 2 may not hand-order the gates' 2

printf '\n-- options.requireCommit (Issue #57) --\n'
# The advisor and cmate-verify's runner read the same file. A key the runner
# accepts and the advisor does not is not a difference of opinion; it is the
# advisor refusing to read a config that was never wrong. `requireCommit` was
# exactly that for one release: valid to the runner (CommandMate #1642), exit 2
# here. The key-set agreement itself is pinned by parser-parity.sh; what is
# checked here is the behaviour that agreement is supposed to buy.
RC="$CASES/require-commit.yaml"
node "$ADVISOR" --cwd "$CASES" --config "$RC" --input "$CASES/steady.json" > "$WORK/rc.txt" 2> "$WORK/rc.err"
status=$?
[ "$status" -eq 0 ] && pass 'a config declaring requireCommit is read, not refused' \
  || fail 'a config declaring requireCommit is read, not refused' "exit $status: $(cat "$WORK/rc.err")"
assert_absent 'requireCommit is not reported as an unknown key' "$WORK/rc.err" 'unknown options key'

# The runner rejects anything but true/false, so accepting a third value here
# would let the advisor bless a config the next verify run stops on.
printf 'version: 1\ngates:\n  - id: lint\n    command: "npm run lint"\noptions:\n  requireCommit: maybe\n' > "$WORK/rc-bad.yaml"
node "$ADVISOR" --cwd "$WORK" --config "$WORK/rc-bad.yaml" --input "$CASES/steady.json" > /dev/null 2> "$WORK/rc-bad.err"
[ $? -eq 2 ] && pass 'a non-boolean requireCommit is exit 2' || fail 'a non-boolean requireCommit is exit 2' "$(cat "$WORK/rc-bad.err")"
assert_contains 'the rejected value is named the way the runner names it' "$WORK/rc-bad.err" 'options.requireCommit must be true or false'

# Turning it off drops the demand that the work be committed, so it is a
# weakening — and a weakening is never written, whatever flags are passed.
printf '{"proposals":[{"kind":"set-option","key":"requireCommit","value":"false","rationale":"agents keep leaving work uncommitted","evidence":[{"runId":108}]}]}' > "$WORK/rc-off.json"
node "$ADVISOR" --cwd "$CASES" --config "$RC" --input "$CASES/steady.json" --proposals "$WORK/rc-off.json" > "$WORK/rc-off.txt" 2>&1
assert_contains 'dropping requireCommit is classified as a weakening' "$WORK/rc-off.txt" 'layer2:option:requireCommit layer=2 kind=set-option direction=weaken applicable=no'

D6=$(scratch_config requirecommit "$RC")
node "$ADVISOR" --cwd "$D6" --config "$D6/verify.yaml" --input "$CASES/steady.json" \
  --proposals "$WORK/rc-off.json" --apply > "$WORK/rc-apply.txt" 2>&1
status=$?
[ "$status" -eq 0 ] && pass '--apply over a requireCommit proposal exits 0' || fail '--apply over a requireCommit proposal exits 0' "$(cat "$WORK/rc-apply.txt")"
assert_contains '--apply did NOT drop requireCommit' "$D6/verify.yaml" 'requireCommit: true'
# ... and the layer-1 strengthenings in the same run still landed, so the guard
# is refusing one change rather than the whole write.
assert_contains '--apply still wrote the layer-1 strengthening alongside it' "$D6/verify.yaml" 'timeoutSec: 30'

# The other direction is a strengthening, and is still not applied: it is a
# layer-2 proposal, and layer 2 is never written. `baseline.yaml` declares no
# requireCommit, so the runner default (false) is what it moves away from.
printf '{"proposals":[{"kind":"set-option","key":"requireCommit","value":"true","rationale":"uncommitted work kept being reported as finished","evidence":[{"runId":108}]}]}' > "$WORK/rc-on.json"
advise "$CASES/steady.json" --proposals "$WORK/rc-on.json"
assert_contains 'demanding a commit is classified as a strengthening' "$OUT" 'layer2:option:requireCommit layer=2 kind=set-option direction=strengthen applicable=no'
D7=$(scratch_config requirecommit-on)
node "$ADVISOR" --cwd "$D7" --config "$D7/verify.yaml" --input "$CASES/steady.json" \
  --proposals "$WORK/rc-on.json" --apply > /dev/null 2>&1
assert_absent '--apply did not write the layer-2 strengthening either' "$D7/verify.yaml" 'requireCommit'

printf '\n== 3. a truncated failure log raises the budget ==\n'
advise "$CASES/truncated.json"
assert_status 'the truncated-log history exits 0' 0
assert_contains 'a truncated failure tail proposes a bigger budget' "$OUT" 'log:maxLogTailBytes layer=1 kind=set-option direction=strengthen applicable=yes'
assert_contains 'the budget proposal says what it doubled' "$OUT" 'change: 4096 -> 8192'
assert_contains 'the budget proposal cites the run it read' "$OUT" 'logTailBytes=4096 cap=4096 summaryDetected=false'

# Three counter-cases, one per condition the detector ANDs together. Each is the
# same eight runs with the same two failures; only the stored tail differs.
advise "$CASES/steady.json"
assert_absent 'a short tail that carries its summary proposes nothing' "$OUT" 'log:maxLogTailBytes'
advise "$CASES/short-tail.json"
assert_absent 'a tail with no summary that never reached the cap proposes nothing' "$OUT" 'log:maxLogTailBytes'
advise "$CASES/capped-with-summary.json"
assert_absent 'a tail at the cap whose summary survived proposes nothing' "$OUT" 'log:maxLogTailBytes'

advise "$CASES/truncated.json" --no-details
assert_contains '--no-details reports that the check did not run' "$OUT" 'OBSERVATION log-tail-not-evaluated'
assert_absent '--no-details does not propose a budget change from data it lacks' "$OUT" 'log:maxLogTailBytes'

D5=$(scratch_config logbudget)
node "$ADVISOR" --cwd "$D5" --config "$D5/verify.yaml" --input "$CASES/truncated.json" --apply > /dev/null 2>&1
assert_contains '--apply raises the log budget' "$D5/verify.yaml" 'maxLogTailBytes: 8192'

printf '\n== gate logs are data, never instructions ==\n'
advise "$CASES/truncated.json"
assert_absent 'no gate log body reaches the text report' "$OUT" "$CANARY"
advise "$CASES/truncated.json" --json
assert_absent 'no gate log body reaches the --json report' "$OUT" "$CANARY"
assert_contains 'the report points at the command that prints the log instead' "$WORK/run-a.txt" 'read the log yourself: commandmate verify show'

printf '\n== changes are not invented ==\n'
advise "$CASES/sparse.json"
assert_status 'a history below --min-samples exits 0' 0
assert_contains 'zero proposals is stated as a normal outcome' "$OUT" 'no change proposed — this is a normal outcome'
assert_contains 'zero proposals says why' "$OUT" 'RESULT proposals=0'
assert_contains 'the under-sampled gates are named' "$OUT" 'OBSERVATION gate-under-sampled gate unit'

advise "$CASES/censored.json"
assert_contains 'a gate that hit its own timeout is reported' "$OUT" 'OBSERVATION timeout-censored gate build'
assert_absent 'no shorter timeout is argued for from censored runs' "$OUT" 'timeout:build'

advise "$CASES/flake.json"
assert_contains 'a fail-then-pass pair is surfaced as a candidate' "$OUT" 'OBSERVATION flake-candidate gate unit failed in run 401 and passed in run 402'
assert_contains 'the flake candidate names the evidence gap' "$OUT" 'verify history carries no commit sha'
assert_absent 'a flake candidate never becomes a proposal' "$OUT" 'PROPOSAL'

printf '\n== what is written is still a verify.yaml ==\n'
# cmate-verify's own runner is the reader that matters. Point it at the file the
# advisor wrote, in a directory that is not a git repository: it must fail on the
# git check, which it can only reach after parsing the config.
node "$ADVISOR" --cwd "$D5" --config "$D5/verify.yaml" --input "$CASES/steady.json" > /dev/null 2>&1
mkdir -p "$WORK/notgit"
bash "$VERIFY_RUN" --config "$D1/verify.yaml" --cwd "$WORK/notgit" > /dev/null 2> "$WORK/runner.txt"
if grep -q 'invalid config' "$WORK/runner.txt"; then
  fail "cmate-verify's runner accepts the file --apply wrote" "$(cat "$WORK/runner.txt")"
else
  pass "cmate-verify's runner accepts the file --apply wrote"
fi
bash "$VERIFY_RUN" --config "$D4/verify.yaml" --cwd "$WORK/notgit" > /dev/null 2> "$WORK/runner2.txt"
if grep -q 'invalid config' "$WORK/runner2.txt"; then
  fail "cmate-verify's runner accepts the file written alongside layer-2 proposals" "$(cat "$WORK/runner2.txt")"
else
  pass "cmate-verify's runner accepts the file written alongside layer-2 proposals"
fi

printf '\n== the two verify.yaml parsers agree ==\n'
# Runs the standalone parity suite as one assertion of this one, so it is not an
# orphan nobody executes. It reads the two shipped parsers, not $ADVISOR: parity
# is a property of what the packages ship, so a mutant copy is not its subject.
# Its own output is shown only when it fails.
if bash "$SUITE_DIR/parser-parity.sh" > "$WORK/parity.txt" 2>&1; then
  pass "the options keys of cmate-verify's runner and this advisor are the same set"
else
  fail "the options keys of cmate-verify's runner and this advisor are the same set" \
    "$(sed 's/^/       /' "$WORK/parity.txt")"
fi

# The suite is worthless if a case silently stopped running. This floor is the
# same guard cmate-verify's suite uses.
MIN_ASSERTIONS=78
total=$((passed + failed))
if [ "$total" -lt "$MIN_ASSERTIONS" ]; then
  fail 'the suite ran every case' "only $total assertion(s) ran, expected at least $MIN_ASSERTIONS"
fi

printf '\n%s passed, %s failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ] || exit 1
