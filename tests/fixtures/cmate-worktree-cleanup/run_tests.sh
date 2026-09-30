#!/usr/bin/env bash
# Regression tests for the cmate-worktree-cleanup runner (scripts/cleanup.mjs).
#
#   bash tests/fixtures/cmate-worktree-cleanup/run_tests.sh
#
# Everything runs against a real git repository built inside `mktemp -d`: a bare
# `origin`, the primary checkout, one worktree per case, and a second clone that
# plays GitHub's squash-merge button. Only `gh` is replaced — by a stub that
# answers `gh pr list --state merged ...` from per-branch JSON the suite writes,
# and fails loudly on any other subcommand.
#
# The cases (CommandMate#3010):
#   100 direct     merged with a real merge commit        -> direct, deleted
#   101 squash     one commit, squash-merged              -> merged_equivalent (patch_equivalent)
#   102 behind     commit, BEHIND -> git merge origin/main, commit, squash
#                                                          -> merged_equivalent (net_diff_equal)
#   103 mismatch   squash commit carries an extra change   -> unverifiable / tree_mismatch
#   104 dirty      squash-merged, then an uncommitted edit -> dirty, kept
#   105 advanced   squash-merged, then one more commit     -> unverifiable / head_oid_drift
#   the primary checkout                                   -> excluded current_worktree
#   a worktree on `develop` (--integration develop)        -> excluded integration_worktree
#
# Checked for both dry-run and apply: the decision, the proof path, the schema
# (cleanup-plan.v1 / cleanup-result.v1), the exit code, and what is actually
# still on disk and in refs afterwards. One mutation is injected: turning off
# the new sufficient condition (NET_DIFF_SUFFICIENT) must make case 102 fail.
#
# Requires bash, git and node (>= 18). No network: `origin` is a local bare repo.
set -u

SUITE_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SUITE_DIR/../../.." && pwd)
SKILL_DIR="$REPO_ROOT/skills/cmate-worktree-cleanup"
CHECK_SCHEMA="$SUITE_DIR/check-schema.mjs"

for tool in git node; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'cmate-worktree-cleanup suite: %s is required\n' "$tool" >&2
    exit 2
  fi
done

WORK=$(mktemp -d -t cmate-worktree-cleanup-tests.XXXXXX)
trap 'rm -rf "$WORK"' EXIT INT TERM
export WORK_DIR="$WORK"
WORK_REAL=$(cd "$WORK" && pwd -P)
export WORK_REAL

passed=0
failed=0

pass() { passed=$((passed + 1)); printf 'ok   %s\n' "$1"; }
fail() { failed=$((failed + 1)); printf 'FAIL %s\n     %s\n' "$1" "$2"; }

