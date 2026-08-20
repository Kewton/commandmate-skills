#!/usr/bin/env bash
# The two verify.yaml parsers must accept the same gate keys and the same
# options keys.
#
#   bash tests/fixtures/cmate-verify-advisor/parser-parity.sh
#
# `.commandmate/verify.yaml` is read by two separate implementations in two
# different languages:
#
#   skills/cmate-verify/scripts/verify-run.sh          an awk parser
#   skills/cmate-verify-advisor/scripts/verify-advisor.mjs   a JS parser
#
# Nothing made them agree. Issue #57 is what that costs: `options.requireCommit`
# was added to the runner (CommandMate #1642) and to nothing else, so every
# repository that used it got `unknown options key: requireCommit` and exit 2
# from the advisor — the advisor refusing to read a config that was never wrong.
#
# Two questions are asked here, because either one alone can be passed by a
# broken pair:
#
#  1. **Do the key lists match?** Extracted from the source of each parser — the
#     awk accept-list, the shell dispatch that consumes what awk emitted, and the
#     JS `OPTION_KEYS`. Three lists, not two: a key awk accepts and the shell
#     `case` never assigns is accepted and then silently ignored, which reads as
#     working.
#  2. **Do both parsers actually accept each key?** The lists above are text; a
#     list can agree while the code does not. So every key is put into a real
#     verify.yaml and fed to both parsers, and a key neither parser has ever
#     heard of is fed to both and must be refused by both. This is what makes an
#     extraction bug in question 1 visible instead of self-confirming.
#
# A new key therefore has to be added in three places and given a sample value
# below, or this suite goes red. That is the point.
#
# Since Issues #223 / #224 the same two questions are asked about the `gates[]`
# key set, which drifted the same way and cost the same thing: `mutex`
# (CommandMate #1771), `retryOnFail` / `flakyIsPass` (#1772) and
# `options.requireEnvClean` (#1740) were accepted by CommandMate's loader and
# rejected with exit 2 by both parsers here. The canonical set is
# `src/lib/verification/verify-config.ts`:
#
#   GATE_KEYS   = ['id', 'command', 'timeoutSec', 'mutex', 'retryOnFail', 'flakyIsPass']
#   OPTION_KEYS = ['baseRef', 'skipInPrimaryCheckout', 'maxLogTailBytes', 'requireCommit', 'requireEnvClean']
#
# Both are pinned literally below, so a key dropped from BOTH implementations at
# once — the one failure symmetry cannot catch — is still red.
#
# Requires bash, node, awk and sed. No network.
set -u

SUITE_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SUITE_DIR/../../.." && pwd)
VERIFY_RUN="$REPO_ROOT/skills/cmate-verify/scripts/verify-run.sh"
ADVISOR="$REPO_ROOT/skills/cmate-verify-advisor/scripts/verify-advisor.mjs"

WORK=$(mktemp -d -t cmate-parser-parity.XXXXXX)
trap 'rm -rf "$WORK"' EXIT INT TERM

passed=0
failed=0
pass() { passed=$((passed + 1)); printf 'ok   %s\n' "$1"; }
fail() { failed=$((failed + 1)); printf 'FAIL %s\n     %s\n' "$1" "$2"; }

# A sample value per key, so the behavioural half can build a config the parsers
# consider well-formed. A key with no entry here is a failure, not a skip.
sample_value() {
  case "$1" in
    baseRef) printf 'origin/main';;
    skipInPrimaryCheckout) printf 'false';;
    maxLogTailBytes) printf '4096';;
    requireCommit) printf 'true';;
    requireEnvClean) printf 'true';;
    *) return 1;;
  esac
}

# The same, per gate key. `id` and `command` are the two the sample config below
# always writes, so they are marked as such rather than given a second value.
gate_sample_value() {
  case "$1" in
    id) printf '@fixed';;
    command) printf '@fixed';;
    timeoutSec) printf '900';;
    mutex) printf 'e2e-port';;
    retryOnFail) printf '1';;
    # Only legal beside `retryOnFail: 1`, which write_gate_config always emits.
    flakyIsPass) printf 'true';;
    *) return 1;;
  esac
}

# The canonical sets, copied from CommandMate's verify-config.ts. Symmetry alone
# would let a key vanish from every implementation at once; this is the anchor
# that does not move when they do.
UPSTREAM_GATE_KEYS='command
flakyIsPass
id
mutex
retryOnFail
timeoutSec'
UPSTREAM_OPTION_KEYS='baseRef
maxLogTailBytes
requireCommit
requireEnvClean
skipInPrimaryCheckout'

