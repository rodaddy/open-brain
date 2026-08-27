---
lane: gotcha-agent
order: 98
---
## [2026-08-08] A recorded ruling is not an implemented one, and the gap is invisible

**Severity:** HIGH
**Source:** PR #649 (ledger-25 retirement lane), the #645 conflict lane, the worker-48 pin failure; Tightenings round 11
**Scope:** `docs/issue-graph.md` ledger items, `scripts/done-means/648-capture-gate-retired.sh`, merge procedure, model-pinned dispatch
**Status:** active

### Pattern

Ledger item 25 retired the capture gate. `main` kept it REGISTERED, and nothing failed — because no check asserted the retirement, and every check predating the ruling is structurally blind to it.

A ruling that retires a mechanism needs its OWN done-means check on the same pass, or the ledger and the tree drift silently and neither side reports it.

### What to do

- **A conflict-free merge is not a clean merge.** A merge is a fresh RED opportunity for every gate the branch owns: the neutrality gate caught a literal #642 introduced AFTER the branch cut — correct on each side, wrong only in combination. Re-run the branch's own checks AFTER merging the upstream default branch.
- **A generated file in conflict is REGENERATED, never hand-merged.** The conflict lives in the inputs and usually is not one at all (the SME index rebuilt from entries; both sides' entries survived).
- **Inverting a done-means clause needs its own RED**, extending round 9's rewritten-clause rule. And **retired-versus-deleted must be distinguished BY THE CHECK** — the 451 clauses now fail loudly if a cleanup deletes the #647 prior art instead of retiring it.
- **A hook-set assertion needs both directions.** "None missing" passes happily while a sixth hook creeps in; the "none extra" half is what catches config drift.
- **`FETCH_HEAD` is per-worktree** — fetch inside the worktree you merge in.

### Corollary: a model pin does not bind through direct Agent dispatch

The lane self-reported `claude-fable-5` — the HEAD's model — despite the agent definition pinning `claude-opus-4-8`. Requested-model provenance recorded what was ASKED, not what ANSWERED: the ledger-18 provenance warning, proven live.

The A/B comparison therefore had ZERO valid 4.8 samples. Model-pinned dispatch must go through the route that actually PLACES the model.

### Gate defects and announced adjustments

The git guard fires on the word "main" in commit-message PROSE on a correctly-named branch — say "the default branch"; the guard should read `git branch --show-current`. The design-lookup gate fires on a gitignored scratch PR-body file. The PRE-PUSH hook runs the suite against the shared dogfood database — the exact inadmissible path of the #614 ruling (1 fail then 0 fail on an identical tree, skip counts 485 apart). `aqmd search` can exceed 120s; wrap it in `timeout`.

Announced by tooling and needing a home: verify-lane and lane-bootstrap print `ADJUSTED: neither OPENBRAIN_TEMP_WORKSPACE nor DEV_TMP is set` and place worktrees under `~/.cache` instead of the configured temp workspace. Set the variable in controller and verifier environments, or teach the scripts the Development default.
