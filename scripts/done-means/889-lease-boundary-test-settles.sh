#!/usr/bin/env bash
# DONE-MEANS check for issue #889 — the acceptance gate, not the fix.
#
#   bash scripts/done-means/889-lease-boundary-test-settles.sh
#
# THE DEFECT. `server/maintenance/maintenance.pg.test.ts` drove the composed
# runtime with `await runtime.runner.runOnce()` and then read the reclaimed row
# back immediately. `runOnce()` awaits `tick()` only (src/maintenance-queue.ts
# :744), and `tick()` dispatches each claimed job into the runner's `active` set
# WITHOUT awaiting it (src/maintenance-queue.ts:826-831) — the drain lives in
# `stop()` (:754-762). So the row was legitimately still `running` when the
# assertion read it, and `expect(recovered.state).toBe("succeeded")` failed on
# CI three times on branches that never touched the file.
#
# WHY THE CHECK IS A REPEAT RUN AND NOT A SINGLE ONE. The defect is a race whose
# losing side is rare: a single green run is exactly what the broken tree
# produced most of the time, which is why it survived to CI in the first place.
# One run therefore carries no information. Twenty consecutive clean runs is the
# smallest observation that distinguishes "the wait is real" from "the machine
# happened to be fast", and it is the shape issue #889 asked for by name.
#
# Each iteration goes through `bun run test:isolated`, which stands up its own
# freshly-migrated database and drops it again (AGENTS.md — a full run against
# the dogfood database is not evidence). The run is therefore slow by design.
#
# Exits 1 on the FIRST non-zero iteration, naming which one, so a failure is
# never reported as a pass and never hides behind a later success.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || {
  echo "DONE-MEANS 889: FAIL — cannot enter repo root" >&2
  exit 1
}

TARGET="server/maintenance/maintenance.pg.test.ts"
RUNS=20

if [[ ! -f "$TARGET" ]]; then
  echo "DONE-MEANS 889: FAIL — $TARGET not found" >&2
  exit 1
fi

for ((i = 1; i <= RUNS; i++)); do
  echo "DONE-MEANS 889: iteration $i/$RUNS"
  if ! bun run test:isolated "$TARGET"; then
    echo "DONE-MEANS 889: FAIL — iteration $i/$RUNS exited non-zero" >&2
    exit 1
  fi
done

echo "DONE-MEANS 889: PASS"
