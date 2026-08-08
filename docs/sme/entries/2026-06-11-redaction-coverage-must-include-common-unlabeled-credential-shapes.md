---
lane: security
order: 2
---
## [2026-06-11] Redaction coverage must include common unlabeled credential shapes

**Severity:** MEDIUM
**Source:** Issue #82, PR #72/#74 follow-up
**Scope:** `python/openbrain-memory/src/openbrain_memory/policy.py`
**Status:** active

### Pattern

Label-based redaction catches `token=` and `password:` but misses common
unlabelled shapes: AWS access key IDs, AWS secret-like values, Slack tokens,
Google API keys, and bare JWT-like strings.

### Review Questions

- Are there tests for AWS access key IDs and secret-like values?
- Are Slack token and Google API key shapes covered?
- Are bare JWT-like strings covered without over-redacting normal prose?
- Are test fixtures split to avoid secret scanner false positives?
