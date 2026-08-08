---
lane: gotcha-agent
order: 34
section: harvest-522
---
## [2026-08-05] Build identity must come from the deployed artifact before git

**Severity:** MEDIUM
**Source:** issue #587, discovered after the #560 release-attribution change
**Scope key:** `observability.deployed_identity_precedes_git`
**Status:** fixed by the issue #587 implementation

### Pattern

A resolver added for Langfuse release attribution used `git rev-parse`, which
worked in development checkouts but returned nothing in deployed runtimes. The
local-clone deploy ships `git archive` output, while the core01 packager excludes
checkout metadata and any inherited stamp; both write a fresh
`.deployed-revision` into the artifact. `/health` already read that stamp
correctly. The new tracing resolver ignored the deployment authority and
therefore emitted no release on every deployed trace.

### Review Questions

- Does runtime build identity use the same artifact stamp as `/health` before
  consulting checkout metadata?
- Does the test model the deployed shape: a readable stamp and no usable git
  checkout?
- When development fallback behavior remains, is it exercised separately from
  the deployed-artifact path?