# --- 1. the three key lists --------------------------------------------------

# The awk accept-list: the `KV_K == "..."` chain guarding the `printf "OPT` that
# emits an option. Anchored on that printf rather than on the key names, so the
# extraction cannot quietly start matching the top-level or gate key chains.
awk_keys() {
  awk '
    /printf "OPT\\t/ { for (i = 1; i <= n; i++) print buf[i]; n = 0 }
    {
      n = 0
      line = $0
      while (match(line, /KV_K == "[A-Za-z][A-Za-z0-9]*"/) > 0) {
        key = substr(line, RSTART, RLENGTH)
        sub(/^KV_K == "/, "", key)
        sub(/"$/, "", key)
        buf[++n] = key
        line = substr(line, RSTART + RLENGTH)
      }
    }
  ' "$VERIFY_RUN" | LC_ALL=C sort -u
}

# The shell dispatch: the `case "$a" in` arms inside the OPT branch that assign
# each emitted key to a variable. A key awk emits and this case drops is parsed
# and then ignored.
shell_keys() {
  awk '
    /^[[:space:]]*OPT\)[[:space:]]*$/ { inopt = 1; next }
    inopt && /^[[:space:]]*esac[[:space:]]*$/ { inopt = 0; next }
    inopt && match($0, /^[[:space:]]*[A-Za-z][A-Za-z0-9]*\)/) {
      arm = substr($0, RSTART, RLENGTH)
      gsub(/[[:space:]]|\)/, "", arm)
      print arm
    }
  ' "$VERIFY_RUN" | LC_ALL=C sort -u
}

# The awk gate accept-list: the `KV_K == "..."` chain inside `gatekv()`, which is
# the function that reads one `key: value` line of a gates[] entry. Scoped to
# that function so it cannot start matching the options or top-level chains.
awk_gate_keys() {
  awk '
    /^function gatekv\(/ { ingate = 1 }
    ingate {
      line = $0
      while (match(line, /KV_K == "[A-Za-z][A-Za-z0-9]*"/) > 0) {
        key = substr(line, RSTART, RLENGTH)
        sub(/^KV_K == "/, "", key)
        sub(/"$/, "", key)
        print key
        line = substr(line, RSTART + RLENGTH)
      }
      if ($0 ~ /^}$/) ingate = 0
    }
  ' "$VERIFY_RUN" | LC_ALL=C sort -u
}

# The shell side of a gate key. Gate fields arrive positionally rather than by
# name, so the equivalent of the OPT `case` arm is the array the field is pushed
# into: a key awk emits and no array collects is parsed and then dropped on the
# floor, which is the same silent failure the OPT list guards against.
gate_consumer() {
  case "$1" in
    id) printf 'GATE_IDS+=(';;
    command) printf 'GATE_CMDS+=(';;
    timeoutSec) printf 'GATE_TOS+=(';;
    mutex) printf 'GATE_MUTEXES+=(';;
    retryOnFail) printf 'GATE_RETRIES+=(';;
    flakyIsPass) printf 'GATE_FLAKY_IS_PASS+=(';;
    *) return 1;;
  esac
}

shell_gate_keys() {
  printf '%s\n' "$UPSTREAM_GATE_KEYS" | while read -r key; do
    [ -n "$key" ] || continue
    consumer=$(gate_consumer "$key") || continue
    if grep -Fq -e "$consumer" "$VERIFY_RUN"; then printf '%s\n' "$key"; fi
  done | LC_ALL=C sort -u
}

# A JS `new Set([...])` literal, in either the one-line or the wrapped form.
# awk, not grep or a single-line sed: verify-advisor.mjs is plain text today, but
# the sibling suites learned the hard way that a raw control byte in one regex
# literal makes grep call a whole .mjs file binary — and prettier wraps a long
# set across lines, which a `^const X = new Set([...]);$` match silently reads as
# "no keys at all".
js_set_keys() { # <SET-NAME>
  awk -v name="$1" -v q="'" '
    index($0, "const " name " = new Set([") > 0 { collecting = 1 }
    collecting {
      line = $0
      while (match(line, q "[A-Za-z][A-Za-z0-9]*" q) > 0) {
        print substr(line, RSTART + 1, RLENGTH - 2)
        line = substr(line, RSTART + RLENGTH)
      }
      if (index($0, "]);") > 0) collecting = 0
    }
  ' "$ADVISOR" | LC_ALL=C sort -u
}

