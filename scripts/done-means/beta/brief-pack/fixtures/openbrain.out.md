# Lane brief

budget: 1255/8000 tokens (ceil chars/4) | report-format: ## Required lane report format

## Task

Prove bounded recall returns a stable top-k under a fixed seed corpus.
Add a done-means fixture covering the empty-corpus exit 3 path.

## Done-means

path: /Volumes/ThunderBolt/Development/open-brain/scripts/done-means/563-bounded-recall.sh
invocation: `bash /Volumes/ThunderBolt/Development/open-brain/scripts/done-means/563-bounded-recall.sh`

```
# DONE-MEANS check for issue #563 — the acceptance gate, not the fix.
#
#   bash scripts/done-means/563-bounded-recall.sh
#
# THE RULING THIS ENFORCES (operator, 2026-08-08; ledger item 23 in
# docs/issue-graph.md; the two newest comments on #563):
#
#   "I don't see any reason why this whole thing would ship in a single shot to
#    anywhere. It defeats the whole purpose of this"
#
#   "it still should come through as single input outputs or maybe bursts of
#    5 to 10 input outputs that are sent from the server to the client, but not
#    ever as the whole file."
#
# So a budgetless, broad `durable_memory` request must not be answerable as one
# whole-corpus payload. It answers with a BOUNDED BURST plus the pointer pool
# the pack already builds, and a caller that legitimately wants all of it walks
# those pointers in further bursts until it holds everything.
#
# THIS IS RESPONSE SHAPE, NOT DATA REDUCTION. Every seeded record must still be
# retrievable; clause 4 fails the whole check if the walk ends holding fewer
# records than were seeded. Storage is untouched (#604/#606 settled that side).
#
# ACCEPTANCE, as this script enforces it — five clauses:
#
#   1. CONTROL: the probe corpus is real and broadly matchable — the first
#      budgetless request recalls something. A dead corpus or a failed seed
#      would hand every later clause a free pass, exactly the failure mode the
#      #624 lane's control clause was added for.
#   2. BOUNDED: the first (budgetless, broad) reply's durable_memory item count
#      is a burst, not the corpus — at most BURST_MAX of the seeded records, and
#      strictly fewer than were seeded.
#   3. REACHABLE: that same reply carries the remainder's identities as
#      pointers and/or a continuation handle. Bounded WITHOUT a way onward would
#      be data loss, which the ruling explicitly forbids.
#   4. COMPLETE WALK: following the continuation retrieves the rest in further
#      bursts, and the union of every burst covers the full seeded corpus. Each
#      individual burst is also checked to be a burst.
#   5. NO WHOLE-FILE SHAPE: no single reply in the walk serializes the whole
#      corpus (its byte size stays well under a full-corpus serialization).
#
# EXPECTED TO FAIL before the change: today the budgetless path emits every
# recalled record in one durable_memory section
# (DURABLE_MEMORY_MAX_ITEMS = Number.MAX_SAFE_INTEGER,
# src/tools/agent-context-pack-durable-memory.ts), so clause 2 fails on the
# first reply. It is the reward function, not a test of the fix's author.
#
# ---------------------------------------------------------------------------
# Isolation and teardown
# ---------------------------------------------------------------------------
# One random throwaway NAMESPACE per run, seeded by the driver and deleted here
# on exit whatever the verdict. The random RUN_ID makes collision with real data
# impossible, so the teardown DELETE structurally cannot reach anything this run
# did not create (ledger item 20's prefix-guarded, self-created, session-scoped
# auto-removal exception — all three hold).
#
# The embedding provider is stubbed in the driver with a deterministic vector,
# so this needs Postgres but no live MLX endpoint.
#
# Output is content-free: counts, byte sizes, and verdicts only. No record
# bodies are printed.
```

## Standing rules

Full contract: /Volumes/ThunderBolt/Development/open-brain/docs/lane-contract.md

(no ## Ground rules section)

## Tightenings (ranked)

(none)

## Report format

Lanes return EXACTLY these fields, in order. A missing field is an incomplete
report and the controller sends it back rather than filling gaps by inference:

```
self-reported model: <id>            (weak evidence, never attestation)
branch: <name>
pr: <number + state: OPEN/MERGED, CI state>
red: <one-line proof the check failed before the change, or transcript ref>
green: <one-line proof it passes after, or transcript ref>
root-cause: <file:line — for fixes; "n/a (new capability)" otherwise>
deviations: <each: what, which recorded decision it touches, ruling requested — or "none">
refusals-and-violations: <each gate hit and how resolved; self-reported violations — or "none">
teardown: <what was created and its end state; anything not removed, named>
claim-states: <the load-bearing claims, each labeled RUNNING/MERGED/WRITTEN/PROPOSED>
lessons: <candidate Tightenings for the harvest — or "none">
```

Prose beyond the fields is welcome AFTER them, never instead of them.

## Excluded (available on request)

(none)
