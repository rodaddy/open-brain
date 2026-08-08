---
lane: gotcha-agent
order: 37
section: harvest-522
---
## [2026-08-07] Ranking design options by imagined risk when the corpus can answer in 60 seconds

**Severity:** MEDIUM. **Status:** open process rule — found while building
`scripts/issue-graph.ts`; operator correction, 2026-08-07.

A parser for declared issue dependencies added one deliberately loose pattern
(`Blocked by #NNN` matched mid-sentence, not line-anchored) to catch a real
case in #437. The agent then produced a five-option pro/con analysis over the
false-positive risk of that pattern — negation guards, strict-only, separate
reporting sections — **without ever running the pattern against the corpus it
would parse.** Every option was ranked on a theory.

The measurement took one `rg` over the issue bodies and inverted the answer:

| Corpus | `blocked by` occurrences | False edges |
|---|---|---|
| 49 open issues | 1 (#437) | 0 |
| 288 closed issues | 4 (#161 x2, #446, #282) | 0 |

Both prose cases that are *not* dependencies (#446 "blocked by the writer
question", #282 "blocked by the current 1GB storage cap") are naturally immune
because the pattern requires `#NNN` immediately after the phrase. **Zero
negations exist anywhere in 337 issues** — no "not blocked by", no "was blocked
by" — so the proposed negation-guard option would have been dead code guarding
a phrasing this repo has never used.

The measurement also surfaced a fact no amount of reasoning would have: #161
already uses the clean `Blocked by: #159` field form, so the repo *has* a
convention and #437 is the outlier. That reframes the fix from "build parser
machinery for prose" to "normalize the one outlier".

Operator, 2026-08-07: *"if we branch off and do a little bit of actual testing
of the different decisions instead of just calling them wrong and blocking them
off, if we do a small prototype, when we come back we actually have the ability
to do an informed decision."*

Review checks for the next swarm:

- **A pro/con analysis with no measurement in it is a guess with formatting.**
  If the question is "does this pattern/threshold/heuristic misfire on real
  data", and the real data is in the repo, in the database, or one `gh` call
  away, the analysis is not ready to present until it has been run.
- **"Could produce false positives" is a hypothesis, not a con.** State the
  measured rate, or state UNVERIFIED and say what you did not run. A risk that
  measures zero on the entire corpus is not a tie-breaker between options.
- **Cheap concrete probes are already canon** — `_ob/skills/wayfinder` routes
  them through `_DOCS/references/prototype.md`, and this repo has
  `docs/dream-ethereal-runs.md` for disposable-output runs. Reaching for a
  prototype is the documented move, not an extra step.
- **Watch for options that only exist to be rejected.** Three of the five
  options offered here were defending against a phrasing that does not occur.
  `pro-con-analysis/_DOCS/procedure.md` Step 2 already forbids strawman padding;
  unmeasured risk is how strawmen get in while looking rigorous.
