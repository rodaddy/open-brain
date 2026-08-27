---
lane: domain-backend
order: 83
---
## [2026-08-08] A prefix-scoped SQL DELETE of provable test residue is the lane's to run

**Severity:** MEDIUM
**Source:** operator ruling 2026-08-08 (ledger item 31), Tightenings round 26
**Scope:** `scripts/done-means/*.sh` teardown clauses, eval and fixture cleanup, any lane that seeds rows into the dogfood database
**Status:** active

### Pattern

Lanes seed rows and then hesitate to remove them, reading the unconditional no-`rm` rule as covering the database. It does not. The operator ruling is explicit: "It's a database, not an RM-RF" — the filesystem rule governs the FILESYSTEM and is unchanged.

A lane may DELETE rows it can PROVE are its own test residue, scoped by a prefix it created.

### What to do

- Prove ownership first: the rows sit under a prefix the lane itself wrote, not merely a prefix that looks test-shaped.
- Count before. Delete in ONE transaction, children before parents. Verify zero after. Announce all three counts in the report — a silent cleanup is the adjusted-silently failure in a different costume.
- Rows of uncertain provenance, user data, and anything outside a provably-test prefix stay REPORT-ONLY. Name them in the report and let the operator decide.
- In this schema a namespace is an emergent property of its rows: there is no registry table, so `archive_entry` soft-delete can never retire one. Twenty-four archived-only eval namespaces are what that looks like after months of teardown that only soft-deleted.

### Why it matters

A teardown that reports success is not evidence of removal — the tally is the thing under test, never the proof. Assert a row COUNT read from OUTSIDE the run, and the count is what the DELETE clause exists to drive to zero.
