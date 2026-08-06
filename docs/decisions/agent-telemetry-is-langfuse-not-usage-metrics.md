# Agent telemetry is Langfuse, not usage metrics

**Scope key:** `observability.agent_telemetry_is_langfuse_not_usage_metrics`
**Source:** issues #492, #523, #530, #569; PRs #524, #534, #543
**Recorded:** 2026-08-05
**Status:** settled. The shipped capture and MCP-tool lanes are active; broader surface coverage continues under #571 after #561 establishes emitter-side masking.

---

## The decision

**Full-fidelity agent execution telemetry goes to Langfuse. Skill and canon usage telemetry remains a separate factual metrics surface under #469. Neither replaces or silently feeds the other.**

The Langfuse contract is content-ful because its purpose is debugging execution: show what an agent sent, what it received, which operation ran, and how that operation ended. It is best-effort observability, not the durable memory or audit authority. A Langfuse outage must not alter an Open Brain call or capture delivery; Postgres audit and capture remain the systems of record.

## What the shipped Langfuse lanes emit

### Captured agent turns — #523 / PR #524

The Python capture application emits the same new transcript turns it reads for the raw lane as a session-grouped Langfuse trace. It uses an independent observation watermark, so observation failure cannot hold back memory and memory failure cannot hold back observation. Values are masked with the existing capture redactor before emission; turns are not sampled, shortened, or rejected because they matched a secret-shaped pattern.

### Executed MCP tool calls — #530 / PR #534

The rewrite server wraps `registerTool`, so every tool handler that executes emits one content-ful trace for success, returned tool errors, and thrown exceptions. The trace carries the tool name, input arguments, output or error result, caller identity, session grouping when available, status, duration, server tags, and release metadata. Schema validation failures that occur before the wrapped handler executes are not part of this shipped wrapper seam.

This lane currently sends handler input and output verbatim under #530's explicit local-dogfood ruling. That existing behavior must not be mistaken for the final masking posture described below.

### Launcher configuration — PR #543

The local clone launcher passes the server tracing configuration through to its child process via the four `OPENBRAIN_TRACING_*` variables: enabled flag, endpoint, public key, and secret key. Tracing remains opt-in and off when the required coordinates are incomplete. The launcher passes configuration; it does not emit traces itself.

## Full coverage, masking first

Operator ruling on #569, 2026-08-05:

> **“Everything that can possibly be dropped into there should be dropped into there — no exceptions.”**

That means the target is every agent-execution surface: retrieval internals including candidates, scores, and the chosen result; namespace value; structured row-id cross-links; embedding calls; dream and distill jobs; the NATS worker; and server-side LLM calls represented as generations.

The sequencing is equally binding: **#561 emitter-side masking lands first, then capture widens.** “Full coverage” does not authorize widening an unmasked emitter. Masking changes values, not event inclusion: mask sensitive values before enqueue, then emit the event rather than dropping it. The already-shipped Python observation lane follows that shape. The already-shipped server MCP wrapper is the known verbatim gap being brought under the masking-first program; this record does not falsely claim that #561 is already implemented.

## Relationship to #469 usage telemetry

The #469 surface answers a different question: **which named skill or canon rule was invoked, by which agent, repo, runtime, and session, how often, and when?** Its durable `skill_usage_log` and `skill_usage_report` expose counts, prior-window trends, last-used timestamps, and an explicit never-used list. They carry no prompt, tool input, tool output, trace body, recommendation, score, or lifecycle action.

Langfuse answers **what happened inside an execution**. The #469 surface answers **whether and how often a named capability was used**. A Langfuse trace is not a usage-report row, and a usage row is not a substitute for a trace. Correlation may use shared factual dimensions such as session, agent, repo, runtime, or namespace, but neither lane derives policy from the other.

In particular, #469 remains metrics-only: it must never categorize, recommend, rotate, shelve, or retire a skill or canon rule. Rico makes those decisions from the report. Full Langfuse coverage does not change that boundary.

## Outage and authority boundary

Langfuse is best-effort and off the request path. Losing an outage window is accepted; there is no disk spool or replay lane. The server reports sink suspension and recovery on state changes rather than once per call, including the dropped-trace count on recovery. An observation failure never changes a tool result, raw-turn delivery, or usage metric.

Open Brain's Postgres audit log remains the content-free durable audit record. Raw capture remains the memory/corpus source. Langfuse remains the content-ful execution flight recorder. The #469 tables remain the durable factual usage ledger.

## Provenance

The capture sink was merged in PR #524 for issue #523. Content-ful MCP tool tracing was merged in PR #534 for issue #530, and PR #543 supplied the missing launcher environment pass-through. Issue #569 records the 2026-08-05 operator ruling for complete coverage with masking before expansion. Issue #492 required this relationship to #469 to live in the repository rather than only in issue history.