js_keys() { js_set_keys OPTION_KEYS; }
js_gate_keys() { js_set_keys GATE_KEYS; }

awk_keys > "$WORK/awk.txt"
shell_keys > "$WORK/shell.txt"
js_keys > "$WORK/js.txt"
awk_gate_keys > "$WORK/awk-gate.txt"
shell_gate_keys > "$WORK/shell-gate.txt"
js_gate_keys > "$WORK/js-gate.txt"
printf '%s\n' "$UPSTREAM_GATE_KEYS" > "$WORK/upstream-gate.txt"
printf '%s\n' "$UPSTREAM_OPTION_KEYS" > "$WORK/upstream-option.txt"

printf '== the key lists were found at all ==\n'
# An extraction that silently returns nothing would make every comparison below
# trivially true. Each list has to be non-empty before it is worth comparing.
for who in awk shell js awk-gate shell-gate js-gate; do
  if [ -s "$WORK/$who.txt" ]; then
    pass "the $who key list is non-empty ($(tr '\n' ' ' < "$WORK/$who.txt"))"
  else
    fail "the $who key list is non-empty" 'the extraction found no keys — it is matching the wrong thing'
  fi
done

printf '\n== the key lists agree ==\n'
compare_lists() {
  local name="$1" a="$2" b="$3"
  if cmp -s "$a" "$b"; then
    pass "$name"
  else
    fail "$name" "$(diff "$a" "$b" | sed 's/^/       /')"
  fi
}
compare_lists 'verify-run.sh: awk accepts exactly what the shell dispatch consumes' "$WORK/awk.txt" "$WORK/shell.txt"
compare_lists 'verify-advisor.mjs OPTION_KEYS equals the runner accept-list' "$WORK/awk.txt" "$WORK/js.txt"
compare_lists 'verify-run.sh: awk accepts exactly the gate keys the shell collects' "$WORK/awk-gate.txt" "$WORK/shell-gate.txt"
compare_lists 'verify-advisor.mjs GATE_KEYS equals the runner gate accept-list' "$WORK/awk-gate.txt" "$WORK/js-gate.txt"

# Symmetry is not enough on its own: three implementations that all dropped the
# same key would agree perfectly. Both sets are therefore also compared against
# CommandMate's own, which is what a repository's verify.yaml is written against
# (verification-config.md section 9.5 names this repository as the follower).
compare_lists 'the gate key set equals CommandMate verify-config.ts GATE_KEYS (Issues #223 / #224)' "$WORK/upstream-gate.txt" "$WORK/awk-gate.txt"
compare_lists 'the options key set equals CommandMate verify-config.ts OPTION_KEYS (Issue #57 / #1740)' "$WORK/upstream-option.txt" "$WORK/awk.txt"

# The regressions that started this, named explicitly so a future refactor that
# drops a key from every side at once cannot pass by staying symmetric.
for who in awk shell js; do
  if grep -qx 'requireCommit' "$WORK/$who.txt"; then
    pass "requireCommit is present in the $who key list (Issue #57)"
  else
    fail "requireCommit is present in the $who key list (Issue #57)" "not found in: $(tr '\n' ' ' < "$WORK/$who.txt")"
  fi
  if grep -qx 'requireEnvClean' "$WORK/$who.txt"; then
    pass "requireEnvClean is present in the $who key list (CommandMate #1740)"
  else
    fail "requireEnvClean is present in the $who key list (CommandMate #1740)" "not found in: $(tr '\n' ' ' < "$WORK/$who.txt")"
  fi
done
for who in awk-gate shell-gate js-gate; do
  for key in mutex retryOnFail flakyIsPass; do
    if grep -qx "$key" "$WORK/$who.txt"; then
      pass "$key is present in the $who key list (Issues #223 / #224)"
    else
      fail "$key is present in the $who key list (Issues #223 / #224)" "not found in: $(tr '\n' ' ' < "$WORK/$who.txt")"
    fi
  done
done

# --- 2. both parsers really accept every key ---------------------------------
#
# Text agreeing is not the same as code agreeing. Each key gets a real config.

printf '\n== both parsers accept every key they claim to ==\n'

# The runner needs a git-less directory to stop in: it fails on the git check,
# which it can only reach after the config parsed. `invalid config` is the
# parse failure and the only thing asserted on.
mkdir -p "$WORK/notgit"

