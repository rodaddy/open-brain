---
lane: security
order: 13
---
## [2026-07-08] Validation failures are the security-relevant audit events

**Severity:** HIGH
**Source:** PR #275 pre-merge gauntlet for Issue #269
**Scope:** `src/audit-log.ts`, MCP validation hooks, audit-path error logging
**Status:** fixed in PR #275 via a scoped mechanic; unknown-tool limitation
documented; logger-redaction regression test still missing (see Pattern)

### Pattern

An audit trail that only records successful tool dispatches misses the calls a
security review actually wants: malformed and rejected requests. PR #275 fixed
this by auditing at the repo-owned validation hook so schema rejections are
recorded with a `validation_error` status. The residual, documented limitation:
calls to unknown tool names are rejected by SDK layers above any repo-owned
hook and remain unauditable there. Separately, audit-path failure logs must
record `err.code`/`err.name` only -- never raw pg `err.message`, which can embed
query fragments or user content.

Known gap: there is no dedicated logger-redaction regression test for this yet.
The `err.code`/`err.name` redaction was code-review-verified in PR #275, and a
revert to logging raw `err.message` would pass the current suites. Reviewers
must REQUIRE a focused logger test whenever audit-logging code is touched:
inject a pg-like error carrying a secret-looking message, capture
`logger.warn`, and assert only the code/name are logged.

### Review Questions

- Are validation failures audited with a distinct status at the repo-owned
  validation hook, not only successful dispatches?
- Is the unknown-tool blind spot (rejected above repo hooks) documented rather
  than silently assumed covered?
- Do audit-path error logs restrict themselves to `err.code`/`err.name`?
- Does the PR touch audit-logging code? If so, REQUIRE the focused
  logger-redaction test described above -- it does not exist yet, and
  code-review verification from PR #275 does not protect against reverts.
