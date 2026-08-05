#!/usr/bin/env bash
# Regression tests for the cmate-issue-authoring split-plan validator.
#
#   bash tests/fixtures/cmate-issue-authoring/run_tests.sh
#
# Four things are proved here, in this order:
#
#  1. **The validator is not a rubber stamp.** Every rule it claims to enforce is
#     exercised by injecting one mutation into a conforming plan and requiring
#     that exact rule to fire. A checker nobody ever saw reject anything is a
#     checker whose green means nothing.
#  2. **Phase 1 cannot mutate GitHub.** The only executable this package ships is
#     the validator; it runs with a `gh` on PATH that records every invocation,
#     and the recording stays empty. The package's scripts are also grepped for
#     mutating verbs.
#  3. **The output reaches the target quality.** The conforming plan is rendered
#     the way Phase 2 renders it and fed to the real cmate-orchestrate planner,
#     which must produce a plan with zero blocking questions.
#  4. **The planner mirror has not drifted.** `mirror-conformance.mjs` compares
#     the mirrored extraction constants byte for byte and runs both copies over a
#     corpus, so the validator cannot go on telling an author their body is ready
#     while the planner reads it differently.
#
# Requires bash, node and the standard POSIX tools. No network: the planner runs
# from a fixture, and the `gh` on PATH is a shim that only writes a log.
set -u

SUITE_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SUITE_DIR/../../.." && pwd)
VALIDATOR="$REPO_ROOT/skills/cmate-issue-authoring/scripts/validate-plan.mjs"
SCHEMA="$REPO_ROOT/skills/cmate-issue-authoring/schemas/issue-split-plan.v1.json"
ORCHESTRATOR="$REPO_ROOT/skills/cmate-orchestrate/scripts/orchestrate.mjs"
CASES="$SUITE_DIR/cases"
FULL="$CASES/valid-full.json"
MINIMAL="$CASES/valid-minimal.json"

WORK=$(mktemp -d -t cmate-issue-authoring-tests.XXXXXX)
trap 'rm -rf "$WORK"' EXIT INT TERM

passed=0
failed=0
mutations=0

pass() { passed=$((passed + 1)); printf 'ok   %s\n' "$1"; }
fail() { failed=$((failed + 1)); printf 'FAIL %s\n     %s\n' "$1" "$2"; }

# expect_valid <name> <plan>
expect_valid() {
  local name="$1" plan="$2" out status
  out=$(node "$VALIDATOR" "$plan" 2>&1)
  status=$?
  if [ "$status" -eq 0 ]; then
    pass "$name"
  else
    fail "$name" "expected exit 0, got $status: $out"
  fi
}

# expect_exit <name> <expected-status> <args...>
expect_exit() {
  local name="$1" expected="$2"
  shift 2
  local out status
  out=$(node "$VALIDATOR" "$@" 2>&1)
  status=$?
  if [ "$status" -eq "$expected" ]; then
    pass "$name"
  else
    fail "$name" "expected exit $expected, got $status: $out"
  fi
}

# mutant <rule> <base> <op> <pointer> [value]
#
# Injects the mutation, requires exit 1, and requires the named rule to appear in
# the findings. Asserting the rule rather than only the exit status is what stops
# a mutant from "passing" because it happened to trip some unrelated check.
mutant() {
  local rule="$1" base="$2" op="$3" pointer="$4" value="${5:-}"
  local name="mutant: $op $pointer -> $rule"
  local plan="$WORK/mutant-$mutations.json"
  mutations=$((mutations + 1))

  if [ -n "$value" ]; then
    node "$SUITE_DIR/mutate.mjs" "$base" "$op" "$pointer" "$value" > "$plan" 2>"$WORK/mutate.err"
  else
    node "$SUITE_DIR/mutate.mjs" "$base" "$op" "$pointer" > "$plan" 2>"$WORK/mutate.err"
  fi
  if [ $? -ne 0 ]; then
    fail "$name" "the mutation itself failed: $(cat "$WORK/mutate.err")"
    return
  fi

  local out status
  out=$(node "$VALIDATOR" "$plan" 2>&1)
  status=$?
  if [ "$status" -ne 1 ]; then
    fail "$name" "expected exit 1 (invalid), got $status: $out"
    return
  fi
  case "$out" in
    *"FAIL $rule "*) pass "$name" ;;
    *) fail "$name" "rule $rule did not fire; findings were: $out" ;;
  esac
}

