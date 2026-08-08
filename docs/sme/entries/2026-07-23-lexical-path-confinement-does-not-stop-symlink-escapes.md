---
lane: security
order: 29
---
## [2026-07-23] Lexical path confinement does not stop symlink escapes

**Severity:** MEDIUM
**Source:** PR #373
**Scope:** local-clone path validation and any filesystem boundary checked
before a child process receives a path
**Status:** fixed in PR #373

### Pattern

`resolve()` plus `relative()` proves only that a configured path is lexically
beneath a root. An existing symlink at the target or in any parent component can
still redirect a later open outside that root. Fail-closed validation must
canonicalize the existing root and the target's nearest existing filesystem
entry, allowing only a not-yet-created suffix whose canonical ancestor remains
inside the canonical root.

### Review Questions

- Does the validator realpath both the existing root and the target's nearest
  existing entry before a child process receives the path?
- Do regressions cover a symlink at the target and a symlink in a parent
  component, including a nonexistent final leaf?
- Are lexical outside-root paths still rejected before canonicalization?
- Can an untrusted local writer swap a checked component after validation, and
  if so, does the owning operation need descriptor-relative or no-follow I/O?