# expect <name> <json-file> <js-expression over d>
expect() {
  local name=$1 file=$2 expr=$3 out
  if out=$(node -e '
    const fs = require("fs");
    const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const c = (ref) => (d.candidates || []).find((x) => x.worktree_ref === ref);
    const rm = (ref) => (d.removed || []).find((x) => x.worktree_ref === ref);
    const sk = (ref) => (d.skipped || []).find((x) => x.worktree_ref === ref);
    const ex = (ref) => (d.excluded || []).find((x) => x.worktree_ref === ref);
    const noAbs = () => ![process.env.WORK_DIR, process.env.WORK_REAL, require("os").homedir()].some((p) => JSON.stringify(d).includes(p));
    const v = eval(process.argv[2]);
    if (v !== true) { console.log(JSON.stringify(v)); process.exit(1); }
  ' "$file" "$expr" 2>&1); then
    pass "$name"
  else
    fail "$name" "expected: $expr (got: $out)"
  fi
}

schema_ok() {
  local name=$1 schema=$2 file=$3 out
  if out=$(node "$CHECK_SCHEMA" "$SKILL_DIR/schemas/$schema" "$file" 2>&1); then
    pass "$name"
  else
    fail "$name" "$out"
  fi
}

# ---------------------------------------------------------------------------
# An isolated git identity: nothing from the maintainer's config leaks in.
# ---------------------------------------------------------------------------
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL="$WORK/gitconfig"
cat > "$GIT_CONFIG_GLOBAL" <<'CFG'
[user]
	name = Fixture
	email = fixture@example.invalid
[init]
	defaultBranch = main
[commit]
	gpgsign = false
[advice]
	detachedHead = false
CFG

q() { "$@" >/dev/null 2>&1 || { printf 'setup failed: %s\n' "$*" >&2; exit 2; }; }

ORIGIN="$WORK/origin.git"
PRIMARY="$WORK/Proj"
SERVER="$WORK/server"
WT="$WORK/wt"
GHDATA="$WORK/gh"
mkdir -p "$WT" "$GHDATA"

q git init --bare "$ORIGIN"
q git init "$PRIMARY"
printf 'base\n' > "$PRIMARY/README.md"
for f in a b c d e g; do printf 'line 1\nline 2\nline 3\n' > "$PRIMARY/$f.txt"; done
q git -C "$PRIMARY" add -A
q git -C "$PRIMARY" commit -m 'initial'
q git -C "$PRIMARY" remote add origin "$ORIGIN"
q git -C "$PRIMARY" push origin main
q git -C "$PRIMARY" push origin main:develop
q git -C "$PRIMARY" fetch origin
q git -C "$PRIMARY" remote set-head origin main
q git clone "$ORIGIN" "$SERVER"

M0=$(git -C "$PRIMARY" rev-parse HEAD)

# new_wt <issue> <slug> -> worktree Proj-issue-<n> on feature/<n>-<slug> at M0
new_wt() {
  q git -C "$PRIMARY" worktree add -b "feature/$1-$2" "$WT/Proj-issue-$1" "$M0"
}
commit_in() { # <dir> <file> <text> <msg>
  printf '%s\n' "$3" >> "$1/$2"
  q git -C "$1" add -A
  q git -C "$1" commit -m "$4"
}
# squash <branch> <pr-number> [extra-file] : squash-merge on the "server",
# push main, record the PR for the gh stub.
squash() {
  local branch=$1 num=$2 extra=${3:-} head merge
  q git -C "$SERVER" fetch origin
  q git -C "$SERVER" checkout -q main
  q git -C "$SERVER" reset -q --hard origin/main
  q git -C "$SERVER" merge --squash "origin/$branch"
  if [ -n "$extra" ]; then printf 'maintainer edit\n' >> "$SERVER/$extra"; q git -C "$SERVER" add -A; fi
  q git -C "$SERVER" commit -m "squash $branch (#$num)"
  q git -C "$SERVER" push origin main
  head=$(git -C "$SERVER" rev-parse "origin/$branch")
  merge=$(git -C "$SERVER" rev-parse HEAD)
  printf '[{"number":%s,"headRefName":"%s","baseRefName":"main","headRefOid":"%s","mergeCommit":{"oid":"%s"},"mergedAt":"2026-09-30T00:00:00Z"}]\n' \
    "$num" "$branch" "$head" "$merge" > "$GHDATA/$(printf '%s' "$branch" | tr '/' '_').json"
}

# 100 direct: a real merge commit into main.
new_wt 100 direct
commit_in "$WT/Proj-issue-100" a.txt 'direct change' 'direct'
q git -C "$WT/Proj-issue-100" push origin feature/100-direct
q git -C "$SERVER" fetch origin
q git -C "$SERVER" merge --no-ff -m 'merge 100' origin/feature/100-direct
q git -C "$SERVER" push origin main

# 101 squash: single commit, plain squash.
new_wt 101 squash
commit_in "$WT/Proj-issue-101" b.txt 'squash change' 'squash'
q git -C "$WT/Proj-issue-101" push origin feature/101-squash
squash feature/101-squash 11

# 102 behind: branch commit, main moved on, branch merges origin/main
# (the BEHIND round-trip), one more commit, then squash.
new_wt 102 behind
commit_in "$WT/Proj-issue-102" c.txt 'behind change 1' 'behind 1'
q git -C "$WT/Proj-issue-102" fetch origin
q git -C "$WT/Proj-issue-102" merge --no-edit origin/main
commit_in "$WT/Proj-issue-102" c.txt 'behind change 2' 'behind 2'
q git -C "$WT/Proj-issue-102" push origin feature/102-behind
squash feature/102-behind 12

# 103 mismatch: the squash commit carries a change the branch never had.
new_wt 103 mismatch
commit_in "$WT/Proj-issue-103" d.txt 'mismatch change' 'mismatch'
q git -C "$WT/Proj-issue-103" push origin feature/103-mismatch
squash feature/103-mismatch 13 g.txt

# 104 dirty: squash-merged properly, then an uncommitted edit in the worktree.
new_wt 104 dirty
commit_in "$WT/Proj-issue-104" e.txt 'dirty change' 'dirty'
q git -C "$WT/Proj-issue-104" push origin feature/104-dirty
squash feature/104-dirty 14
printf 'uncommitted\n' >> "$WT/Proj-issue-104/e.txt"

# 105 advanced: squash-merged, then the tip moved on (not pushed).
new_wt 105 advanced
printf 'x\n' > "$WT/Proj-issue-105/f.txt"
q git -C "$WT/Proj-issue-105" add -A
q git -C "$WT/Proj-issue-105" commit -m 'advanced'
q git -C "$WT/Proj-issue-105" push origin feature/105-advanced
squash feature/105-advanced 15
commit_in "$WT/Proj-issue-105" f.txt 'after the squash' 'after squash'

# An integration worktree on develop.
q git -C "$PRIMARY" worktree add "$WT/Proj-develop" develop

# The gh stub.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_STUB_LOG"
[ "${1:-}" = pr ] && [ "${2:-}" = list ] || { echo "gh stub: unexpected call: $*" >&2; exit 99; }
head=""
while [ $# -gt 0 ]; do
  case "$1" in --head) head=$2; shift ;; esac
  shift
done
f="$GH_STUB_DATA/$(printf '%s' "$head" | tr '/' '_').json"
if [ -f "$f" ]; then cat "$f"; else echo '[]'; fi
STUB
chmod +x "$WORK/bin/gh"
export GH_STUB_LOG="$WORK/gh.log" GH_STUB_DATA="$GHDATA"
export CMATE_WORKTREE_CLEANUP_GH="$WORK/bin/gh"

RUNNER="$SKILL_DIR/scripts/cleanup.mjs"
NOW=2026-09-30T00:00:00Z
ALL=100,101,102,103,104,105

run_cleanup() { # <runner> <out> args...
  local runner=$1 out=$2; shift 2
  (cd "$PRIMARY" && node "$runner" "$@" --integration develop --now "$NOW") > "$out" 2> "$out.err"
}

# ---------------------------------------------------------------------------
# 0. Version constant agrees with the manifest (validate.py checks lib.mjs too).
# ---------------------------------------------------------------------------
lib_v=$(sed -n "s/^export const SKILL_VERSION = '\(.*\)';/\1/p" "$SKILL_DIR/scripts/lib.mjs")
man_v=$(sed -n 's/^version: //p' "$SKILL_DIR/commandmate.skill.yaml")
[ "$lib_v" = "$man_v" ] && pass "SKILL_VERSION matches the manifest ($man_v)" || fail "SKILL_VERSION matches the manifest" "lib=$lib_v manifest=$man_v"

# ---------------------------------------------------------------------------
# 1. Invalid input is exit 2.
# ---------------------------------------------------------------------------
(cd "$PRIMARY" && node "$RUNNER" >/dev/null 2>&1); rc=$?
[ "$rc" = 2 ] && pass "no selection -> exit 2" || fail "no selection -> exit 2" "rc=$rc"
(cd "$PRIMARY" && node "$RUNNER" --issues 1 --all-eligible >/dev/null 2>&1); rc=$?
[ "$rc" = 2 ] && pass "both selections -> exit 2" || fail "both selections -> exit 2" "rc=$rc"
(cd "$PRIMARY" && node "$RUNNER" --issues abc >/dev/null 2>&1); rc=$?
[ "$rc" = 2 ] && pass "non-numeric issue -> exit 2" || fail "non-numeric issue -> exit 2" "rc=$rc"
(cd "$PRIMARY" && node "$RUNNER" --issues 1 --confirm x >/dev/null 2>&1); rc=$?
[ "$rc" = 2 ] && pass "--confirm without --apply -> exit 2" || fail "--confirm without --apply -> exit 2" "rc=$rc"

# ---------------------------------------------------------------------------
# 2. Dry-run: the plan.
# ---------------------------------------------------------------------------
before_refs=$(git -C "$PRIMARY" for-each-ref --format='%(refname) %(objectname)' refs/heads | sort)
before_wts=$(git -C "$PRIMARY" worktree list --porcelain | grep -c '^worktree ')

PLAN="$WORK/plan.json"
run_cleanup "$RUNNER" "$PLAN" --all-eligible; rc=$?
[ "$rc" = 1 ] && pass "dry-run exits 1 (some candidates skipped)" || fail "dry-run exits 1" "rc=$rc $(cat "$PLAN.err")"
schema_ok "dry-run plan conforms to cleanup-plan.v1" cleanup-plan.v1.json "$PLAN"
expect "plan is a dry_run" "$PLAN" 'd.mode === "dry_run"'
expect "100 direct -> delete" "$PLAN" 'c("Proj-issue-100").proof.type === "direct" && c("Proj-issue-100").decision === "delete" && c("Proj-issue-100").delete_method === "direct_branch_d"'
expect "101 squash -> merged_equivalent via patch_equivalent" "$PLAN" 'c("Proj-issue-101").proof.type === "merged_equivalent" && c("Proj-issue-101").proof.equivalence_path === "patch_equivalent" && c("Proj-issue-101").proof.cherry_unmatched === 0 && c("Proj-issue-101").decision === "delete"'
expect "102 BEHIND->merge->squash -> merged_equivalent via net_diff_equal" "$PLAN" 'c("Proj-issue-102").proof.type === "merged_equivalent" && c("Proj-issue-102").proof.equivalence_path === "net_diff_equal" && c("Proj-issue-102").decision === "delete" && c("Proj-issue-102").delete_method === "guarded_ref_delete"'
expect "102 records the git cherry + lines as evidence" "$PLAN" 'c("Proj-issue-102").proof.cherry_unmatched > 0 && c("Proj-issue-102").proof.tree_equal === true && c("Proj-issue-102").proof.pr_number === 12'
expect "103 diff mismatch -> tree_mismatch" "$PLAN" 'c("Proj-issue-103").proof.type === "unverifiable" && c("Proj-issue-103").skip_reason === "tree_mismatch" && c("Proj-issue-103").proof.tree_equal === false && c("Proj-issue-103").decision === "skip"'
expect "104 dirty -> skip dirty" "$PLAN" 'c("Proj-issue-104").state === "dirty" && c("Proj-issue-104").skip_reason === "dirty" && c("Proj-issue-104").decision === "skip"'
expect "105 tip advanced after squash -> head_oid_drift" "$PLAN" 'c("Proj-issue-105").proof.type === "unverifiable" && c("Proj-issue-105").skip_reason === "head_oid_drift" && c("Proj-issue-105").proof.head_oid_match === false'
expect "primary checkout excluded as current_worktree" "$PLAN" 'ex("Proj").reason === "current_worktree"'
expect "develop worktree excluded as integration_worktree" "$PLAN" 'ex("Proj-develop").reason === "integration_worktree"'
expect "plan carries no absolute path" "$PLAN" 'noAbs()'
expect "summary has the six headings in order" "$PLAN" '(() => { const h = ["## 判定","## 対象と profile","## 削除したもの","## 残したもの（理由つき）","## 診断と手動next action","## sync と走査範囲"]; let i = -1; return h.every((x) => { const j = d.summary_markdown.indexOf(x); const ok = j > i; i = j; return ok; }); })()'

after_refs=$(git -C "$PRIMARY" for-each-ref --format='%(refname) %(objectname)' refs/heads | sort)
after_wts=$(git -C "$PRIMARY" worktree list --porcelain | grep -c '^worktree ')
[ "$before_refs" = "$after_refs" ] && [ "$before_wts" = "$after_wts" ] && pass "dry-run deleted nothing" || fail "dry-run deleted nothing" "refs or worktrees changed"
if grep -qv '^pr list --state merged ' "$GH_STUB_LOG"; then fail "gh used read-only" "$(cat "$GH_STUB_LOG")"; else pass "gh used read-only (pr list only)"; fi

# issues selection narrows to the named issues.
run_cleanup "$RUNNER" "$WORK/plan-issues.json" --issues 102; rc=$?
[ "$rc" = 0 ] && pass "--issues 102 exits 0 (the only candidate is deletable)" || fail "--issues 102 exits 0" "rc=$rc"
expect "--issues 102 excludes the others as not_in_scope" "$WORK/plan-issues.json" 'd.candidates.length === 1 && ex("Proj-issue-101").reason === "not_in_scope"'

# ---------------------------------------------------------------------------
# 3. Mutation: without the new sufficient condition, 102 is tree_mismatch again.
# ---------------------------------------------------------------------------
MUT="$WORK/mutant"
mkdir -p "$MUT"
cp "$SKILL_DIR/scripts/"*.mjs "$MUT/"
sed -i.bak 's/^export const NET_DIFF_SUFFICIENT = true;/export const NET_DIFF_SUFFICIENT = false;/' "$MUT/lib.mjs"
if cmp -s "$MUT/lib.mjs" "$SKILL_DIR/scripts/lib.mjs"; then
  fail "mutation applied" "NET_DIFF_SUFFICIENT line not found"
else
  run_cleanup "$MUT/cleanup.mjs" "$WORK/plan-mutant.json" --all-eligible
  if node -e '
    const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const c = d.candidates.find((x) => x.worktree_ref === "Proj-issue-102");
    const c1 = d.candidates.find((x) => x.worktree_ref === "Proj-issue-101");
    process.exit(c.proof.type === "unverifiable" && c.skip_reason === "tree_mismatch" && c1.proof.type === "merged_equivalent" ? 0 : 1);
  ' "$WORK/plan-mutant.json"; then
    pass "mutation killed: without NET_DIFF_SUFFICIENT, 102 falls back to tree_mismatch (101 unaffected)"
  else
    fail "mutation killed" "the suite did not notice NET_DIFF_SUFFICIENT=false"
  fi
fi

# ---------------------------------------------------------------------------
# 4. --apply without --confirm stays a dry-run.
# ---------------------------------------------------------------------------
run_cleanup "$RUNNER" "$WORK/noconfirm.json" --all-eligible --apply
expect "--apply without --confirm stays dry_run" "$WORK/noconfirm.json" 'd.mode === "dry_run" && d.limitations.some((l) => l.includes("without --confirm"))'
after_refs=$(git -C "$PRIMARY" for-each-ref --format='%(refname) %(objectname)' refs/heads | sort)
[ "$before_refs" = "$after_refs" ] && pass "--apply without --confirm deleted nothing" || fail "--apply without --confirm deleted nothing" "refs changed"

# ---------------------------------------------------------------------------
# 5. plan_drift: a confirmed target whose tip moved after the reviewed plan.
# ---------------------------------------------------------------------------
tip101=$(git -C "$WT/Proj-issue-101" rev-parse HEAD)
commit_in "$WT/Proj-issue-101" b.txt 'moved after plan' 'moved'
run_cleanup "$RUNNER" "$WORK/drift.json" --all-eligible --apply --confirm feature/101-squash --plan "$PLAN"
schema_ok "drift result conforms to cleanup-result.v1" cleanup-result.v1.json "$WORK/drift.json"
expect "101 moved after the plan -> plan_drift, not removed" "$WORK/drift.json" 'sk("Proj-issue-101").reason === "plan_drift" && d.removed.length === 0'
[ -d "$WT/Proj-issue-101" ] && git -C "$PRIMARY" rev-parse --verify -q refs/heads/feature/101-squash >/dev/null \
  && pass "101 worktree and branch kept after plan_drift" || fail "101 kept after plan_drift" "it was deleted"
q git -C "$WT/Proj-issue-101" reset -q --hard "$tip101"

# ---------------------------------------------------------------------------
# 6. Apply: confirm every worktree, including the ones that must survive.
# ---------------------------------------------------------------------------
RESULT="$WORK/result.json"
run_cleanup "$RUNNER" "$RESULT" --all-eligible --apply \
  --confirm "Proj,Proj-develop,feature/100-direct,feature/101-squash,feature/102-behind,feature/103-mismatch,feature/104-dirty,feature/105-advanced" \
  --plan "$PLAN"; rc=$?
[ "$rc" = 1 ] && pass "apply exits 1 (some kept)" || fail "apply exits 1" "rc=$rc $(cat "$RESULT.err")"
schema_ok "apply result conforms to cleanup-result.v1" cleanup-result.v1.json "$RESULT"
expect "apply result is partial (unverifiable kept)" "$RESULT" 'd.mode === "apply" && d.status === "partial"'
expect "removed exactly 100, 101, 102" "$RESULT" 'd.removed.map((r) => r.worktree_ref).sort().join() === "Proj-issue-100,Proj-issue-101,Proj-issue-102"'
expect "100 removed with direct_branch_d" "$RESULT" 'rm("Proj-issue-100").method === "direct_branch_d" && rm("Proj-issue-100").branch_deleted === true && rm("Proj-issue-100").evidence.ancestor_verified === true'
expect "102 removed with guarded_ref_delete and net_diff_equal evidence" "$RESULT" 'rm("Proj-issue-102").method === "guarded_ref_delete" && rm("Proj-issue-102").branch_deleted && rm("Proj-issue-102").evidence.equivalence_path === "net_diff_equal" && rm("Proj-issue-102").evidence.expected_old_oid === rm("Proj-issue-102").tip && rm("Proj-issue-102").evidence.cherry_unmatched > 0'
expect "101 removed with patch_equivalent evidence" "$RESULT" 'rm("Proj-issue-101").evidence.equivalence_path === "patch_equivalent"'
expect "103/104/105 kept with their reasons" "$RESULT" 'sk("Proj-issue-103").reason === "tree_mismatch" && sk("Proj-issue-104").reason === "dirty" && sk("Proj-issue-105").reason === "head_oid_drift"'
expect "current and integration kept even when confirmed" "$RESULT" 'sk("Proj").reason === "current_worktree" && sk("Proj-develop").reason === "integration_worktree" && sk("Proj").proof_type === "excluded"'
expect "completion_check passed, six checks" "$RESULT" 'd.completion_check.passed === true && d.completion_check.checks.length === 6'
expect "worktree prune ran; sync skipped with a next action" "$RESULT" 'd.worktree_prune.ran === true && d.commandmate_sync.outcome === "skipped" && d.next_actions.some((a) => a.reason === "sync")'
expect "result carries no absolute path" "$RESULT" 'noAbs()'

for n in 100-direct 101-squash 102-behind; do
  issue=${n%%-*}
  if [ ! -e "$WT/Proj-issue-$issue" ] && ! git -C "$PRIMARY" rev-parse --verify -q "refs/heads/feature/$n" >/dev/null; then
    pass "$issue: worktree and branch are gone"
  else
    fail "$issue: worktree and branch are gone" "still present"
  fi
done
for n in 103-mismatch 104-dirty 105-advanced; do
  issue=${n%%-*}
  if [ -d "$WT/Proj-issue-$issue" ] && git -C "$PRIMARY" rev-parse --verify -q "refs/heads/feature/$n" >/dev/null; then
    pass "$issue: worktree and branch are kept"
  else
    fail "$issue: worktree and branch are kept" "deleted"
  fi
done
grep -q '^uncommitted$' "$WT/Proj-issue-104/e.txt" && pass "104's uncommitted edit survived" || fail "104's uncommitted edit survived" "lost"
[ -d "$WT/Proj-develop" ] && [ -f "$PRIMARY/README.md" ] && pass "primary and develop worktrees intact" || fail "primary and develop worktrees intact" "missing"

# ---------------------------------------------------------------------------
# 7. The shipped runner never forces anything.
# ---------------------------------------------------------------------------
if grep -nE "'--force'|'-D'|'-f'" "$SKILL_DIR/scripts/"*.mjs >/dev/null; then
  fail "no --force / -D in the runner" "$(grep -nE "'--force'|'-D'|'-f'" "$SKILL_DIR/scripts/"*.mjs)"
else
  pass "no --force / -D in the runner"
fi

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
