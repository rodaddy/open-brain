# Quality SME Findings

Quality reviewers check whether abstractions communicate their contracts and
whether future maintainers can safely extend the package without repeating past
mistakes.

## [2026-06-11] Separate live-write policy, diagnostics policy, and replay policy

**Severity:** HIGH
**Source:** Issue #77, PR #74 follow-up; PR #319 documentation fix delta
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
- Does the README distinguish persisted redacted replay bytes from the original
  caller payload, and describe the actual cross-process/durability behavior?

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

## [2026-07-06] Gate expensive retry-state lookups behind the reject decision

**Severity:** MEDIUM
**Source:** PR #244 Phase 3 Claude cross-review for Issue #176
**Scope:** `src/tools/append-session-event.ts`, synchronous share-candidate
write path
**Status:** fixed in PR #244

### Pattern

Retry bookkeeping can accidentally add latency to the success path. In PR #244,
`effectiveResubmitAttempt` queried the database for every clean sanitized
resubmit that carried lineage metadata, even though the pure classifier would
accept it and no rejection detail was needed.

### Review Questions

- Does the write path run pure, cheap classifiers before DB-backed retry-state
  work?
- Are retry counters queried only for events that are actually rejected?
- Do tests assert clean resubmits avoid rejection-detail work and unnecessary
  retry-state queries?

### Prior Fix

PR #244 first runs the sync share-candidate gate without DB retry state. Only
after a hard reject does it derive effective attempt state and rebuild the safe
rejection detail. A regression test asserts clean sanitized resubmits do not run
the retry-state query.

## [2026-07-06] Tool output contracts must not advertise unreachable buckets

**Severity:** MEDIUM
**Source:** PR #251 Claude cross-review for Issue #224
**Scope:** `src/tools/scan-namespace.ts`, tool schemas/docs that filter candidates before grouping
**Status:** fixed in PR #251

### Pattern

Changing query semantics can make an output bucket dead while the schema still
advertises it. In PR #251, `scan_namespace` was tightened to return only
pending explicit shared-kb nominations, but the response contract still exposed
an `already_promoted` bucket from the older scan-all design. That made clients
and future reviewers reason about states the tool could no longer produce.

### Review Questions

- After pushing a filter into SQL, do all response buckets still have reachable
  inputs?
- Does the tool description name the actual candidate set, not the historical
  broader scan behavior?
- Do tests assert removed/dead buckets are absent rather than empty, so clients
  cannot depend on obsolete shape?

### Prior Fix

PR #251 removed the unreachable `already_promoted` bucket and updated the tool
description and tests to describe pending explicit shared-kb nominations only.

## [2026-07-06] Mutating wrappers must distinguish no-op from successful writes

**Severity:** MEDIUM
**Source:** PR #254 initial swarm for Issue #247
**Scope:** explicit apply/dry-run pairs such as `decompose_entry`
**Status:** fixed in PR #254; keep as active checklist

### Pattern

`decompose_entry` originally overwrote every explicit apply response with
`status: "applied"`, even when the source entry was not oversized and the plan
had `would_write: 0`. That blurred "nothing eligible to write" and "writes
succeeded", and the no-op output state was undocumented.

### Review Questions

- Does an explicit mutating wrapper preserve no-op states instead of claiming a
  successful mutation?
- Are output statuses all reachable, documented, and covered by tests?
- Does the contract explain empty `written_ids` as no-op/skipped/duplicate
  rather than leaving clients to infer success?

## [2026-07-06] Apply responses need an explicit completeness summary when duplicates are possible

**Severity:** MEDIUM
**Source:** PR #254 Claude/Opus cross-review for Issue #247
**Scope:** explicit apply tools that can skip or collapse requested writes
**Status:** fixed in PR #254; keep as active checklist

### Pattern

`status: "applied"` is not enough when an apply request may skip pre-existing
duplicates or collapse duplicates inside the same batch. Clients need a
machine-readable answer for "were all requested replacements accounted for?" and
whether the source row was mutated.

### Review Questions

- Does the response expose requested, written, skipped, and collapsed counts?
- Is there an explicit boolean such as `fully_written` or an equivalent
  completeness marker?
- Does the response state whether the source row was archived, demoted, or left
  unchanged?

## [2026-07-07] Request/reply bridges must surface reply and shutdown failures

**Severity:** MEDIUM
**Source:** PR #262 initial swarm for Issue #223
**Scope:** `src/nats-bridge.ts`, `src/index.ts`, request/reply bridge drivers and server shutdown
**Status:** fixed in PR #262; keep as active checklist

### Pattern

Request/reply adapters can silently lose responses if the driver return value is
discarded. Shutdown paths can also skip later cleanup when an optional transport
close hangs or rejects. In PR #262, the NATS bridge discarded
`message.respond()` and awaited bridge close before database cleanup without a
separate error boundary. Fix verification also caught that reply failures must
be isolated per message and subscription iterator failures must be supervised;
a thrown handler or fatal iterator error in a background subscription loop must
not silently stop future request processing.

### Review Questions

- Does the driver surface failed reply delivery, missing inboxes, or rejected
  response promises to the bridge handler?
- Are per-message handler failures caught/logged inside background subscription
  loops so the bridge continues processing later requests?
- Are top-level subscription iterator failures caught/logged and followed by a
  resubscribe/recovery path or an explicit degraded/unavailable state?
- Do tests cover reply failure rather than only the happy-path response?
- Does server shutdown isolate optional transport close failures from database
  and process cleanup?
- Is shutdown bounded when an optional bridge can hang?

## [2026-07-08] Operational runbooks must separate implemented tests from release proof

**Severity:** MEDIUM
**Source:** PR #283 initial swarm for Issue #282
**Scope:** rollout/runbook docs for live service workers and transport bridges
**Status:** fixed in PR #283

### Pattern

A runbook can accidentally overclaim readiness by saying "install after tests
for X" when the PR only adds a subset of those tests and leaves some checks as
release-time live proof. That trains future operators to treat aspirational
checks as already covered and weakens the deploy gate.

### Review Questions

- Does the runbook distinguish automated tests already present from live
  release proof still required on the host?
- Does verification document both success and expected error envelopes?
- Are no-reply, shutdown, and close failures described as log/health conditions
  to inspect, not successful request/reply smokes?
- Are PR comments and release notes explicit about what remains deferred?

## [2026-07-21] Shared gate inputs need one authoritative copy and loud emptiness

**Severity:** MEDIUM
**Source:** PR #313 / PR development#44 review swarm 2026-07-21
**Scope:** `contracts/parity-paths.txt`, `.githooks/pre-push`, `.github/workflows/ci.yml`, `.github/workflows/pr-body.yml`, `python/openbrain-memory/tests/test_contract_fixtures.py`
**Status:** fixed-pre-merge

- The parity path filter was hand-copied across four sites (pre-push hook plus the CI and PR-body change-detection steps); centralize it in `contracts/parity-paths.txt`, have every consumer read it, and have the validator assert it exists and is non-empty.
- A moved or emptied fixture directory made the parametrized Python replay silently collect zero tests; the suite must assert the discovered python-consumable fixture set is non-empty and matches the manifest's expectation.
