# Quality SME Findings

Quality reviewers check whether abstractions communicate their contracts and
whether future maintainers can safely extend the package without repeating past
mistakes.

## [2026-06-11] Separate live-write policy, diagnostics policy, and replay policy

**Severity:** HIGH
**Source:** Issue #77, PR #74 follow-up
**Scope:** `python/openbrain-memory/src/openbrain_memory/agent.py`,
`python/openbrain-memory/src/openbrain_memory/spool.py`
**Status:** active

### Pattern

PR #74 conflated live storage safety, diagnostics/log redaction, and offline
replay durability. Redacting before live writes protects secrets but can corrupt
legitimate memories. Redacting before spool persistence protects disk logs but
can make replay lossy.

### Review Questions

- Does live write use the original payload unless an explicit write policy says
  otherwise?
- Are diagnostic/log/spool protections separate from live storage behavior?
- Is the spool contract exact replay, encrypted replay, or audit-only?
- Does the public API make that contract obvious?

## [2026-06-11] Documentation must state authority boundaries, not only examples

**Severity:** MEDIUM
**Source:** Issues #78, #81, PR #76 review
**Scope:** `python/openbrain-memory/README.md`, public facade docs
**Status:** active

### Pattern

Examples are not enough for security-sensitive package behavior. Docs must state
which layer owns namespace authority, transport security, session lifecycle, and
Hermes integration boundaries.

### Review Questions

- Does README distinguish service location from package install location?
- Does it say token/server/header namespace authority beats convenience metadata?
- Does it document HTTP as trusted-lab opt-in only?
- Does it document session close/TTL behavior if explicit close is unsupported?

## [2026-06-11] PR comments are training data for the next swarm

**Severity:** MEDIUM
**Source:** User process feedback after PRs #72-#76
**Scope:** review process
**Status:** active

### Pattern

PR comments that list findings and fixes are not optional bookkeeping. They are
the source material for SME updates and future gotcha-agent prompts.

### Review Questions

- Does the PR comment say what each lane found?
- Does it say what was fixed and what was intentionally deferred?
- Are new review misses promoted into `docs/sme/` before the next related PR?

## [2026-06-27] Cross-language feature parity needs shared golden fixtures

**Severity:** MEDIUM
**Source:** PR #218 full swarm
**Scope:** TS/Python facade parity, disclosure bundle export tests, contract docs
**Status:** fixed in PR #218

### Pattern

When a contract claims TS/Python facade parity, fragment assertions in each
language are not enough. Independent deterministic exporters can drift in file
order, frontmatter, path collision handling, citation rendering, or receipt
formatting while both local tests still pass.

### Review Questions

- Does a shared fixture compare full file paths and contents across both
  language implementations?
- Are stale examples updated when a partial helper becomes feature-complete?
- Do docs distinguish intentional API shape differences from missing behavior?
