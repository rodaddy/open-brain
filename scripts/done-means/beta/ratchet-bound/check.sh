#!/usr/bin/env bash
# ratchet-bound: enforce the Tightenings graduation valve in a lane contract.
# Usage: check.sh <lane-contract.md> [--bound N]
# Exit: 0 pass, 1 bound/provenance/section failure, 3 harness error.
set -u

FILE=""
BOUND_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --bound)
      shift
      if [ $# -eq 0 ]; then echo "HARNESS: --bound needs a value" >&2; exit 3; fi
      BOUND_ARG="$1"
      ;;
    --bound=*)
      BOUND_ARG="${1#--bound=}"
      ;;
    *)
      if [ -z "$FILE" ]; then FILE="$1"; else echo "HARNESS: unexpected argument '$1'" >&2; exit 3; fi
      ;;
  esac
  shift
done

if [ -z "$FILE" ]; then
  echo "HARNESS: usage: check.sh <lane-contract.md> [--bound N]" >&2
  exit 3
fi
if [ ! -f "$FILE" ] || [ ! -r "$FILE" ]; then
  echo "HARNESS: unreadable file: $FILE" >&2
  exit 3
fi
if [ -n "$BOUND_ARG" ]; then
  case "$BOUND_ARG" in
    ''|*[!0-9]*) echo "HARNESS: --bound must be a non-negative integer, got '$BOUND_ARG'" >&2; exit 3 ;;
  esac
fi

awk -v bound_arg="$BOUND_ARG" -v path="$FILE" '
function flush_entry() {
  if (!have) return
  n_entries++
  grad = (text ~ /graduated:/)
  if (grad) n_grad++; else n_live++
  if (text !~ /provenance:/) {
    head = substr(first, 1, 60)
    print "FAIL provenance: " head
    prov_fail++
  }
  have = 0; text = ""; first = ""
}
BEGIN { in_sec=0; seen_sec=0; have=0; text=""; first=""; sec_text=""; bound_src="default"; bound=15; n_entries=0; n_live=0; n_grad=0; prov_fail=0 }
{
  line = $0
  if (line ~ /^## /) {
    if (in_sec) { flush_entry(); in_sec = 0 }
    if (line ~ /^## Tightenings[ \t]*$/) { in_sec = 1; seen_sec = 1 }
    next
  }
  if (!in_sec) next
  sec_text = sec_text " " line
  if (line ~ /^- \*\*[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]/) {
    flush_entry()
    have = 1; first = line; text = line "\n"
    next
  }
  if (have) text = text line "\n"
}
END {
  if (in_sec) flush_entry()
  if (!seen_sec) {
    print "ABSENT: ## Tightenings in " path
    exit 1
  }
  if (bound_arg != "") {
    bound = bound_arg + 0; bound_src = "arg"
  } else if (match(sec_text, /Bounded[ \t]+at[ \t]+[0-9]+[ \t]+live[ \t]+entries/)) {
    m = substr(sec_text, RSTART, RLENGTH)
    sub(/^Bounded[ \t]+at[ \t]+/, "", m); sub(/[ \t]+live[ \t]+entries$/, "", m)
    bound = m + 0; bound_src = "comment"
  }
  print "bound source: " bound_src " (bound=" bound ")"
  fail = 0
  if (prov_fail > 0) fail = 1
  if (n_live > bound) { print "FAIL bound: " n_live " live > " bound; fail = 1 }
  print "live=" n_live " graduated=" n_grad " bound=" bound " source=" bound_src
  exit fail
}
' "$FILE"