# expect_no_rule <name> <rule> <base> <op> <pointer> [value]
#
# The mirror image of `mutant`: inject the mutation and require the named rule
# NOT to appear. The exit status is deliberately not asserted — an unrelated rule
# may well fire on the mutated plan; what is being pinned is that THIS rule does
# not. Used for the cases a fix made legal, where "the suite is still green" is
# not evidence, because a rule that never fires is also never seen to stop.
expect_no_rule() {
  local name="$1" rule="$2" base="$3" op="$4" pointer="$5" value="${6:-}"
  local plan="$WORK/no-rule-$mutations.json"
  mutations=$((mutations + 1))

  if [ -n "$value" ]; then
    node "$SUITE_DIR/mutate.mjs" "$base" "$op" "$pointer" "$value" > "$plan" 2>"$WORK/mutate.err"
  else
    node "$SUITE_DIR/mutate.mjs" "$base" "$op" "$pointer" > "$plan" 2>"$WORK/mutate.err"
  fi
  if [ $? -ne 0 ]; then
    fail "$name" "the mutation itself failed: $(cat "$WORK/mutate.err")"
    return
  fi

  local out
  out=$(node "$VALIDATOR" "$plan" 2>&1)
  case "$out" in
    *"FAIL $rule "*) fail "$name" "rule $rule fired but should not have; findings were: $out" ;;
    *) pass "$name" ;;
  esac
}

printf '== conforming plans ==\n'
expect_valid 'valid-full is accepted' "$FULL"
expect_valid 'valid-minimal is accepted' "$MINIMAL"

printf '\n== schema layer ==\n'
mutant schema "$FULL" delete /plan_schema_version
mutant schema "$FULL" set /plan_schema_version 2
mutant schema "$FULL" set /skill_id '"cmate-issue-refinement"'
mutant schema "$FULL" set /generated_mode '"register"'
mutant schema "$FULL" set /repository '"not-a-slug"'
mutant schema "$FULL" set /source/digest '"nothex"'
mutant schema "$FULL" set /unexpected '"field"'
mutant schema "$FULL" set /issues '[]'
mutant schema "$FULL" delete /issues/0/objective
mutant schema "$FULL" set /issues/0/acceptance_criteria '"one string, not a list"'
mutant schema "$FULL" set /issues/0/acceptance_criteria '[]'
mutant schema "$FULL" set /issues/0/target_files '["/etc/passwd"]'
mutant schema "$FULL" set /issues/0/target_files '["../outside/secrets.ts"]'
mutant schema "$FULL" set /issues/0/key '"Session_Store"'
mutant schema "$FULL" set /issues/0/size '"xxl"'
mutant schema "$FULL" set /issues/0/parallel_safe true
mutant schema "$FULL" set /issues/0/evidence '[]'
mutant schema "$FULL" set /issues/0/nested '{"unknown":true}'
mutant schema "$FULL" set /open_questions/0/why_blocking '""'
mutant schema "$FULL" set /duplicate_suspicions/0/verdict '"probably"'
mutant schema "$FULL" set /commands/0/mutating '"no"'

