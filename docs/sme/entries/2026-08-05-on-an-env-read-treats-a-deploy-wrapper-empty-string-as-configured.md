---
lane: gotcha-agent
order: 36
section: harvest-522
---
## [2026-08-05] `??` on an env read treats a deploy-wrapper empty string as configured

**Severity:** MEDIUM. **Status:** fixed — PR #586 review finding, corrected in
`c50c66d` (`scripts/eval-langfuse-egress.ts` `readCaptureDriveConfig`).

`env.OPENBRAIN_CAPTURE_BASE_URL?.trim() ?? env.OPENBRAIN_BASE_URL?.trim()`
never reaches the alias: `??` falls through only on null/undefined, and
`""?.trim()` is `""`. The deployed hook-env wrapper shape passes
`VAR="${VAR:-}"`, so an *unset* variable arrives as an *empty string*. This is
the same defect class the Python side already catalogued for #525
(`config.py` `_empty_opt_in_means_unset` exists solely to defend it) —
recurring in TypeScript.

Review checks for the next swarm:

- **Any `??` chain over `process.env` reads is suspect.** Ask what an empty
  string means in the fleet's deployed env shape; if empty means unset (the
  `:-` wrapper pattern appears in `local-clone-deploy.sh`, `setup-client.sh`,
  `client-bundle.sh`, and the client-install runbook), the operator must be
  `||` or an explicit empty-means-unset helper.
- **A documented alias/fallback needs a test where the primary is `""`,** not
  only a test where it is absent. The absent-case test passes with either
  operator and proves nothing about the deployed shape.