# An empty history, so the advisor stops with exit 3 (no history) rather than
# analysing anything. The config is parsed before that, which is all this needs.
printf '{"history":[],"details":[]}\n' > "$WORK/empty-history.json"

write_config() { # write_config <path> <key> <value>
  {
    printf 'version: 1\n'
    printf 'gates:\n'
    printf '  - id: lint\n'
    printf '    command: "npm run lint"\n'
    printf '    timeoutSec: 600\n'
    printf 'options:\n'
    printf '  %s: %s\n' "$2" "$3"
  } > "$1"
}

# runner_says_invalid <config> -> 0 when the runner rejected the config
runner_says_invalid() {
  bash "$VERIFY_RUN" --config "$1" --cwd "$WORK/notgit" > /dev/null 2> "$WORK/runner.err"
  grep -q 'invalid config' "$WORK/runner.err"
}

# advisor_says_invalid <config> -> 0 when the advisor rejected the config
advisor_says_invalid() {
  local dir
  dir=$(dirname "$1")
  node "$ADVISOR" --cwd "$dir" --config "$1" --input "$WORK/empty-history.json" \
    > /dev/null 2> "$WORK/advisor.err"
  grep -q 'invalid config' "$WORK/advisor.err"
}

while read -r key; do
  [ -n "$key" ] || continue
  if ! value=$(sample_value "$key"); then
    fail "both parsers accept options.$key" \
      "no sample value for '$key' — add one to sample_value() in $(basename "$0")"
    continue
  fi
  mkdir -p "$WORK/cfg-$key"
  cfg="$WORK/cfg-$key/verify.yaml"
  write_config "$cfg" "$key" "$value"

  if runner_says_invalid "$cfg"; then
    fail "cmate-verify's runner accepts options.$key" "$(sed 's/^/       /' "$WORK/runner.err")"
  else
    pass "cmate-verify's runner accepts options.$key"
  fi
  if advisor_says_invalid "$cfg"; then
    fail "the advisor accepts options.$key" "$(sed 's/^/       /' "$WORK/advisor.err")"
  else
    pass "the advisor accepts options.$key"
  fi
done < "$WORK/awk.txt"

# A gates[] entry carrying one optional key. `retryOnFail: 1` is always written
# because `flakyIsPass: true` is a config error without it — the pair is a value
# constraint both implementations enforce, not an accident of this fixture.
write_gate_config() { # write_gate_config <path> <key> <value>
  {
    printf 'version: 1\n'
    printf 'gates:\n'
    printf '  - id: lint\n'
    printf '    command: "npm run lint"\n'
    printf '    retryOnFail: 1\n'
    if [ "$2" != 'id' ] && [ "$2" != 'command' ] && [ "$2" != 'retryOnFail' ]; then
      printf '    %s: %s\n' "$2" "$3"
    fi
  } > "$1"
}

while read -r key; do
  [ -n "$key" ] || continue
  if ! value=$(gate_sample_value "$key"); then
    fail "both parsers accept gates[].$key" \
      "no sample value for '$key' — add one to gate_sample_value() in $(basename "$0")"
    continue
  fi
  mkdir -p "$WORK/gcfg-$key"
  cfg="$WORK/gcfg-$key/verify.yaml"
  write_gate_config "$cfg" "$key" "$value"

  if runner_says_invalid "$cfg"; then
    fail "cmate-verify's runner accepts gates[].$key" "$(sed 's/^/       /' "$WORK/runner.err")"
  else
    pass "cmate-verify's runner accepts gates[].$key"
  fi
  if advisor_says_invalid "$cfg"; then
    fail "the advisor accepts gates[].$key" "$(sed 's/^/       /' "$WORK/advisor.err")"
  else
    pass "the advisor accepts gates[].$key"
  fi
done < "$WORK/awk-gate.txt"

printf '\n== both parsers refuse a key neither has ==\n'
# The negative control. Without it, a parser that accepted every key at all
# would pass every case above, and the suite would be measuring nothing.
mkdir -p "$WORK/cfg-bogus"
BOGUS="$WORK/cfg-bogus/verify.yaml"
write_config "$BOGUS" 'notAnOption' 'x'
if runner_says_invalid "$BOGUS" && grep -q 'unknown options key: notAnOption' "$WORK/runner.err"; then
  pass "cmate-verify's runner refuses an unknown options key"
else
  fail "cmate-verify's runner refuses an unknown options key" "$(cat "$WORK/runner.err")"
fi
if advisor_says_invalid "$BOGUS" && grep -q 'unknown options key: notAnOption' "$WORK/advisor.err"; then
  pass 'the advisor refuses an unknown options key'
