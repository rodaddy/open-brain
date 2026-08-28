#!/usr/bin/env bash
# DONE-MEANS check: qmd indexes are built in the ROOT checkout only, never in a
# lane clone (Rico ruling 2026-08-27, HANDOVER-RULES rule 51). The enforcement
# lives in the qmd wrapper, not a hook: /Volumes/ThunderBolt/Development/_ob/bin/qmd
# (Development 6eb694ec) refuses every index-writing verb with exit 3 when the
# physical cwd sits under the temp workspace, because the librarian, runner
# scripts, and anything that shells out to qmd all exec that wrapper and a
# PreToolUse hook sees none of them. Read verbs and the by-name root query
# (`aqmd in open-brain "..."`) stay open from a clone.
#
#   bash scripts/done-means/qmd-root-only-gate-fires.sh
#
# Every write case is exercised from a lane clone, where the guard refuses
# before qmd does anything; no case writes an index anywhere. Exit grammar:
# 0 all cases hold, 1 a case fails, 3 harness error.
#
# RED control: before Development 6eb694ec the wrapper had no guard, the write
# cases below exited 0 or 1 (qmd ran), and the 2026-08-27 census found 1,120
# index.sqlite files (29 GB) under /Volumes/ThunderBolt/_tmp built exactly
# that way.
set -u
QMD=/Volumes/ThunderBolt/Development/_ob/bin/qmd
AQMD=/Volumes/ThunderBolt/Development/_ob/bin/aqmd
CLONE=/Volumes/ThunderBolt/_tmp/open-brain/_worktrees/lane-3
[[ -x $QMD ]] || { echo "HARNESS ERROR: $QMD missing or not executable"; exit 3; }
[[ -x $AQMD ]] || { echo "HARNESS ERROR: $AQMD missing or not executable"; exit 3; }
[[ -d $CLONE/.git ]] || { echo "HARNESS ERROR: lane clone $CLONE is not a git checkout"; exit 3; }
fail=0

# refused: the verb must exit 3 and name the refusal, from inside the clone.
refused() {
  local why=$1; shift
  local out rc
  out=$(cd "$CLONE" && "$QMD" "$@" 2>&1); rc=$?
  if [[ $rc -eq 3 ]] && printf '%s' "$out" | rg -q "refusing '.*' in $CLONE -- no indexes in the temp workspace"; then
    echo "PASS (exit 3, refused): $why"
  else
    echo "FAIL (want exit 3 with the refusal line, got exit $rc): $why"
    printf '%s\n' "$out" | head -3 | sed 's/^/   | /'
    fail=1
  fi
}

# open: the command must not be refused (exit other than 3, no refusal line).
open() {
  local why=$1; shift
  local out rc
  out=$(cd "$CLONE" && "$@" 2>&1); rc=$?
  if [[ $rc -ne 3 ]] && ! printf '%s' "$out" | rg -q 'no indexes in the temp workspace'; then
    echo "PASS (exit $rc, not refused): $why"
  else
    echo "FAIL (refused, exit $rc): $why"
    printf '%s\n' "$out" | head -3 | sed 's/^/   | /'
    fail=1
  fi
}

refused "qmd update from a lane clone is refused"            update
refused "qmd embed from a lane clone is refused"             embed
refused "qmd index from a lane clone is refused"             index
refused "qmd collection add from a lane clone is refused"    collection add lane-3 .
open    "qmd --help from a lane clone is a read and stays open"   "$QMD" --help
open    "aqmd by-name query of the root index from a lane clone stays open" \
        "$AQMD" in open-brain "how is the manifest summed"

if [[ $fail -eq 0 ]]; then
  echo "PASS: qmd index writes are refused in a lane clone and reads stay open"
  exit 0
fi
echo "FAIL: the qmd root-only guard does not hold"
exit 1
