#!/usr/bin/env bash
# Regression tests for cmate-handoff.
#
#   bash tests/fixtures/cmate-handoff/run_tests.sh
#
# The package ships no script: it is a procedure an Agent follows, and the
# runnable part of it is the bash templates in SKILL.md. What can be held
# mechanically is held here, in this order:
#
#  1. **Purpose and "what not to write" come first.** CommandMate#4228 made it an
#     acceptance criterion (the 2026-11-09 comment on the Issue): the body opens
#     with what the memory is for and what it must not hold, and only then the
#     rules of form. The first two `## ` headings are those two sections, they
#     sit before section 3, before the first fenced block and before the first
#     `--kind`, and each carries its literals.
#  2. **The check in 1 is not a rubber stamp.** The two sections are moved after
#     section 4, a heading is renamed, and every literal is deleted, one at a
#     time, from a copy of the real file; each change must be reported.
#  3. **The entry gate.** The first fenced block of SKILL.md is the mode check.
#     It is run against a `commandmate` stub for every answer `mem mode --json`
#     can give: on, off, derived, a CLI without `mem` (unknown command), the
#     server not running (exit 1), and a non-zero exit whose stdout still says
#     "on". Only the first is "use".
#  4. **The three-way control.** Every fenced block of SKILL.md is run, in
#     order, behind the gate, for mode on / mode off / no `mem` at all. With on,
#     each guarded block makes exactly one call; with off and with no `mem`, the
#     log holds the single `mem mode --json` and nothing else -- no write, no
#     read, no brief. Statically, every block after the gate is wrapped in
#     `if [ "${MEM}" = on ]; then ... fi`.
#  5. **The checks in 3 and 4 are not rubber stamps.** Three mutations of the
#     gate and the guards: the grep loosened to `"mode"`, the exit-code half of
#     the condition dropped, and one guard replaced by `if true`. Each must turn
#     a case red.
#  6. **What the package must not hold.** Nothing that depends on the screen
#     still being designed (the popup feature, "after G"), no new kind for a question, no promote/approve/purge call in a
#     runnable block, no `$<digit>` / `$ARGUMENTS` (Claude Code rewrites them
#     with the slash arguments), no plain-http URL. Each rule is exercised by
#     planting the forbidden text in a copy.
#
#  7. **The hand-off request before ending (section 11).** A request from the
#     screen's "end" button is answered with `handoff propose` (add / update /
#     close) and `handoff done`, never with `mem add` / `update` / `close`, and
#     only when the gate says on. The blocks of section 11 are run as written,
#     with the request id filled in: mode on proposes and returns (done last),
#     confirms nothing directly; mode off and no `mem` call nothing but
#     `mem mode --json`. Mutations: the procedure removed, a proposal replaced
#     by a direct `mem add`, a guard dropped, propose chained to done.
#
# Requires bash (3.2 is enough) and the POSIX tools. No network, no CommandMate
# server: `commandmate` on PATH is a stub that only writes a log.
set -u

SUITE_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SUITE_DIR/../../.." && pwd)
SKILL_DIR="$REPO_ROOT/skills/cmate-handoff"
SKILL_MD="$SKILL_DIR/SKILL.md"

WORK=$(mktemp -d -t cmate-handoff-tests.XXXXXX)
trap 'rm -rf "$WORK"' EXIT INT TERM

passed=0
failed=0
mutations=0

pass() { passed=$((passed + 1)); printf 'ok   %s\n' "$1"; }
fail() { failed=$((failed + 1)); printf 'FAIL %s\n     %s\n' "$1" "$2"; }

if [ ! -f "$SKILL_MD" ]; then
  printf 'FAIL SKILL.md not found: %s\n' "$SKILL_MD"
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. Purpose and what-not-to-write come first
# ---------------------------------------------------------------------------
H1='## 1. 何のための記憶か'
H2='## 2. 書かないもの'