else
  fail 'the advisor refuses an unknown options key' "$(cat "$WORK/advisor.err")"
fi

mkdir -p "$WORK/gcfg-bogus"
GBOGUS="$WORK/gcfg-bogus/verify.yaml"
write_gate_config "$GBOGUS" 'notAGateKey' 'x'
if runner_says_invalid "$GBOGUS" && grep -q 'unknown gate key: notAGateKey' "$WORK/runner.err"; then
  pass "cmate-verify's runner refuses an unknown gate key"
else
  fail "cmate-verify's runner refuses an unknown gate key" "$(cat "$WORK/runner.err")"
fi
if advisor_says_invalid "$GBOGUS" && grep -q 'unknown gate key: notAGateKey' "$WORK/advisor.err"; then
  pass 'the advisor refuses an unknown gate key'
else
  fail 'the advisor refuses an unknown gate key' "$(cat "$WORK/advisor.err")"
fi

printf '\n== both parsers refuse the same out-of-range values ==\n'
# Accepting a key and accepting any value for it are different things, and the
# second is where `retryOnFail` would quietly stop being a bounded retry
# (CommandMate #1772: the ceiling is the feature). Each case is refused by BOTH
# parsers or it is a drift, exactly like an unknown key.
# A value the parsers accepted as a KEY and must refuse as a VALUE exits 2 —
# but not necessarily through the `invalid config` banner: the runner reports a
# range violation with `die_config`, which is the same exit code and a different
# first word. So the assertion is the exit code plus the reason, which is what a
# repository actually experiences.
runner_rejects() { # <config> -> 0 when the runner exited 2
  bash "$VERIFY_RUN" --config "$1" --cwd "$WORK/notgit" > /dev/null 2> "$WORK/runner.err"
  [ "$?" -eq 2 ]
}
advisor_rejects() { # <config> -> 0 when the advisor exited 2
  local dir
  dir=$(dirname "$1")
  node "$ADVISOR" --cwd "$dir" --config "$1" --input "$WORK/empty-history.json" \
    > /dev/null 2> "$WORK/advisor.err"
  [ "$?" -eq 2 ]
}

range_case() { # range_case <name> <key> <value> <needle>
  local slug
  slug=$(printf '%s' "$2-$3" | tr -c 'A-Za-z0-9._-' '-')
  mkdir -p "$WORK/range-$slug"
  local cfg="$WORK/range-$slug/verify.yaml"
  {
    printf 'version: 1\n'
    printf 'gates:\n'
    printf '  - id: lint\n'
    printf '    command: "npm run lint"\n'
    printf '    %s: %s\n' "$2" "$3"
  } > "$cfg"
  if runner_rejects "$cfg" && grep -Fq -e "$4" "$WORK/runner.err"; then
    pass "cmate-verify's runner refuses $1"
  else
    fail "cmate-verify's runner refuses $1" "$(cat "$WORK/runner.err")"
  fi
  if advisor_rejects "$cfg" && grep -Fq -e "$4" "$WORK/advisor.err"; then
    pass "the advisor refuses $1"
  else
    fail "the advisor refuses $1" "$(cat "$WORK/advisor.err")"
  fi
}
range_case 'retryOnFail: 2' retryOnFail 2 'retryOnFail must be 0 or 1'
range_case 'flakyIsPass: true without retryOnFail: 1' flakyIsPass true 'flakyIsPass: true requires retryOnFail: 1'
range_case 'a mutex name that is not path-safe' mutex 'e2e/port' 'invalid mutex name'

# The floor: this suite is only meaningful if it ran a case per key.
#   6 non-empty checks + 4 list comparisons + 2 canonical-set comparisons
# + 6 named-regression checks (options) + 9 named-regression checks (gates)
# + 2 per options key + 2 per gate key + 4 negative controls + 6 range controls.
key_count=$(wc -l < "$WORK/awk.txt" | tr -d ' ')
gate_key_count=$(wc -l < "$WORK/awk-gate.txt" | tr -d ' ')
expected=$((6 + 4 + 2 + 6 + 9 + 2 * key_count + 2 * gate_key_count + 4 + 6))
total=$((passed + failed))
if [ "$total" -lt "$expected" ]; then
  fail 'the suite ran a case for every key' "only $total assertion(s) ran, expected $expected for $key_count options key(s) and $gate_key_count gate key(s)"
fi

printf '\n%s passed, %s failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ] || exit 1