printf '\n== rules a schema cannot state ==\n'
mutant plan_id_is_derived "$FULL" set /plan_id '"split-aaaaaaaaaaaa"'
mutant unique_issue_key "$FULL" set /issues/1/key '"session-store-rotation"'
mutant known_dependency "$FULL" set /issues/1/depends_on '["no-such-issue"]'
mutant known_dependency "$FULL" set /issues/1/depends_on '["rotation-metrics"]'
mutant acyclic_dependencies "$FULL" set /issues/0/depends_on '["rotation-metrics"]'
mutant dry_run_has_no_mutating_command "$FULL" set /commands/0/mutating true
mutant duplicate_needs_open_question "$FULL" set /open_questions '[]'
mutant duplicate_needs_open_question "$FULL" set /open_questions/0/blocks '[]'
mutant known_duplicate_target "$FULL" set /duplicate_suspicions/0/issue_key '"no-such-issue"'
mutant known_question_target "$FULL" set /open_questions/0/blocks '["no-such-issue"]'
mutant unique_question_id "$FULL" set /open_questions '[{"id":"q-dup","question":"a","why_blocking":"b","options":[],"blocks":["reuse-detection-tests"]},{"id":"q-dup","question":"c","why_blocking":"d","options":[],"blocks":[]}]'
mutant evidence_ref_stays_in_repo "$FULL" set /issues/0/evidence/0/ref '"/Users/someone/secrets.ts:1"'
mutant evidence_ref_stays_in_repo "$FULL" set /issues/0/evidence/0/ref '"../outside/secrets.ts:1"'
mutant body_states_objective "$FULL" set /issues/0/objective '"別の目的に差し替えた文"'
mutant body_lists_target_files "$FULL" set /issues/0/target_files '["src/auth/session-store.ts","src/auth/never-mentioned.ts"]'
mutant dependency_link_in_body "$FULL" set /issues/1/body '"rotate 回数と再利用検知回数を metrics endpoint から取得できるようにする。\n\n## 対象ファイル\n\n- `src/metrics/auth.ts`\n\n## 受入条件\n\n- [ ] `npm test -- src/metrics` が exit 0 で終わる\n"'
mutant dependency_link_in_body "$FULL" set /issues/2/body '"再利用された refresh token を replay する回帰テストを追加する。\n\n## 対象ファイル\n\n- `tests/auth/refresh.test.ts`\n\n## 受入条件\n\n- [ ] 新規ケースが通る\n\n## 依存\n\n- depends on {{issue:no-such-issue}}\n"'

# The two blocking questions the cmate-orchestrate planner can raise, injected
# one at a time. The second one is the asymmetry that is easy to get wrong: a
# plan may name plenty of paths and still leave `suspected_files` empty, because
# outside a deliverable heading every docs/ path and every .md/.rst/.txt file is
# classified as a reference. The heading is what decides it (Issue #50), so the
# body below lists its documents under 参考資料 — under 成果物 or 対象ファイル the
# very same paths ARE the deliverable, which the case after these two proves.
printf '\n== planner readiness ==\n'
mutant planner_ready "$MINIMAL" set /issues/0/body '"profile lookup の read 経路に read-through cache を挟み、同一 profile の連続参照を 1 回の DB 読み取りに落とす。\n\n## 対象ファイル\n\n- `src/cache/profile.ts`\n\n## やること\n\n- 実装する\n"'
mutant planner_ready "$MINIMAL" set /issues/0/body '"profile lookup の read 経路に read-through cache を挟み、同一 profile の連続参照を 1 回の DB 読み取りに落とす。\n\n## 参考資料\n\n- `docs/cache/profile.md`\n- `README.md`\n\n## 受入条件\n\n- [ ] 手順どおりに cache が効く\n"'

# Issue #50, from the authoring side: an Issue whose deliverable IS a document
# must not be told it is unready. The same docs/*.md path that reads as a
# reference under 参考資料 above is a suspected file under 成果物, so the planner
# raises no "Affected files are unclear" — which is what makes the Issue
# dispatchable with a scope at all.
expect_no_rule 'a document named under 成果物 is planner-ready' planner_ready "$MINIMAL" \
  set /issues/0/body '"profile cache の設計判断を ADR として残す。\n\n## 成果物\n\n- `docs/adr/0002-profile-cache.md`\n\n## 受入条件\n\n- [ ] ADR が採用案と却下案を述べている\n"'

printf '\n== the run itself failing is not the plan failing ==\n'
expect_exit 'no argument is a usage error' 2
expect_exit 'a missing plan file is an I/O error' 2 "$WORK/does-not-exist.json"
printf 'not json at all' > "$WORK/broken.json"
expect_exit 'an unparseable plan is an I/O error' 2 "$WORK/broken.json"
printf '[]' > "$WORK/array.json"
expect_exit 'a non-object plan is an I/O error' 2 "$WORK/array.json"
expect_exit 'a missing schema file is an I/O error' 2 "$FULL" --schema "$WORK/does-not-exist.json"
expect_exit '--help exits 0' 0 --help

printf '\n== phase 1 reaches no mutation path ==\n'

