---
lane: correctness
order: 51
section: harvest-522
---
## [2026-08-03] An SSE reader must return the response matching the request id

**Severity:** MEDIUM (stated in source)
**Source:** rodaddy/open-brain#87 (comment by rodaddy); harvested in #522
**Scope key:** `sme.correctness.sse_must_match_request_id`
**Status:** active

### Pattern

An SSE/streaming JSON-RPC reader must keep reading until the event carrying the MATCHING request id arrives; returning on the first id-bearing event silently returns another request's response once the server interleaves notifications. Prove it with a test that streams a notification, then a mismatched-id response, then the matching one, without EOF — raw-transport tests alone will not catch it.

Verbatim, from the source:

> MEDIUM: SSE transport returned after the first id-bearing event, even if it was not the current request id. Fix: `UrllibTransport.post()` now threads the JSON-RPC request id into SSE reading and keeps reading until the matching response id appears.
