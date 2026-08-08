---
lane: domain-backend
order: 26
---
## [2026-07-31] Every settings loader must run the unknown-variable check, not just the full one

**Severity:** MEDIUM
**Source:** Sol round-2 review, fixed in `42ccf0c`
**Scope:** `python/openbrain/src/openbrain/config.py`
**Status:** active

### Pattern

`load_capture_settings()` resolved known aliases but skipped
`unknown_prefixed_variables()`, so a misspelled `OPENBRAIN_CAPTURE_BASE_RUL`
was silently ignored → `base_url=None` → every Stop declined capture while
the operator believed it was configured — the exact failure mode the
full loader's check exists to prevent, reintroduced by a second, narrower
loader. Any section-scoped loader mirrors ALL of the full loader's
validation, and the error names the variable, never a value. (Case-only
typos are invisible to the case-insensitive check; tests must use a
transposition.)

### Review Questions

- Does every loader entry point (full and section-scoped) run the same
  unknown/misspelling validation?
- Does a test prove a misspelled prefixed variable is rejected BY NAME with
  no value in the message?