# A `gh` that records instead of running. If the validator ever grew a call to
# it, the log would exist and this case would fail — which is the point: the
# read-only claim is checked, not asserted.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/gh" <<'SHIM'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_CALL_LOG"
exit 1
SHIM
chmod +x "$WORK/bin/gh"
export GH_CALL_LOG="$WORK/gh-calls.log"

out=$(PATH="$WORK/bin:$PATH" node "$VALIDATOR" "$FULL" 2>&1)
status=$?
if [ "$status" -eq 0 ] && [ ! -f "$GH_CALL_LOG" ]; then
  pass 'the validator invokes gh zero times'
else
  fail 'the validator invokes gh zero times' "exit $status, log: $(cat "$GH_CALL_LOG" 2>/dev/null)"
fi

if grep -nE 'gh (issue|pr|api|release|repo) (create|edit|close|reopen|delete|merge|comment)|git (push|commit|tag)|--method (POST|PATCH|PUT|DELETE)' \
    "$REPO_ROOT/skills/cmate-issue-authoring/scripts/"*.mjs > "$WORK/mutating.txt" 2>/dev/null; then
  fail 'no shipped script names a mutating command' "$(cat "$WORK/mutating.txt")"
else
  pass 'no shipped script names a mutating command'
fi

# The plan artifact itself must not be able to claim a mutation happened: the
# dry-run rule above is what enforces it, and this is the positive control that
# the conforming plan really does record only read-only commands.
if node "$VALIDATOR" "$FULL" --json | grep -q '"valid": true'; then
  pass 'the conforming plan records only read-only commands'
else
  fail 'the conforming plan records only read-only commands' 'the conforming plan did not validate'
fi

printf '\n== dogfood: the real cmate-orchestrate planner ==\n'
node "$SUITE_DIR/to-issue-json.mjs" "$FULL" > "$WORK/issues.json"
if node "$ORCHESTRATOR" --issues 9000,9001,9002 \
      --issue-json "$WORK/issues.json" \
      --runs-dir "$WORK/runs" --run-id dogfood > "$WORK/orchestrate.out" 2>&1; then
  if node "$SUITE_DIR/assert-planner-clean.mjs" "$FULL" "$WORK/runs/dogfood/plan.json" > "$WORK/dogfood.txt" 2>&1; then
    sed 's/^/     /' "$WORK/dogfood.txt"
    pass 'the planner produced a plan with zero blocking questions'
  else
    sed 's/^/     /' "$WORK/dogfood.txt"
    fail 'the planner produced a plan with zero blocking questions' 'see the assertions above'
  fi
else
  fail 'the planner produced a plan with zero blocking questions' "the planner failed: $(cat "$WORK/orchestrate.out")"
fi

if grep -q '"code": "open_questions"' "$WORK/runs/dogfood/plan.json" 2>/dev/null; then
  fail 'the plan carries no open_questions risk factor' 'the planner recorded an open_questions risk factor'
else
  pass 'the plan carries no open_questions risk factor'
fi

# The validator's planner mirror is a verbatim copy of the extraction in
# cmate-orchestrate, and nothing but review used to keep the two identical. The
# conformance test compares the mirrored constants byte for byte AND runs both
# copies over a corpus that exercises each of them, so a divergence in the code
# around an unchanged constant is caught too. It deliberately compares only the
# mirrored region — never a digest of the whole planner, which would fail on any
# unrelated planner change.
#
# It exits 0 in sync, 1 drifted, 2 the comparison itself could not be made (a
# region marker moved, a constant was renamed); 2 is reported here as a failure
# distinct from drift, because "I could not look" must not read as "in sync".
printf '\n== the planner mirror is in sync ==\n'
if node "$SUITE_DIR/mirror-conformance.mjs" > "$WORK/mirror.txt" 2>&1; then
  sed 's/^/     /' "$WORK/mirror.txt"
  pass 'the planner mirror matches cmate-orchestrate'
else
  status=$?
  sed 's/^/     /' "$WORK/mirror.txt"
  if [ "$status" -eq 2 ]; then
    fail 'the planner mirror matches cmate-orchestrate' \
      'the conformance test could not run; fix its region markers before trusting any of this'
  else
    fail 'the planner mirror matches cmate-orchestrate' 'the mirror has drifted; see above'
  fi
fi

printf '\n%s mutation(s) injected\n' "$mutations"
printf '%s passed, %s failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ] || exit 1
