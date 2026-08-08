---
lane: correctness
order: 19
---
## [2026-07-17] Contract compatibility must compare semantic tool versions

**Severity:** MEDIUM
**Source:** PR #294 Full-tier review
**Scope:** server contract manifests and `openbrain-memory` compatibility checks
**Status:** fixed in PR #294

Required-tool presence is insufficient when the tool contract itself evolves. Compatibility must parse and compare each required tool's semantic version against the supported range, fail closed on malformed or incompatible versions, and test older, newer, malformed, and missing version declarations.
