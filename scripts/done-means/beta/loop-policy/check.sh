#!/usr/bin/env bash
# loop-policy: validate the "## Loop policy" block in a dispatch plan.
# Usage: check.sh <dispatch-plan.md>
# Exit: 0 pass, 1 policy failure, 3 harness error.
set -u

FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)
      echo "usage: check.sh <dispatch-plan.md>"
      exit 0
      ;;
    *)
      if [ -z "$FILE" ]; then FILE="$1"; else echo "HARNESS: unexpected argument '$1'" >&2; exit 3; fi
      ;;
  esac
  shift
done

if [ -z "$FILE" ]; then
  echo "HARNESS: usage: check.sh <dispatch-plan.md>" >&2
  exit 3
fi
if [ ! -f "$FILE" ] || [ ! -r "$FILE" ]; then
  echo "HARNESS: unreadable file: $FILE" >&2
  exit 3
fi
if [ ! -s "$FILE" ]; then
  echo "HARNESS: empty file, examined nothing: $FILE" >&2
  exit 3
fi

awk '
function fail(field, detail) { print "FAIL " field ": " detail; fails++ }
function is_posint(v) { return (v ~ /^[0-9]+$/ && v + 0 > 0) }
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }

BEGIN {
  in_sec = 0; seen_sec = 0
  in_yaml = 0; seen_yaml = 0; yaml_closed = 0
  in_np = 0; in_prio = 0; n_prio = 0
}
{
  line = $0

  # Section tracking: any new "## " heading ends the Loop policy section.
  if (line ~ /^## /) {
    if (line ~ /^##[ \t]+Loop policy[ \t]*$/) { in_sec = 1; seen_sec = 1 }
    else { in_sec = 0 }
    next
  }
  if (!in_sec) next

  # Fenced block tracking, only the first fence in the section counts.
  if (line ~ /^[ \t]*```/) {
    if (!seen_yaml) { in_yaml = 1; seen_yaml = 1; next }
    if (in_yaml) { in_yaml = 0; yaml_closed = 1 }
    next
  }
  if (!in_yaml) next

  if (line ~ /^[ \t]*$/) next

  # Two-level nesting: an indented line belongs to the last opened parent.
  indented = (line ~ /^[ \t]+/)

  if (indented && in_prio) {
    if (line ~ /^[ \t]*-[ \t]*/) {
      item = line; sub(/^[ \t]*-[ \t]*/, "", item); item = trim(item)
      n_prio++; prio[n_prio] = item
      next
    }
  }
  if (indented && in_np) {
    k = line; sub(/:.*$/, "", k); k = trim(k)
    v = line
    if (line ~ /:/) { sub(/^[^:]*:[ \t]*/, "", v); v = trim(v) } else { v = "" }
    np[k] = v; np_seen[k] = 1
    next
  }

  if (indented) next

  # Top-level key.
  in_np = 0; in_prio = 0
  if (line !~ /:/) next
  key = line; sub(/:.*$/, "", key); key = trim(key)
  val = line; sub(/^[^:]*:[ \t]*/, "", val); val = trim(val)
  seen[key] = 1; value[key] = val
  if (key == "no_progress") { in_np = 1 }
  if (key == "priority") { in_prio = 1 }
}
END {
  if (!seen_sec) { print "FAIL section: no \"## Loop policy\" heading"; exit 1 }
  if (!seen_yaml) { print "FAIL block: no fenced yaml block under \"## Loop policy\""; exit 1 }
  if (!yaml_closed) { print "FAIL block: fenced yaml block is not closed"; exit 1 }

  n = split("goal deadline_minutes budget_tokens max_turns no_progress on_goal on_exhaust priority", req, " ")
  for (i = 1; i <= n; i++) {
    if (!seen[req[i]]) fail(req[i], "field missing")
  }

  m = split("deadline_minutes budget_tokens max_turns", ints, " ")
  for (i = 1; i <= m; i++) {
    k = ints[i]
    if (seen[k] && !is_posint(value[k])) fail(k, "must be a positive integer, got \"" value[k] "\"")
  }

  if (seen["goal"] && value["goal"] == "") fail("goal", "must be a non-empty falsifiable sentence naming the done-means check path")
  if (seen["on_goal"] && value["on_goal"] == "") fail("on_goal", "must be non-empty")

  if (seen["no_progress"]) {
    if (!np_seen["metric"]) fail("no_progress.metric", "field missing")
    else if (np["metric"] == "") fail("no_progress.metric", "must be non-empty")
    if (!np_seen["window"]) fail("no_progress.window", "field missing")
    else if (!is_posint(np["window"]) || np["window"] + 0 < 1) fail("no_progress.window", "must be an integer >= 1, got \"" np["window"] "\"")
  }

  if (seen["on_exhaust"]) {
    oe = value["on_exhaust"]
    if (oe == "") fail("on_exhaust", "must be non-empty: name where the run parks")
    else {
      low = tolower(oe)
      if (low ~ /retry/) fail("on_exhaust", "must not contain \"retry\": exhaustion parks, it does not loop")
    }
  }

  if (seen["priority"]) {
    e = split("goal deadline budget max_turns no_progress", want, " ")
    if (n_prio != e) fail("priority", "must list exactly " e " entries in order, got " n_prio)
    else {
      for (i = 1; i <= e; i++) {
        if (prio[i] != want[i]) {
          fail("priority", "position " i " must be \"" want[i] "\", got \"" prio[i] "\"")
        }
      }
    }
  }

  if (fails > 0) exit 1
  exit 0
}
' "$FILE"

exit $?
