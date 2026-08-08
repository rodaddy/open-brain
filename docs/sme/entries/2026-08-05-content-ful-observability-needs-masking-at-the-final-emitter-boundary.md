---
lane: security
order: 41
section: harvest-522
---
## [2026-08-05] Content-ful observability needs masking at the final emitter boundary

**Severity:** HIGH
**Source:** issue #561, operator ruling after the Langfuse egress census
**Scope key:** `sme.security.contentful_observability_masks_at_emitter`
**Status:** active

### Pattern

A content-ful observability lane can preserve complete arguments, results, and
surrounding context while still preventing credential-shaped spans from leaving
the process. Apply the shared labeled detectors at the final emitter boundary,
not at individual callers and not after transport. Replace each matched span
with a stable classifier marker such as `[MASKED:github_token]`; retain every
field, array item, and unmatched substring. Keep masking on by default, with any
bypass requiring an explicit operator configuration value.

Issue #561 measured the failure mode directly: PR #534 intentionally attached
full tool inputs and outputs to Langfuse, while the live corpus had not exercised
the highest-risk credential-return path. The fix belongs in
`buildToolTraceBody()` so future tracing surfaces inherit the same protection
without maintaining caller-specific detector forks.

PR #593's opposite-family review proved three additional bypass shapes at this
same boundary. Value-shaped detectors do not see opaque values carried under a
sensitive object key. Replacing an entire labeled JSON pair removes the label
and can make serialized JSON invalid. Non-plain carriers need normalization:
Map and Set content otherwise disappears, nested Error messages disappear, and
binary views expose credential bytes as numeric arrays.

### Review Questions

- Does every string value in tool arguments and results pass the shared
  `src/secret-patterns.ts` detectors before the sink receives it?
- Does the recursive walk also apply `isSensitiveKey()` while the field name is
  available, including nested argument and result objects?
- Do pair-shaped detector replacements retain the label and leave serialized
  JSON parseable?
- Are Map, Set, Error, Buffer, and typed-array carriers converted to observable,
  maskable shapes without exposing binary bytes?
- Are only matched spans replaced, with surrounding content and structure still
  present?
- Is masking on when its environment variable is absent, and can it be bypassed
  only through the documented explicit value?
- Does a regression seed obviously fake detector-shaped text in both tool
  arguments and tool results and assert the emitted body rather than a private
  helper?
