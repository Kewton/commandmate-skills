#!/usr/bin/env bash
# The two verify.yaml parsers must accept the same options keys.
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
    *) return 1;;
  esac
}

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

# The JS set. sed, not grep: verify-advisor.mjs is plain text today, but the
# sibling suites learned the hard way that a raw control byte in one regex
# literal makes grep call a whole .mjs file binary.
js_keys() {
  LC_ALL=C sed -n "s/^const OPTION_KEYS = new Set(\[\(.*\)\]);\$/\1/p" "$ADVISOR" \
    | tr ',' '\n' \
    | sed -e "s/[[:space:]]//g" -e "s/^'//" -e "s/'$//" \
    | sed '/^$/d' \
    | LC_ALL=C sort -u
}

awk_keys > "$WORK/awk.txt"
shell_keys > "$WORK/shell.txt"
js_keys > "$WORK/js.txt"

printf '== the key lists were found at all ==\n'
# An extraction that silently returns nothing would make every comparison below
# trivially true. Each list has to be non-empty before it is worth comparing.
for who in awk shell js; do
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

# The regression that started this: named explicitly, so a future refactor that
# drops the key from both sides at once cannot pass by staying symmetric.
for who in awk shell js; do
  if grep -qx 'requireCommit' "$WORK/$who.txt"; then
    pass "requireCommit is present in the $who key list (Issue #57)"
  else
    fail "requireCommit is present in the $who key list (Issue #57)" "not found in: $(tr '\n' ' ' < "$WORK/$who.txt")"
  fi
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

# The floor: this suite is only meaningful if it ran a case per key. 3 non-empty
# checks + 2 list comparisons + 3 requireCommit checks + 2 per key + 2 negative.
key_count=$(wc -l < "$WORK/awk.txt" | tr -d ' ')
expected=$((3 + 2 + 3 + 2 * key_count + 2))
total=$((passed + failed))
if [ "$total" -lt "$expected" ]; then
  fail 'the suite ran a case for every key' "only $total assertion(s) ran, expected $expected for $key_count key(s)"
fi

printf '\n%s passed, %s failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ] || exit 1
