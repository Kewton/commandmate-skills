#!/usr/bin/env bash
# cmate-delegate / check-brief — hold references/delegation-brief.md to the five
# fields SKILL.md section 3 refuses to send without.
#
#   bash check-brief.sh <path to delegation-brief.md>
#
# Exit 0 when every required field is present in the ja template, the en
# template and the key table. Exit 1 naming what is missing, on stderr.
#
# The point is not that the file is long enough. It is that a template a person
# copies cannot quietly lose "do not touch" and still look complete: the request
# would go out, the other session would do something nobody asked for, and the
# omission would only be visible afterwards in someone else's worktree.
set -u

BRIEF="${1:-}"
if [ -z "$BRIEF" ] || [ ! -f "$BRIEF" ]; then
  printf 'check-brief: usage: check-brief.sh <delegation-brief.md>\n' >&2
  exit 2
fi

# key<TAB>ja label<TAB>en label. The key column is the vocabulary the CommandMate
# side is meant to be reconciled against (CommandMate#2376 buildDelegationBrief).
FIELDS='purpose	■ 目的	# Purpose
target	■ 対象	# Target
output	■ 出力の形	# Expected output
forbidden	■ 触ってはいけないもの	# Do not touch
closing	■ 締め方	# How to close'

extract() { # extract <lang> ; prints the template block for that language
  awk -v begin="<!-- BEGIN TEMPLATE $1 -->" -v end="<!-- END TEMPLATE $1 -->" '
    $0 == begin { inside = 1; next }
    $0 == end   { inside = 0; next }
    inside      { print }
  ' "$BRIEF"
}

failures=0
note() {
  printf 'check-brief: %s\n' "$1" >&2
  failures=$((failures + 1))
}

JA=$(extract ja)
EN=$(extract en)

[ -n "$JA" ] || note 'the ja template block is empty or its BEGIN/END markers are gone'
[ -n "$EN" ] || note 'the en template block is empty or its BEGIN/END markers are gone'

OLDIFS="$IFS"
IFS='
'
for line in $FIELDS; do
  IFS='	'
  # shellcheck disable=SC2086
  set -- $line
  IFS='
'
  key="$1"
  ja_label="$2"
  en_label="$3"

  case "$JA" in
    *"$ja_label"*) ;;
    *) note "ja template is missing the field: $ja_label ($key)" ;;
  esac
  case "$EN" in
    *"$en_label"*) ;;
    *) note "en template is missing the field: $en_label ($key)" ;;
  esac
  if ! grep -q "\`$key\`" "$BRIEF"; then
    note "the key table does not carry the key: $key"
  fi
done
IFS="$OLDIFS"

# The closing marker is what makes a truncated reply detectable, so it is
# checked as a literal, not as "the closing field exists".
case "$JA" in
  *'DONE:'*) ;;
  *) note 'ja template does not tell the other session to end with a DONE: line' ;;
esac
case "$EN" in
  *'DONE:'*) ;;
  *) note 'en template does not tell the other session to end with a DONE: line' ;;
esac

# Context is the sixth field: not required to send, but the template must keep
# offering it, because "the other side does not share your context" is the whole
# reason this file exists.
case "$JA" in
  *'前提'*) ;;
  *) note 'ja template dropped the "前提" (context the other side does not have) field' ;;
esac
case "$EN" in
  *'Context you do not have'*) ;;
  *) note 'en template dropped the "Context you do not have" field' ;;
esac

if [ "$failures" -ne 0 ]; then
  printf 'check-brief: %s problem(s) in %s\n' "$failures" "$BRIEF" >&2
  exit 1
fi
printf 'check-brief: ok (%s)\n' "$BRIEF"
exit 0
