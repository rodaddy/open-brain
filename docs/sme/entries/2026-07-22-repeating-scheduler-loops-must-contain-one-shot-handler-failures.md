---
lane: adversarial
order: 20
---
## [2026-07-22] Repeating scheduler loops must contain one-shot handler failures

**Severity:** MEDIUM (P2)
**Source:** PR #355 / issue #344 Full-tier review
**Scope:** `python/openbrain-memory/src/openbrain_memory/maintenance.py`
**Status:** fixed-pre-merge

### Pattern

A scheduler can correctly re-raise handler exceptions from synchronous
`run_once()` while accidentally letting the same exception escape its background
loop. In PR #355, one raised handler unwound the daemon thread permanently, so
all future scheduled replay beats disappeared; Python's default thread
excepthook could also print the exception body to stderr. The fix catches only at
the `_run_loop` boundary, after the content-free error status was logged, so the
loop advances to the next interval while direct callers still receive the
exception.

### Review Questions

- Does a repeating loop call a one-shot API that intentionally re-raises? If so,
  is the exception contained at the loop boundary rather than killing the worker?
- Do synchronous callers still observe the error after the background containment
  fix?
- Does a regression use a handler that raises once and then succeeds, proving a
  later beat runs and the thread remains alive until explicit stop?
- Can the thread excepthook or stderr expose the handler's exception message?
