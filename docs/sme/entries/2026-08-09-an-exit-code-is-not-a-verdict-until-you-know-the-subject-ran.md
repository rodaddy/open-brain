---
lane: adversarial
order: 80
---
## [2026-08-09] An exit code is not a verdict until you know the subject ran

**Severity:** HIGH
**Source:** PR #701 (#271 tripwire heal, five CI failures); filed as #702
**Scope:** every clause asserting a specific nonzero exit; shell pipelines in `scripts/done-means/*.sh`; mutation clauses
**Status:** active

### Pattern

Exit 127 is the shell's command-not-found. It means the script under test NEVER RAN. Five CI failures in the #271 lane asserted `toBe(1)` for a refusal and received 127 — "did not execute" and "refused correctly" were distinguishable only by the number's luck. Had the assertion been `toBe(127)` for some other reason, or had the refusal path happened to exit 127, the clause would have banked a non-execution as a proof of refusal.

Two adjacent shapes from the same lane:

- **`PIPESTATUS` printed empty when read outside the pipeline's own shell**, which reads as exit 0 at a glance. Every verdict in that lane was re-read directly from the command instead.
- **A mutation clause written against an ALREADY-RED subject banks the pre-existing failure as a kill.** Clause c passed on the pre-fix tree in its first form: a survived mutant was reported as a discriminating check. This was found only by reading WHY each RED clause failed, rather than accepting a satisfying 4/4 red.

### What to do

- Any clause asserting a specific nonzero exit must reject 127 explicitly.
- Prove a guard test by its executed-assertion COUNT, not by its exit code. A floor on `expect()` calls is the only clause that can express "the body ran to the end" — green/red structurally cannot. Pin a FLOOR, not an equality, so adding assertions does not fail the gate. (37 red vs 44 healed on the #271 tripwire.)
- Gate mutation clauses on a proven-green baseline; report INCONCLUSIVE otherwise.
- Read exit codes from the command itself, never from `PIPESTATUS` evaluated in a different shell.
- File the anomaly rather than absorbing it. Two runs of the same SHA disagreeing is the flake signal: identical `f0e135c` passed on `push` and failed on `pull_request`, and the local differential on clean `origin/main` versus the branch in separate worktrees (29 pass / 0 fail on both) is what proved it environment-owned. The same-SHA disagreement is the signal; the local differential is the proof.