# <rule><TAB><literal>. Every literal must sit inside sections 1-2.
REQUIRED='purpose: what the next session cannot re-read	次のセッションが環境から読み直せないもの
purpose: intent	**意図**
purpose: next step	**次の一手**
purpose: questions to a person	**人への質問とその答え待ち**
purpose: decisions	**決定**
purpose: traps	**罠**
purpose: the agent decides what to write	何を書くかは、この目的に照らしてあなたが判断する。
purpose: kinds are form, not reasons	kind の列挙は形であって、書く理由の一覧ではない。
purpose: anything else goes to note	`note` で書ける
not: nothing derivable from the source of truth	**正本から導けるものは書かない。**
not: copies go stale	古い写しは正本より強く読まれる
not: point with evidence instead	参照が要るなら `--evidence` に
not: long detail goes elsewhere	長い詳細は Issue や文書へ書き、項目には参照だけを残す。
not: one topic, one item	**同じことを複数の項目に書かない**
not: read the list before writing	書く前に `commandmate mem list` を読み
not: no decision a person did not make	人が言っていない「決定」'

# check_order <file>: prints the problems, returns 1 if any.
check_order() {
  local file="$1" problems=0 h1 h2 h3 first_fence first_kind first_heading second_heading
  first_heading=$(grep -n '^## ' "$file" | sed -n 1p)
  second_heading=$(grep -n '^## ' "$file" | sed -n 2p)
  case "$first_heading" in
    *":$H1") ;;
    *) printf 'first ## heading is not "%s": %s\n' "$H1" "$first_heading"; problems=1 ;;
  esac
  case "$second_heading" in
    *":$H2") ;;
    *) printf 'second ## heading is not "%s": %s\n' "$H2" "$second_heading"; problems=1 ;;
  esac
  h1=$(grep -n -F -x "$H1" "$file" | sed -n 1p | cut -d: -f1)
  h2=$(grep -n -F -x "$H2" "$file" | sed -n 1p | cut -d: -f1)
  h3=$(grep -n '^## 3\. ' "$file" | sed -n 1p | cut -d: -f1)
  first_fence=$(grep -n '^```' "$file" | sed -n 1p | cut -d: -f1)
  first_kind=$(grep -n -e '--kind' "$file" | sed -n 1p | cut -d: -f1)
  if [ -z "$h1" ] || [ -z "$h2" ] || [ -z "$h3" ]; then
    printf 'a heading is missing (1=%s 2=%s 3=%s)\n' "$h1" "$h2" "$h3"
    return 1
  fi
  [ "$h1" -lt "$h2" ] || { printf 'section 1 is not before section 2\n'; problems=1; }
  [ "$h2" -lt "$h3" ] || { printf 'section 2 is not before section 3\n'; problems=1; }
  if [ -n "$first_fence" ] && [ "$first_fence" -lt "$h3" ]; then
    printf 'a fenced block (line %s) comes before section 3\n' "$first_fence"; problems=1
  fi
  if [ -n "$first_kind" ] && [ "$first_kind" -lt "$h3" ]; then
    printf '--kind (line %s) comes before section 3\n' "$first_kind"; problems=1
  fi
  # Every literal inside lines [h1, h3).
  local region="$WORK/region.md"
  sed -n "${h1},$((h3 - 1))p" "$file" > "$region"
  while IFS='	' read -r rule literal; do
    [ -n "$literal" ] || continue
    if ! grep -q -F -e "$literal" "$region"; then
      printf 'missing from sections 1-2 (%s): %s\n' "$rule" "$literal"; problems=1
    fi
  done <<EOF
$REQUIRED
EOF
  return "$problems"
}

printf '== 1. purpose and what-not-to-write come first ==\n'
if out=$(check_order "$SKILL_MD" 2>&1); then
  pass 'SKILL.md opens with the purpose and what-not-to-write, with every literal'
else
  fail 'SKILL.md opens with the purpose and what-not-to-write, with every literal' "$out"
fi

