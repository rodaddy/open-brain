---
lane: security
order: 27
---
## [2026-07-23] Read/approved eligibility is not write authority, and collectors must derive content/root server-side

**Severity:** HIGH
**Source:** PR #362 review swarm, 2026-07-23
**Scope:** approved-folder / approved-source collectors and any ingestion path
that accepts caller-attributed bodies for an approved root
**Status:** fixed-pre-merge

### Pattern

An approved (readable/eligible) source conferred write authority in the
collector: because a folder/root was on the approved list, the handler accepted
the caller's attributed CONTENT and the caller's asserted ROOT and persisted them
as the approved source's observation. That conflates two distinct grants — being
allowed to READ an approved source is not being allowed to WRITE arbitrary bodies
attributed to it. A caller could attribute forged content to an approved root, or
name a root they can read but should not be able to author into, and the server
would store it as trusted approved-source evidence.

The rule (a specialization of the digest/collector stance in the [2026-07-22]
digest-shape-is-not-proof entry): approved-folder collectors must DERIVE the
content and the root SERVER-SIDE from the trusted source — read the actual bytes
from the approved path server-side and compute identity/hash there — and must
NOT accept a caller-attributed body or a caller-asserted root as truth.
Eligibility gates WHICH sources may be collected; it never authorizes the caller
to supply the collected content. Keep the write authority derived from the
server's own read of the approved source, with the auth-derived namespace
predicate still applied.

See also the [2026-07-06] privileged-source-scope entry (source metadata is a
privilege boundary) and the [2026-07-22] digest-shape entry (a caller-asserted
digest is not observed-content truth — hash received bytes server-side).

### Review Questions

- Does an "approved" / "eligible" / "readable" status anywhere get treated as
  permission to WRITE caller-supplied content attributed to that source? Read
  eligibility and write authority are separate grants.
- Does an approved-folder/approved-source collector accept a caller-attributed
  body or a caller-asserted root/content-root, or does it derive both server-side
  from the trusted source before persisting?
- Is the stored content hashed/identified from bytes the SERVER read, not from a
  caller-provided body or digest?
- Is the auth-derived namespace predicate still applied on the write, so
  eligibility does not widen the namespace boundary?
- Is there a regression proving forged caller-attributed content for an approved
  root is rejected/ignored in favor of the server-derived content, failing on the
  pre-fix accept-caller-body path?
