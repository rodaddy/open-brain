---
lane: security
order: 31
---
## [2026-07-31] Diagnostic tracebacks render locals -- content-bearing stdin reaches logs

**Severity:** HIGH
**Source:** Step-8 review swarm (Sol terminal audit), fixed in `967a3be`
**Scope:** `python/openbrain/src/openbrain/apps/hooks/stop.py`, any loguru
`logger.opt(exception=True)` on a path holding payload text
**Status:** active

### Pattern

Loguru's `diagnose` traceback prints local variables. A catch block that logs
`exception=True` where a local holds hook stdin (or any transcript/secret
text) writes that content into the log -- directly contradicting a
content-free-logging comment sitting right above it. Reproduced with a
sentinel in a malformed payload: both `raw` and pydantic's `input_value`
appeared in the traceback. The fix logs only `type(error).__name__`; no
exception object reaches any sink, so no handler's diagnose setting can leak.

### Review Questions

- Does any `except` on a payload-carrying path attach the exception object to
  a log call?
- Would a sentinel fed through malformed stdin appear in any sink with
  `diagnose=True`? Is there a regression test proving it cannot?
- Do pydantic ValidationErrors (which embed `input_value`) ever reach a log
  formatter unredacted?