# ---------------------------------------------------------------------------
# 2. The order check is not a rubber stamp
# ---------------------------------------------------------------------------
printf '\n== 2. every rule of the order check is exercised by a mutation ==\n'

expect_order_rejected() {
  local name="$1" copy="$2" out
  mutations=$((mutations + 1))
  if cmp -s "$SKILL_MD" "$copy"; then
    fail "$name" 'the mutation changed nothing'
    return
  fi
  if out=$(check_order "$copy" 2>&1); then
    fail "$name" 'check_order accepted the mutated file'
  else
    pass "$name"
  fi
}

# 2a. Sections 1-2 moved after section 4 (the rules first, the purpose later).
copy="$WORK/moved.md"
awk -v h1="$H1" '
  $0 == h1 { grab = 1 }
  /^## 3\. / { grab = 0 }
  /^## 5\. / && !done { printf "%s", held; done = 1 }
  grab { held = held $0 "\n"; next }
  { print }
' "$SKILL_MD" > "$copy"
expect_order_rejected 'sections 1-2 moved after section 4 are caught' "$copy"

# 2b. The first heading renamed.
copy="$WORK/renamed.md"
sed "s/^$H1\$/## 1. 概要/" "$SKILL_MD" > "$copy"
expect_order_rejected 'a renamed purpose heading is caught' "$copy"

# 2c. A rule written before the purpose.
copy="$WORK/rule-first.md"
awk -v h1="$H1" '$0 == h1 && !done { print "Use `commandmate mem add --kind note` for failures only."; print ""; done = 1 } { print }' \
  "$SKILL_MD" > "$copy"
expect_order_rejected 'a --kind rule placed before the purpose is caught' "$copy"

# 2d. Each literal deleted, one at a time (the whole line goes, as in an edit).
while IFS='	' read -r rule literal; do
  [ -n "$literal" ] || continue
  copy="$WORK/literal.md"
  LITERAL="$literal" awk 'BEGIN { n = ENVIRON["LITERAL"] } index($0, n) == 0 { print }' "$SKILL_MD" > "$copy"
  expect_order_rejected "removing the literal is caught ($rule)" "$copy"
done <<EOF
$REQUIRED
EOF

# ---------------------------------------------------------------------------
# The commandmate stub and the block extractor
# ---------------------------------------------------------------------------
mkdir -p "$WORK/bin"
cat > "$WORK/bin/commandmate" <<'STUB'
#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >> "$CMATE_STUB_LOG"
case "${CMATE_STUB_MODE:-on}" in
  nomem)
    if [ "${1:-}" = mem ] || [ "${1:-}" = brief ] || [ "${1:-}" = handoff ]; then
      printf "error: unknown command '%s'\n" "$1" >&2
      exit 1
    fi
    ;;
  down)
    printf 'error: the CommandMate server is not running\n' >&2
    exit 1
    ;;
esac
if [ "${1:-}" = mem ] && [ "${2:-}" = mode ]; then
  case "$CMATE_STUB_MODE" in
    on|off|derived)
      printf '{\n  "mode": "%s",\n  "features": {\n    "injectOnStart": true\n  }\n}\n' "$CMATE_STUB_MODE"
      exit 0
      ;;
    lie)
      printf '{\n  "mode": "on"\n}\n'
      exit 52
      ;;
  esac
fi
case "${1:-}" in
  mem|brief|handoff) printf 'stub: ok\n'; exit 0 ;;
esac
printf 'stub: cmate-handoff must never call: %s\n' "$*" >&2
exit 97
STUB
chmod +x "$WORK/bin/commandmate"
PATH="$WORK/bin:$PATH"
export PATH

# extract_blocks <SKILL.md> <dir>: writes block-01.sh, block-02.sh, ... for every
# fenced ```bash block, in order. Prints the count.
extract_blocks() {
  local file="$1" dir="$2"
  rm -rf "$dir"; mkdir -p "$dir"
  awk -v dir="$dir" '
    /^```bash[[:space:]]*$/ && !inside { inside = 1; n++; out = sprintf("%s/block-%02d.sh", dir, n); printf "" > out; next }
    /^```[[:space:]]*$/ && inside { inside = 0; close(out); next }
    inside { print >> out }
    END { print n + 0 }
  ' "$file"
}

