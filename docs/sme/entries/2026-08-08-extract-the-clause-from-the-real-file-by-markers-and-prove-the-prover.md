---
lane: correctness
order: 84
---
## [2026-08-08] Extract the clause from the real file by markers, and prove the prover

**Severity:** HIGH
**Source:** PR #653 final-sync lane (clause-e residue edit), Tightenings round 25
**Scope:** `scripts/done-means/*.sh` and their `.driver.ts`; any check that exercises a fragment of a larger gate
**Status:** active

### Pattern

When a gate has no clause-level seam, the tempting move is to retype the clause into the driver. A retyped copy proves the COPY. The gate can drift one character and the check keeps reporting on text nobody ships.

Extract the clause from the real file by markers instead — and then the extractor becomes the new place a vacuous green hides.

### What to do

- **Extract, never retype.** Pull the clause out of the shipped file by START/END markers so the check reads the same bytes the gate runs.
- **Fail hard on empty or unrecognisable extraction.** "0 lines extracted, all cases as expected" is a vacuous green: the extractor found nothing and the comparison loop ran zero times.
- **Gate the END pattern on the state variable** (`on &&`). An END regex that also matches EARLIER than START turns the block off before it turns on, and silently yields nothing — the same vacuous green by a different route.
- **Prove the prover.** "All cases behaved as expected" is a claim about the AUTHOR'S expectations until one deliberate driver mutation (`elif false`) makes the harness report MISMATCH. Until that run exists, an expectation table that agrees with itself is indistinguishable from one that compares nothing.

### Corollary: zero has two meanings and a receipt has three worlds

`rows=0` means both "clean" and "never looked." A companion `checked` field, read SEPARATELY, is mandatory.

And a receipt MISSING the field entirely is a THIRD world that must ERROR, never default. Defaulting it means a stale pre-fix receipt — written before the field existed — silently satisfies the very clause added to read it.
