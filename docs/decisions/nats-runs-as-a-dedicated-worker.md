# NATS runs as a dedicated worker, not inside HTTP mode

**Scope key:** `architecture.nats_runs_as_dedicated_worker_not_http_mode`
**Source:** issue #282
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

NATS transport runs as a dedicated worker service with its own launchd label and its own health/logging, never as a mode toggle on the HTTP workers. Broker restart or subscription failure must not degrade HTTP `/health`; the NATS worker reaches the same Open Brain authority path without weakening bearer auth or namespace predicates. Deployment must restore managed launchd state rather than leaving an unmanaged background process.

## Verbatim, from the source

> enabling it through `OPENBRAIN_TRANSPORT=nats` on the existing HTTP workers is the wrong production shape. It couples NATS subscription health to HTTP worker health and can take `/health` degraded or down during broker restart or subscription failure. ... HTTP workers remain HTTP workers and do not subscribe to NATS.

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