# run_gate <SKILL.md> <mode>: runs block 1 only, prints the mem= value.
run_gate() {
  local file="$1" mode="$2" dir="$WORK/gate-blocks"
  extract_blocks "$file" "$dir" >/dev/null
  CMATE_STUB_LOG="$WORK/gate.log" CMATE_STUB_MODE="$mode" bash "$dir/block-01.sh" 2>/dev/null \
    | sed -n 's/^mem=//p' | tail -1
}

# run_all <SKILL.md> <mode> <log>: runs every block in one shell, gate first.
run_all() {
  local file="$1" mode="$2" log="$3" dir="$WORK/all-blocks" script="$WORK/all.sh"
  extract_blocks "$file" "$dir" >/dev/null
  : > "$log"
  cat "$dir"/block-*.sh > "$script"
  CMATE_STUB_LOG="$log" CMATE_STUB_MODE="$mode" bash "$script" >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# 3. The entry gate
# ---------------------------------------------------------------------------
printf '\n== 3. the entry gate says "use" for mode on and nothing else ==\n'

blocks=$(extract_blocks "$SKILL_MD" "$WORK/blocks")
if grep -q -F 'cmate-handoff: mem の入口の判定' "$WORK/blocks/block-01.sh" 2>/dev/null \
  && grep -q -F 'commandmate mem mode --json' "$WORK/blocks/block-01.sh"; then
  pass "the first fenced block is the mem mode gate ($blocks blocks in SKILL.md)"
else
  fail 'the first fenced block is the mem mode gate' "block-01: $(cat "$WORK/blocks/block-01.sh" 2>/dev/null)"
fi

# <mode><TAB><expected>
GATE_CASES='on	on
off	off
derived	off
nomem	off
down	off
lie	off'

check_gate() {
  local file="$1" problems=0 mode want got
  while IFS='	' read -r mode want; do
    got=$(run_gate "$file" "$mode")
    if [ "$got" != "$want" ]; then
      printf 'mode=%s: want mem=%s, got mem=%s\n' "$mode" "$want" "$got"; problems=1
    fi
  done <<EOF
$GATE_CASES
EOF
  return "$problems"
}

while IFS='	' read -r mode want; do
  got=$(run_gate "$SKILL_MD" "$mode")
  if [ "$got" = "$want" ]; then
    pass "gate: mem mode answers $mode -> mem=$want"
  else
    fail "gate: mem mode answers $mode -> mem=$want" "got mem=$got"
  fi
done <<EOF
$GATE_CASES
EOF

# ---------------------------------------------------------------------------
# 4. The three-way control
# ---------------------------------------------------------------------------
printf '\n== 4. mode on / off / no mem: count the calls behind the gate ==\n'

check_guards_static() {
  local dir="$1" problems=0 f first last
  for f in "$dir"/block-*.sh; do
    [ "$f" = "$dir/block-01.sh" ] && continue
    first=$(grep -v '^[[:space:]]*$' "$f" | sed -n 1p)
    last=$(grep -v '^[[:space:]]*$' "$f" | tail -1)
    if [ "$first" != 'if [ "${MEM}" = on ]; then' ] || [ "$last" != 'fi' ]; then
      printf '%s is not wrapped in the MEM guard: %s ... %s\n' "$(basename "$f")" "$first" "$last"
      problems=1
    fi
  done
  return "$problems"
}

if out=$(check_guards_static "$WORK/blocks" 2>&1); then
  pass "every block after the gate is wrapped in if [ \"\${MEM}\" = on ]"
else
  fail 'every block after the gate is wrapped in the MEM guard' "$out"
fi

# check_control <SKILL.md>: on -> one call per guarded block; off / nomem -> only mem mode.
check_control() {
  local file="$1" problems=0 n guarded calls mode log
  n=$(extract_blocks "$file" "$WORK/ctl-blocks")
  guarded=$((n - 1))
  log="$WORK/ctl.log"
  run_all "$file" on "$log"
  calls=$(grep -v -c -x 'mem mode --json' "$log")
  if [ "$calls" -ne "$guarded" ]; then
    printf 'mode on: want %s calls behind the gate, got %s\n' "$guarded" "$calls"; problems=1
  fi
  if grep -q '^mem \(now\|add\|update\|close\|check\)' "$log" && grep -q '^brief' "$log"; then :; else
    printf 'mode on: the writes / check / brief were not reached\n'; problems=1
  fi
  for mode in off nomem; do
    run_all "$file" "$mode" "$log"
    if [ "$(cat "$log")" != 'mem mode --json' ]; then
      printf 'mode %s: calls other than mem mode: %s\n' "$mode" "$(grep -v -x 'mem mode --json' "$log" | tr '\n' ';')"
      problems=1
    fi
  done
  return "$problems"
}

for mode in on off nomem; do
  log="$WORK/control-$mode.log"
  run_all "$SKILL_MD" "$mode" "$log"
  writes=$(grep -c '^mem \(now\|add\|update\|close\|check\)' "$log")
  others=$(grep -v -c -x 'mem mode --json' "$log")
  case "$mode" in
    on)
      if [ "$writes" -gt 0 ] && [ "$others" -eq $((blocks - 1)) ]; then
        pass "mode on: every guarded block runs once ($others calls, $writes of them writes / checks)"
      else
        fail 'mode on: every guarded block runs once' "others=$others writes=$writes blocks=$blocks"
      fi
      ;;
    *)
      if [ "$others" -eq 0 ] && [ "$(cat "$log")" = 'mem mode --json' ]; then
        pass "mode $mode: only mem mode --json is called (0 writes, 0 reads, 0 brief)"
      else
        fail "mode $mode: only mem mode --json is called" "$(tr '\n' ';' < "$log")"
      fi
      ;;
  esac
