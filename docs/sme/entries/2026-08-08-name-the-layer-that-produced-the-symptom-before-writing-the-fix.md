---
lane: correctness
order: 78
---
## [2026-08-08] Name the layer that produced the symptom before writing the fix

**Severity:** HIGH
**Source:** PR #629 (merge-gate lane and the clause-8 repair), PR #638 (#637 gate-precision lane)
**Scope:** verify-lane, done-means clauses that invoke repo tooling, recursion and re-entry guards, any fix aimed at a guard
**Status:** active

### Pattern

A RED transcript proves a symptom, not a cause. Five distinct fixes across two lanes were aimed at the wrong layer, and every one of them looked justified from the failure text alone.

- **A clause that measures its own guard.** #629's clause 8 ran verify-lane nested inside verify-lane. The re-entry guard (`MGVL_VERIFY_LANE_PRS`) fired BEFORE done-means resolution, so the nested probe died at the guard and never reached the error text the clause asserted on. The RED was real and its stated cause was wrong — which sent the next agent to fix code that was never broken. The misdirection is the dangerous half, worse than the failure.
- **Two guard fixes against a selection defect.** The #629 lane burned two recursion-guard attempts before seeing the live clause was picking "whatever PR is open" — which was the PR containing the clause itself. The defect was SELECTION, not recursion.
- **A message-text fix against a pre-emption defect**, in the same lane.
- **An assertion that was itself the bug.** #637's first driver asserted a specific refusal banner; RED revealed a sibling clause already refusing those cases correctly. Satisfying the naive assertion would have weakened a layer that was never broken.

### What to do

- Before writing a fix, state in one sentence which layer produced the observed symptom and what evidence places it there. If the evidence is only "the clause said so," that is not evidence of a layer.
- A clause must CLEAR the ambient state its subject reacts to, or it measures the guard. Named-env coupling is the residual risk: clause 8's correctness now depends on clearing two specifically named variables, and a future guard reading a different name silently regresses it to measuring the guard again. No test enforces the coupling.
- When a tool tests repo state at a pinned SHA, ask which VERSION of every involved script actually executes. verify-lane runs the done-means check FROM the PR-head worktree, so a fix committed after that head does not exist where the check runs.
- When an assertion fails, check whether the assertion is the defect before changing the subject.
- Hold precision-check fixtures in DATA FILES, never inline in code or in commands. The #637 lane was refused twelve times by the very hook it was repairing — on an `import` path, a file rename, and a read-only `rg` — because the fixture text lived inline. Every agent editing a checker is otherwise refused by the guard under repair.
- Copy `.env` into any bare worktree you run verify-lane from; bootstrap refuses loudly without it and posts no receipt.
