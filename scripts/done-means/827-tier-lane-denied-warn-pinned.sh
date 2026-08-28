#!/usr/bin/env bash
# DONE-MEANS check for issue #827 — the acceptance gate, not the fix.
#
#   bash scripts/done-means/827-tier-lane-denied-warn-pinned.sh
#
# THE DEFECT. `authorizeTierLane` (server/tools/tier-lane.ts) emits
# `dependencies.logger.warn({ tool, role, namespace }, "tier_lane_denied")` when
# `canTargetNamespace` refuses a caller-named namespace. That warn line is the
# ONLY record a namespace denial on this tool ever leaves, and nothing asserted
# it. The shared `authorize` in server/tools/memory-helpers.ts emits no such
# event, so a behavior-preserving-looking swap to that helper — exactly the kind
# of reuse a sweep reaches for, and one the file's own comment warns against —
# deletes the denial log while every existing test stays green. A refusal that
# stops logging is indistinguishable in test output from a refusal that still
# logs, which is why the event name AND its fields need pinning, not just the
# `isError` result.
#
# WHY CLAUSE 3 MUTATES THE SOURCE. Clauses 1 and 2 prove the test exists and
# passes; neither proves it would NOTICE the defect. A test that asserted only
# `result.isError` would satisfy both and pin nothing. So the check deletes the
# warn statement from `authorizeTierLane` and requires the same test to go red:
# that is the smallest observation distinguishing "the event is pinned" from
# "the refusal is pinned". The mutation is applied to the working tree and
# restored from a copy by an EXIT trap, and the clause refuses to start unless
# the file is clean so a failed restore can never be mistaken for the author's
# own edit.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || {
  echo "DONE-MEANS 827: FAIL — clause 0: cannot enter repo root" >&2
  exit 1
}

TEST_FILE="server/tools/tier-lane-denied.test.ts"
SOURCE_FILE="server/tools/tier-lane.ts"
EVENT="tier_lane_denied"
BACKUP="/Volumes/ThunderBolt/_tmp/open-brain/_scratch/session10/tier-lane.ts.pre-mutation"

# --- clause 1: the test file exists and names the event on a code line -------
if [[ ! -f "$TEST_FILE" ]]; then
  echo "DONE-MEANS 827: FAIL — clause 1: $TEST_FILE not found" >&2
  exit 1
fi
if ! grep -q "\"$EVENT\"" "$TEST_FILE"; then
  echo "DONE-MEANS 827: FAIL — clause 1: $TEST_FILE never names \"$EVENT\"" >&2
  exit 1
fi
echo "DONE-MEANS 827: clause 1 OK — $TEST_FILE pins \"$EVENT\""

# --- clause 2: the test passes on the tree as it stands ---------------------
if ! bun run test:isolated "$TEST_FILE"; then
  echo "DONE-MEANS 827: FAIL — clause 2: $TEST_FILE exited non-zero" >&2
  exit 1
fi
echo "DONE-MEANS 827: clause 2 OK — $TEST_FILE passes"

# --- clause 3: the deliberate miss — delete the warn, require red -----------
if [[ -n "$(git status --porcelain "$SOURCE_FILE")" ]]; then
  echo "DONE-MEANS 827: FAIL — clause 3: $SOURCE_FILE is already modified; the" \
    "mutation needs a clean file so the restore is verifiable" >&2
  exit 1
fi

mkdir -p "$(dirname "$BACKUP")" || {
  echo "DONE-MEANS 827: FAIL — clause 3: cannot create the backup directory" >&2
  exit 1
}
cp "$SOURCE_FILE" "$BACKUP" || {
  echo "DONE-MEANS 827: FAIL — clause 3: cannot copy $SOURCE_FILE aside" >&2
  exit 1
}

restore_source() {
  cp "$BACKUP" "$SOURCE_FILE"
}
trap restore_source EXIT

perl -0pi -e 's/\n\s*dependencies\.logger\.warn\(.*?\);\n/\n/s' "$SOURCE_FILE"

# Scoped to the STATEMENT, not the file: the helper's doc comment names the
# event too, and a file-wide grep would call a correct deletion a failure.
if grep -q "^\s*dependencies\.logger\.warn(" "$SOURCE_FILE"; then
  echo "DONE-MEANS 827: FAIL — clause 3: the mutation did not remove the warn" \
    "statement from $SOURCE_FILE; the regex no longer matches the source" >&2
  exit 1
fi

bun run test:isolated "$TEST_FILE"
MUTATED_STATUS=$?

restore_source
trap - EXIT

if [[ -n "$(git status --porcelain "$SOURCE_FILE")" ]]; then
  echo "DONE-MEANS 827: FAIL — clause 3: the restore left $SOURCE_FILE dirty" >&2
  exit 1
fi

if [[ "$MUTATED_STATUS" -eq 0 ]]; then
  echo "DONE-MEANS 827: FAIL — clause 3: $TEST_FILE still passed with the" \
    "\"$EVENT\" warn deleted; the test pins the refusal, not the event" >&2
  exit 1
fi
echo "DONE-MEANS 827: clause 3 OK — deleting the warn turns $TEST_FILE red" \
  "(exit $MUTATED_STATUS), and $SOURCE_FILE is restored clean"

echo "DONE-MEANS 827: PASS"