done

# ---------------------------------------------------------------------------
# 5. The gate and the guards are not rubber stamps
# ---------------------------------------------------------------------------
printf '\n== 5. mutations of the gate and the guards are caught ==\n'

# 5a. The grep loosened to any mode.
mutations=$((mutations + 1))
copy="$WORK/loose.md"
sed 's/grep -q '"'"'"mode": "on"'"'"'/grep -q '"'"'"mode"'"'"'/' "$SKILL_MD" > "$copy"
if cmp -s "$SKILL_MD" "$copy"; then
  fail 'a gate that matches any mode is caught' 'the mutation changed nothing'
elif out=$(check_gate "$copy" 2>&1); then
  fail 'a gate that matches any mode is caught' 'check_gate accepted it'
else
  pass "a gate that matches any mode is caught ($(printf '%s' "$out" | head -1))"
fi

# 5b. The exit-code half of the condition dropped.
mutations=$((mutations + 1))
copy="$WORK/noexit.md"
sed 's/^if MEM_MODE_JSON=\$(commandmate mem mode --json 2>\/dev\/null) \\$/MEM_MODE_JSON=$(commandmate mem mode --json 2>\/dev\/null); if true \\/' \
  "$SKILL_MD" > "$copy"
if cmp -s "$SKILL_MD" "$copy"; then
  fail 'a gate that ignores the exit code is caught' 'the mutation changed nothing'
elif out=$(check_gate "$copy" 2>&1); then
  fail 'a gate that ignores the exit code is caught' 'check_gate accepted it'
else
  pass "a gate that ignores the exit code is caught ($(printf '%s' "$out" | head -1))"
fi

# 5c. One guard replaced by `if true` (the first write block after the gate).
mutations=$((mutations + 1))
copy="$WORK/unguarded.md"
awk '!done && $0 == "if [ \"${MEM}\" = on ]; then" { print "if true; then"; done = 1; next } { print }' \
  "$SKILL_MD" > "$copy"
