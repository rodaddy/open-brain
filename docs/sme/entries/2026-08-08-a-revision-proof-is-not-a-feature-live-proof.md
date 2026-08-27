---
lane: domain-backend
order: 91
---
## [2026-08-08] A revision proof is not a feature-live proof

**Severity:** HIGH
**Source:** PR #660 (#659 launcher-env lane) and the controller-side discovery, Tightenings round 18
**Scope:** deploys to core01 and the local clone; launcher env allowlists; `scripts/done-means/659-launcher-env-passthrough.sh`
**Status:** active

### Pattern

The clone redeploy PASSED its revision proof at the right SHA while the merged feature stayed DARK: the launcher's env allowlist dropped the new config keys. #659 exists because the two were conflated for about ten minutes.

After any deploy meant to light up a feature, read the FEATURE'S OWN signal — a `/health` block, a log event — never just the revision.

### What to do

- **When a merged feature fails in deployment, ask which SEAM the passing check could not see.** #656's done-means drove `createShadowApplication` directly, so the entire launcher spawn chain sat outside its vantage. The check was honest about its seam, and the seam was exactly where the defect lived. Chain-level clauses driving the real launcher through its injected boundaries were cheap, and were the ONLY ones that reproduced the live symptom.
- **An env allowlist between launcher and child is a standing drop hazard** — third instance of the class (#530 tracing, then `AUTH_TOKEN_USER_`, now capture-health). The fix is ANNOUNCE-ON-DROP, not abolishing the allowlist: six more silently-dropped configured keys surfaced the moment drops became visible.
- **A done-means check for a NEW export must import it DYNAMICALLY.** A static import at the pre-fix tree dies at module resolution before any clause prints — a false RED identical in shape to a real one, reached by the ORDINARY act of writing a check for a function that does not exist yet. This is the default path, not an edge case.
- **A scope rule needs both halves in ONE clause, and only a mutation proves it.** "Ambient vars NOT announced AND configured key IS" was the only clause that caught an announce-everything filter. An unscoped drop report is boot noise an operator learns to skip — silence with extra steps. Companion rule: a drop report names KEYS, never values, because the dropped set contains secrets in the general case.
- **Read WHY each RED clause failed, not just the tally.** Three fixture defects (WAL path, clone root, `QMD_PATH`) failed IDENTICALLY to the defect under test at the shell. A false RED banks confidence in a check that measured nothing.
- **Suspect your own formatting before a known gate defect.** #641 being real made it the attractive explanation for a validator refusal that was in fact the lane's own backticks-in-a-field-value. Reading the validator's five lines of path resolution beat another workaround attempt.

### Self-reported violation, harvested not punished

A reflexive bare `rm -rf` — argument-less, deleted nothing, its error swallowed by `2>/dev/null` — ran inside an otherwise-correct clean-clone command. The reflex fires INSIDE correct compound commands, which is precisely why the ban is unconditional, and why `2>/dev/null` on a cleanup step deserves suspicion on sight.
