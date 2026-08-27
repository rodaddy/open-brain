---
lane: domain-backend
order: 97
---
## [2026-08-08] Verify which tree the process runs before reading source as truth

**Severity:** HIGH
**Source:** PR #650 (#646 provider-scope lane), Tightenings round 12
**Scope:** any lane reasoning about live behavior; `src/` versus `server/main.ts`; `package.json` `start`
**Status:** active

### Pattern

The lane reasoned about correct-looking code in `src/` while the service was in fact running `server/main.ts`. One call answers it — `lsof -nP -iTCP:<port>` plus `ps -o command` — and `package.json`'s `start` STILL points at the non-serving tree.

A source file that contradicts observed behavior is evidence you are reading the WRONG FILE, not evidence of a mystery.

### What to do

- Resolve the serving tree before treating any source file as the explanation for a live symptom.
- **A done-means fixture encodes a world-assumption that can be wrong in EITHER direction — query the real distribution before inventing a fixture shape.** The lane's first fixture seeded a conflicting `agent` and read the server's contract-CORRECT refusal as a failure; it nearly "fixed" correct code. All 2011 real lanes carried the matching agent.
- **A shared test resource closed by an earlier suite's `afterAll` fakes a red.** Distinguish by ASSERTION COUNT: 23 assertions executing means the subject failed; a harness error executes near zero.
- **`git stash push` on already-committed work stashes NOTHING**, and the follow-up pop grabs someone else's stash. Read the stash output before popping. Second foreign-stash incident; the first was #624.
- **A live-service-bound receipt is not portable.** A check proving behavior against `127.0.0.1:3100` at revision X proves nothing about any other host or revision, and goes stale on redeploy. Name the binding IN the receipt.

### Corollary: near-miss discipline runs both directions

A phantom finding (a nonexistent import) was re-checked and RETRACTED before reporting. A wrong fixture was corrected and RED re-proven against the pre-fix revision. Both belong in the report — they are the report's job, not its shame.

### Corollary: lazy-heal is a decision, not a default

2011 scope-broken lanes heal on their next capture. No bulk repair was run, and the report SAYS so — bulk-heal remains an operator option rather than a silently-taken default.