if cmp -s "$SKILL_MD" "$copy"; then
  fail 'an unguarded block is caught by the off / no-mem control' 'the mutation changed nothing'
elif out=$(check_control "$copy" 2>&1); then
  fail 'an unguarded block is caught by the off / no-mem control' 'check_control accepted it'
else
  pass "an unguarded block is caught by the off / no-mem control ($(printf '%s' "$out" | head -1))"
fi

# The unmutated file passes the same two checks (so 5a-5c are not vacuous).
if out=$(check_gate "$SKILL_MD" 2>&1) && out2=$(check_control "$SKILL_MD" 2>&1); then
  pass 'the real SKILL.md passes check_gate and check_control'
else
  fail 'the real SKILL.md passes check_gate and check_control' "${out:-} ${out2:-}"
fi

# ---------------------------------------------------------------------------
# 6. What the package must not hold
# ---------------------------------------------------------------------------
printf '\n== 6. the package holds nothing it must not ==\n'

# check_forbidden <SKILL.md>: the package files are read next to it.
check_forbidden() {
  local file="$1" problems=0 dir pkg_files hits
  dir=$(dirname "$file")
  pkg_files="$file $(find "$dir/references" -name '*.md' 2>/dev/null | sort | tr '\n' ' ')"
  # shellcheck disable=SC2086
  if hits=$(grep -n -e 'popup' $pkg_files); then
    printf 'depends on the screen still being designed: %s\n' "$hits"; problems=1
  fi
  # shellcheck disable=SC2086
  if hits=$(grep -n -e 'G の後' -e 'G-PR' $pkg_files); then
    printf 'mentions the later screen work: %s\n' "$hits"; problems=1
  fi
  # shellcheck disable=SC2086
  if hits=$(grep -n -E -e '--kind[ =]+(question|ask|human)' $pkg_files); then
    printf 'adds a kind: %s\n' "$hits"; problems=1
  fi
  extract_blocks "$file" "$WORK/forbid-blocks" >/dev/null
  if hits=$(cat "$WORK/forbid-blocks"/block-*.sh | grep -n -E 'mem (purge|promote|approve)|handoff (approve|cancel|end)|confirm-reflected|curl '); then
    printf 'a runnable block calls what the skill must not: %s\n' "$hits"; problems=1
  fi
  if hits=$(grep -n -E '\$[0-9]|\$ARGUMENTS' "$file"); then
    printf 'slash-argument placeholder in SKILL.md: %s\n' "$hits"; problems=1
  fi
  # shellcheck disable=SC2086
  if hits=$(grep -n 'http://' $pkg_files); then
    printf 'plain-http URL: %s\n' "$hits"; problems=1
  fi
  return "$problems"
}

if out=$(check_forbidden "$SKILL_MD" 2>&1); then
  pass 'SKILL.md and references hold none of the forbidden text'
else
  fail 'SKILL.md and references hold none of the forbidden text' "$out"
fi

