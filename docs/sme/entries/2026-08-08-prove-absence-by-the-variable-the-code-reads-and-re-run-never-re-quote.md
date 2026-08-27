---
lane: correctness
order: 82
---
## [2026-08-08] Prove absence by the variable the code reads, and re-run rather than re-quote

**Severity:** HIGH
**Source:** PR #629 round-4 harvest — a CONTROLLER defect, the Langfuse false-absence claim; same class as #618
**Scope:** `server/observability/langfuse-tracing.ts`, every configuration-absence claim, controller reports
**Status:** active

### Pattern

The controller asserted "Langfuse unconfigured" after searching the environment files for `LANGFUSE_*`. The sink reads `OPENBRAIN_TRACING_*` (`server/observability/langfuse-tracing.ts:601-604`), which was set and ENABLED the entire time — 806 traces landed in the window claimed dark.

Searching for the PRODUCT NAME instead of the variable the code actually reads is the same defect class as #618 (matching vocabulary instead of the operation). Committed by the head, not by a lane, which is the part worth naming: controller reports are subject to this exactly as lane reports are.

The second half compounded it. The wrong claim was made once from a bad search and then REPEATED hours later by quoting the earlier conclusion rather than re-running the check. A verification conclusion is only as fresh as its last EXECUTION.

### What to do

- To claim a configuration is absent: find the `process.env.X` read in source FIRST, then search for `X`. Never search for the product, service, or vendor name.
- Re-quote nothing. Re-run it. An earlier conclusion in your own transcript is not evidence; it is a memory of evidence.
- A green clause is not evidence until it has been seen to fail. Both self-caught defects in the #451 lane were invisible in a fully-green run and surfaced only under deliberate mutation.
- Check the enum and the database CHECK constraint before designing a new dimension: `usage_kind="recall"` would have required a Zod enum change AND a migration, and two searches found the pin before any code was written. Read the constraint, not just the field.
- Verify "pre-existing" by stashing and re-running, not by asserting. The #609 full-suite differential applies cheaply at any scale.
- An outage path is testable without an outage: a closed port in 7100-7199 yields a real connection refusal with no waiting and no wall-clock assertion. Reusable for any gate distinguishing unreachable from empty.
- Wall-clock assertions (`toBeLessThan(1000)` ms) are CI flake generators — three runs produced three different unrelated timing failures, all proven main-owned via the #609 differential and filed (#632, #634) instead of absorbed.
