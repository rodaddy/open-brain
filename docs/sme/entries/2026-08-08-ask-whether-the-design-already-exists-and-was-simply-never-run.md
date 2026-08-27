---
lane: quality
order: 96
---
## [2026-08-08] Ask whether the design already exists and was simply never run

**Severity:** MEDIUM
**Source:** PR #648 (#647 capture-liveness lane), Tightenings round 13
**Scope:** every build lane's first move; `docs/decisions/`, `docs/sme/entries/`
**Status:** active

### Pattern

#647 read as "invent a liveness check." `docs/decisions/capture-never-drops-a-turn.md:182-200` had SPECIFIED it — per-role, count-based — for eleven days, carrying its own record that it "was never run."

"Has this been specified and left unrun?" is the FIRST question of any build lane, not a formality. Here the lookup materially changed the deliverable and avoided rebuilding the #447 per-role blind spot.

### What to do

- Search decisions and SME entries for the thing you are about to invent, BEFORE inventing it. A design that exists and was never executed looks exactly like a design that does not exist, from inside the issue text.
- **A control clause that passes PRE-fix is the signal the check discriminates.** Ten of thirteen clauses red with the two CONTROLS green is stronger evidence than thirteen of thirteen red: a check that fails everywhere proves only that it fails.
- **Lanes do not use `git stash` for red/green proofs — file-copy instead.** The stash stack is SHARED even when the worktree is exclusively yours. This was the second lane in one session to pop a foreign stash from a bootstrapped worktree, third incident overall; the round-1 "checkout you don't own" wording under-scoped the hazard.

### Corollary: name the capability state honestly

The liveness reader was MERGED code with no process composing it — no live `/health` reported capture until a composition change shipped. WRITTEN-not-RUNNING, stated in the PR rather than implied away.

### Gate-precision datapoints

The design-lookup gate accepted `aqmd` but refused a direct `sqlite3` query of the same index (#637 corpus). The git guard fired on a protected-branch name inside a MERGE-COMMIT MESSAGE — the fifth shape of #618; say "upstream default branch" in prose instead.