# Each rule exercised by planting the text in a copy of the package.
PLANTS='popup	Read features.popup to see whether a person is watching.
later screen work	G の後で足す。
a new kind	commandmate mem add --kind question --text "x"
purge in a block	```bash
slash argument	Use "$1" as the issue number.
plain http	See http://localhost:3000/mem for the screen.'

while IFS='	' read -r rule text; do
  [ -n "$rule" ] || continue
  mutations=$((mutations + 1))
  pkg="$WORK/pkg-$mutations"
  rm -rf "$pkg"; mkdir -p "$pkg"
  cp -R "$SKILL_DIR/." "$pkg/"
  if [ "$rule" = 'purge in a block' ]; then
    printf '\n```bash\nif [ "${MEM}" = on ]; then\n  commandmate mem purge --confirm\nfi\n```\n' >> "$pkg/SKILL.md"
  else
    printf '\n%s\n' "$text" >> "$pkg/SKILL.md"
  fi
  if out=$(check_forbidden "$pkg/SKILL.md" 2>&1); then
    fail "planting is caught ($rule)" 'check_forbidden accepted it'
  else
    pass "planting is caught ($rule)"
  fi
done <<EOF
$PLANTS
EOF

# ---------------------------------------------------------------------------
# 7. The hand-off request before ending (section 11)
# ---------------------------------------------------------------------------
printf '\n== 7. a request from the "end" button: propose, never confirm ==\n'

H11='## 11. 終了の前の引き継ぎの依頼'

# section_blocks <SKILL.md> <dir>: block-NN.sh for the fenced bash blocks under
# H11 only (the next `## ` heading, or the end, closes the section).
section_blocks() {
  local file="$1" dir="$2"
  rm -rf "$dir"; mkdir -p "$dir"
  awk -v dir="$dir" -v h="$H11" '
    $0 == h { sec = 1; next }
    /^## / && sec { sec = 0 }
    sec && /^```bash[[:space:]]*$/ && !inside { inside = 1; n++; out = sprintf("%s/block-%02d.sh", dir, n); printf "" > out; next }
    sec && /^```[[:space:]]*$/ && inside { inside = 0; close(out); next }
    sec && inside { print >> out }
    END { print n + 0 }
  ' "$file"
}

# run_request <SKILL.md> <mode> <log>: the gate, then the section-11 blocks, in
# one shell, as an Agent that received a request would run them.
run_request() {
  local file="$1" mode="$2" log="$3" gate="$WORK/req-gate" sec="$WORK/req-sec" script="$WORK/req.sh"
  extract_blocks "$file" "$gate" >/dev/null
  section_blocks "$file" "$sec" >/dev/null
  : > "$log"
  { cat "$gate/block-01.sh"; cat "$sec"/block-*.sh 2>/dev/null; } > "$script"
  CMATE_STUB_LOG="$log" CMATE_STUB_MODE="$mode" bash "$script" >/dev/null 2>&1
}

# check_request <SKILL.md>: prints the problems, returns 1 if any.
check_request() {
  local file="$1" problems=0 log="$WORK/req.log" n mode last
  n=$(section_blocks "$file" "$WORK/req-count")
  if [ "$n" -lt 4 ]; then
    printf 'section 11 holds %s runnable blocks (want >= 4: add, update, close, done)\n' "$n"; return 1
  fi
  # mode on: proposals reach the CLI, done is last, nothing is confirmed directly.
  run_request "$file" on "$log"
  for want in 'handoff propose --request' ' add --kind ' ' update ' ' close ' 'handoff done --request'; do
    grep -q -F -e "$want" "$log" || { printf 'mode on: no call with "%s"\n' "$want"; problems=1; }
  done
  if grep -q '^mem \(now\|add\|update\|close\)' "$log"; then
    printf 'mode on: a direct confirm was made: %s\n' "$(grep '^mem \(now\|add\|update\|close\)' "$log" | tr '\n' ';')"; problems=1
  fi
  last=$(tail -1 "$log")
  case "$last" in
    'handoff done '*) ;;
    *) printf 'mode on: done is not the last call (last: %s)\n' "$last"; problems=1 ;;
  esac
  # propose and done are never one command.
  if grep -h -E 'handoff (propose|done)' "$WORK/req-count"/block-*.sh | grep -E '&&|;|\|\|' >/dev/null; then
    printf 'a handoff call is chained to another with && ; ||\n'; problems=1
  fi
  # mode off / no mem: nothing but the gate.
  for mode in off derived nomem; do
    run_request "$file" "$mode" "$log"
    if [ "$(cat "$log")" != 'mem mode --json' ]; then
      printf 'mode %s: calls other than mem mode: %s\n' "$mode" "$(grep -v -x 'mem mode --json' "$log" | tr '\n' ';')"; problems=1
    fi
  done
  # the guard, statically: every section-11 block is wrapped in the MEM guard.
  check_guards_static "$WORK/req-count" || problems=1
  return "$problems"
}

