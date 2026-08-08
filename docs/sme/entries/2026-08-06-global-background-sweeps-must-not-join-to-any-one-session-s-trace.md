---
lane: security
order: 44
section: harvest-522
---
## [2026-08-06] Global background sweeps must not join to any one session's trace

**Severity:** HIGH
**Source:** PR #600 review swarm, finding H3
**Scope key:** `review.global_sweeps_never_session_joined`
**Status:** active

### Pattern

A maintenance/dream/distill job that sweeps with `namespace IS NULL` touches every tenant; joining its trace to a job-supplied `session_key` renders all tenants' row identities and content inside one session's timeline — a namespace-isolation breach in the observability lane even though the data path is unchanged. Honour a job's session key only when the job is namespace-scoped; a global sweep emits no sessionId, and each observation stamps its own resolved namespace so cross-namespace evidence is visibly attributed. "No current enqueuer sets it" is not a defense — the job-row field is durable and the sweep is global by design.
