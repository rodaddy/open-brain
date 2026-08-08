---
lane: quality
order: 5
---
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