if out=$(check_request "$SKILL_MD" 2>&1); then
  pass 'a request with mode on proposes and returns, confirms nothing; off / derived / no mem call nothing'
else
  fail 'a request with mode on proposes and returns, confirms nothing; off / derived / no mem call nothing' "$out"
fi

# The section states the rule in words, too.
if grep -q -F '`mem add` / `update` / `close` で**直接確定しない**' "$SKILL_MD" \
  && grep -q -F '**第 3.1 節の入口の判定が `on` でなければ何もしない。**' "$SKILL_MD" \
  && grep -q -F '**`decision` は提案に含めない。**' "$SKILL_MD"; then
  pass 'section 11 states "do not confirm directly", "nothing unless on" and "no decision in a proposal"'
else
  fail 'section 11 states "do not confirm directly", "nothing unless on" and "no decision in a proposal"' 'a literal is missing'
fi

expect_request_rejected() {
  local name="$1" copy="$2" out
  mutations=$((mutations + 1))
  if cmp -s "$SKILL_MD" "$copy"; then
    fail "$name" 'the mutation changed nothing'
    return
  fi
  if out=$(check_request "$copy" 2>&1); then
    fail "$name" 'check_request accepted the mutated file'
  else
    pass "$name ($(printf '%s' "$out" | head -1))"
  fi
}

# 7a. The procedure removed (section 11 deleted).
copy="$WORK/req-removed.md"
awk -v h="$H11" '$0 == h { skip = 1; next } /^## / && skip { skip = 0 } !skip { print }' "$SKILL_MD" > "$copy"
expect_request_rejected 'removing the procedure is caught' "$copy"

# 7b. A proposal replaced by a direct confirm.
copy="$WORK/req-direct.md"
awk -v h="$H11" '
  $0 == h { sec = 1 }
  sec && /handoff propose --request .* add --kind next/ && !done {
    print "  commandmate mem add --kind next \\"; done = 1; next }
  { print }
' "$SKILL_MD" > "$copy"
expect_request_rejected 'a proposal replaced by a direct mem add is caught' "$copy"

# 7c. The guard of the first propose block dropped.
copy="$WORK/req-unguarded.md"
awk -v h="$H11" '
  $0 == h { sec = 1 }
  sec && $0 == "if [ \"${MEM}\" = on ]; then" && !done { print "if true; then"; done = 1; next }
  { print }
' "$SKILL_MD" > "$copy"
expect_request_rejected 'an unguarded block in section 11 is caught' "$copy"

# 7d. done chained to a propose.
copy="$WORK/req-chained.md"
awk -v h="$H11" '
  $0 == h { sec = 1 }
  sec && /commandmate handoff done --request/ && !done {
    print "  commandmate handoff propose --request \"<r>\" add --kind next --text x && \\"; done = 1 }
  { print }
' "$SKILL_MD" > "$copy"
expect_request_rejected 'propose chained to done is caught' "$copy"

# 7e. done called before the proposals (the order of the blocks swapped).
copy="$WORK/req-order.md"
cp "$SKILL_MD" "$copy"
python3 - "$copy" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
head, sec = s.split('## 11. 終了の前の引き継ぎの依頼', 1)
blocks = re.findall(r'```bash\n.*?\n```\n', sec, re.S)
done = [b for b in blocks if 'handoff done' in b][0]
first = blocks[0]
sec = sec.replace(done, '', 1).replace(first, done + '\n' + first, 1)
open(p, 'w').write(head + '## 11. 終了の前の引き継ぎの依頼' + sec)
PY
expect_request_rejected 'done before the proposals is caught' "$copy"

# ---------------------------------------------------------------------------
printf '\n%s passed, %s failed (%s mutations exercised)\n' "$passed" "$failed" "$mutations"
[ "$failed" -eq 0 ] || exit 1
exit 0
