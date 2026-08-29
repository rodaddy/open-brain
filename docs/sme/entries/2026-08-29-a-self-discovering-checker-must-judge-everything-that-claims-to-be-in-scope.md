---
lane: correctness
order: 104
---

## [2026-08-29] A self-discovering checker must judge everything that CLAIMS to be in scope

**Severity:** MEDIUM
**Source:** #979 (issue 864)
**Scope:** any check that builds its own target set from the tree —
`scripts/done-means/*.sh`, manifest sweepers, lint discovery
**Status:** active

### Pattern

`scripts/done-means/864-moved-out-of-src.sh` discovers its targets by testing
each tracked `src/*.ts` and keeping the ones that pass. Extending it to accept
an L5 adapter, the first implementation discovered on `is_adapter` — the same
predicate clause A uses to accept. A probe file that declared the M9 header but
named a non-`server/` relative specifier therefore failed `is_adapter`, was
dropped from the target set, and the run printed `judged=19 shims / PASS,
exit 0`. The malformed file made the check greener, not redder.

The general form: when the discovery filter and the accept test are the same
predicate, nothing can ever fail. A candidate either satisfies the rule and
passes, or fails the rule and is not judged.

### Check

- Discovery keys on the DECLARATION (`declares_l5_header`: the file's first
  line claims to be an adapter), and the accept test keys on the SUBSTANCE
  (every relative specifier resolves under `server/`). A file that claims the
  header and breaks the rule is judged and fails `FAIL A` with the offending
  line printed.
- When adding a clause to a self-discovering checker, write the probe that
  SHOULD fail before the one that should pass, and confirm the exit code is 1
  and the path is named in the output. A silent `PASS` on a deliberately
  broken fixture is the defect, not a clean run.
- Ask of any discovery loop: what does a malformed candidate do here — fail, or
  vanish? Vanishing is the bug.
