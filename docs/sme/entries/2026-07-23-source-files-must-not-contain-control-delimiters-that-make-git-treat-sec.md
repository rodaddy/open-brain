---
lane: quality
order: 13
---
## [2026-07-23] Source files must not contain control delimiters that make Git treat security code as binary

**Severity:** MEDIUM
**Source:** PR #365 review swarm, 2026-07-23
**Scope:** any source file (especially security/isolation-sensitive code) that
embeds literal control characters in string constants
**Status:** fixed-pre-merge

### Pattern

A source file carried literal control-byte delimiters (e.g. an embedded NUL / raw
control character used as a separator inside a string constant) rather than an
escaped form (`\x00`, ``, a named constant). Git's binary heuristic keys on
NUL/control bytes, so the file was classified as BINARY: `git diff` showed
`Binary files differ` instead of a line diff, and the security-sensitive change
became invisible to line-based review, blame, and the review swarm. Security code
that cannot be diffed cannot be reviewed. Control/delimiter bytes in string
literals must be written as escape sequences or named constants so the file stays
UTF-8 text and every change is a reviewable line diff. Guard it: `git diff
--check` and a repo check for stray control bytes / `.gitattributes text`
enforcement keep a file from silently going binary.

The companion receipt-truth and dedupe-before-mutation halves of this PR live in
the correctness lane ([2026-07-23] persisted-observations-must-reject-duplicate-
identity-and-receipt-fields-must-be-reachable).

### Review Questions

- Does any changed file render as `Binary files differ` in `git diff` (or show no
  line diff)? A source file going binary hides the whole change from review —
  find the control byte and escape it.
- Are delimiter/separator bytes written as escape sequences or named constants,
  never as raw literal control characters embedded in the file?
- Is `git diff --check` clean, and does the repo guard against stray control
  bytes (`.gitattributes text`, a control-char lint) so security-sensitive code
  cannot silently become unreviewable?
