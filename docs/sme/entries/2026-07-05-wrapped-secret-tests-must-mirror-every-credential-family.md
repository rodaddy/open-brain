---
lane: security
order: 6
---
## [2026-07-05] Wrapped-secret tests must mirror every credential family

**Severity:** HIGH
**Source:** PR #239 cross-model gauntlet for Issue #236
**Scope:** `src/sharing.ts`, `scripts/ob-backfill.ts`, any transcript/log import
path that redacts before durable writes or previews
**Status:** fixed in PR #239; keep as active checklist

### Pattern

Redaction review covered common standalone token families, but missed wrapped
credential tails for bearer headers, MCP session IDs, SSH credential URLs, and
punctuation-split tokens. Transcript/log importers can split secrets across
whitespace, line wrapping, or punctuation inside structured snippets, then
recombine cleartext tails in dry-run output or OB writes unless the
wrapped-secret gate mirrors every credential family and separator covered by
the base redactor.

### Review Questions

- Do wrapped-secret regression tests cover every credential family in
  `SECRET_PATTERNS`, not just API keys and JWT-like values?
- Are labeled headers such as `Authorization: Bearer` and `mcp-session-id`
  tested with the value split across whitespace?
- Are prefixless and prefixed tokens tested with the value split by
  non-whitespace punctuation such as comma, quote, angle bracket, bracket,
  markdown backtick/asterisk, or shell punctuation?
- Are credential URL schemes, including `ssh://`, tested with userinfo split
  across line wrapping?
- Do dry-run previews and durable-write paths both sanitize before slicing or
  logging text?
- After redaction, does a residual compacted-string check prove no wrapped tail
  remains in cleartext?
