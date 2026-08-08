---
lane: correctness
order: 62
section: harvest-522
---
## [2026-08-06] External API fixtures must come from the endpoint being validated

**Severity:** MEDIUM
**Source:** issue #602, post-merge failure of PR #601 trace forensics tooling
**Scope key:** `review.external_api_fixtures_match_endpoint`
**Status:** active

### Pattern

A hand-written stub proves conformance to the stub, not to the external API. Langfuse detail responses return full observation objects, but list rows return observation ID strings; reusing the detail shape in list fixtures made every test pass while every live `session` and `repeat` call failed validation. For each external endpoint, capture and sanitize a real response, preserve its envelope and value types, and drive the public caller through that fixture. Do not reuse a sibling endpoint's richer response shape unless the live wire contract proves they are identical.
