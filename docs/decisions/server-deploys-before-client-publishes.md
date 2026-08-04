# The server deploys before the client publishes

**Scope key:** `process.server_deploys_before_client_publishes`
**Source:** https://github.com/rodaddy/open-brain/issues/265
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

Downstream rollout ordering is load-bearing: the Open Brain server deploys its new contract version BEFORE the corresponding `openbrain-memory` client version publishes. Publishing a client that expects a contract the deployed server does not yet serve breaks every consumer. Rollout travels the `v*` release tag path, not a merge.

## Verbatim, from the source

> Not done here, by design: ... downstream rollout happens via the v* release tag path, with the load-bearing ordering documented on PR #277 (server deploys v20 BEFORE the openbrain-memory 0.1.6 client publishes).

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
