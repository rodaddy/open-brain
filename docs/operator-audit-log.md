# MCP Tool Audit Log (Operator Guide)

Open Brain records a privacy-safe audit row for every MCP tool call handled by
the server (issue #269). The log answers "who called which tool, when, with
what outcome and rough payload shape" without ever persisting request content.

Implementation: `src/audit-log.ts`. Schema:
`src/db/migrations/022_mcp_tool_audit_log.sql`.

## Table: `mcp_tool_audit_log`

| Column | Type | Meaning |
|--------|------|---------|
| `id` | `BIGSERIAL` | Row id. |
| `created_at` | `TIMESTAMPTZ` | Insert time (`NOW()` default). Retention and both indexes key on this. |
| `operation` | `TEXT` | MCP tool name (e.g. `log_thought`). |
| `status` | `TEXT` | `success`, `error` (tool returned `isError: true`), or `exception` (handler threw). |
| `duration_ms` | `INTEGER` | Handler duration, rounded, never negative. |
| `caller_role` | `TEXT` | Auth-derived role (`admin`, `agent`, ...), or `NULL` if absent. |
| `caller_client_id` | `TEXT` | Effective client id from auth context. |
| `caller_token_client_id` | `TEXT` | Client id bound to the bearer token. |
| `caller_agent_id` | `TEXT` | Agent id from auth context. |
| `namespace_source` | `TEXT` | How the namespace was resolved (e.g. `header`). |
| `declared_parameter_keys` | `JSONB` | Sorted, de-duplicated key names from the tool's **declared** input schema only. |
| `unknown_parameter_count` | `INTEGER` | Count of argument keys not in the declared schema. The unknown key names themselves are never stored. |
| `payload_size_bucket` | `TEXT` | Coarse size bucket of the JSON-serialized arguments (`0b`, `le_128b`, `le_512b`, `le_1kb`, `le_4kb`, `le_16kb`, `le_64kb`, `le_256kb`, `le_1mb`, `gt_1mb`). |

## Privacy Guarantees

The audit path persists operation metadata only. It never stores:

- raw request bodies or parameter values
- prompt or content text
- file paths, headers, tokens, or credential values
- unknown/undeclared argument key names (only their count)

Parameter key names are recorded only when they come from the tool's declared
input schema, so an attacker-controlled key (for example a path or a secret
used as a key) is reduced to `unknown_parameter_count`. Payload size is
bucketed rather than exact to avoid a size side channel on short secrets.

## Environment Controls

All variables are read at server start (`readMcpAuditConfig`). Out-of-range or
non-integer values fall back to the default.

| Variable | Default | Bounds | Effect |
|----------|---------|--------|--------|
| `OPENBRAIN_MCP_AUDIT_ENABLED` | enabled | set to `0` to disable | Any value other than `0` (including unset) leaves auditing on. When disabled, the wrapper is not installed and no audit SQL runs. |
| `OPENBRAIN_MCP_AUDIT_RETENTION_DAYS` | `30` | `1`-`366` | Rows older than this many days are deleted by the periodic cleanup. |
| `OPENBRAIN_MCP_AUDIT_CLEANUP_INTERVAL_MS` | `3600000` (1h) | `60000`-`86400000` | Minimum time between retention cleanup attempts. Cleanup is piggybacked on audit writes; a failed cleanup does not advance the interval clock and is retried on the next write. |
| `OPENBRAIN_MCP_AUDIT_WRITE_TIMEOUT_MS` | `1000` | `50`-`5000` | Upper bound on how long a tool response waits for its audit insert. On timeout the call proceeds and `mcp_tool_audit_write_timeout` is logged; the insert may still complete in the background. |

## Failure Behavior (Fail Open)

Audit logging never blocks or fails user-facing tool calls:

- Insert failures are caught and logged as `mcp_tool_audit_write_failed`; the
  tool result (or original exception) is returned to the caller unchanged.
- Slow inserts are bounded by `OPENBRAIN_MCP_AUDIT_WRITE_TIMEOUT_MS`
  (`mcp_tool_audit_write_timeout` warning on breach).
- Retention cleanup failures are caught and logged as
  `mcp_tool_audit_cleanup_failed` and retried on a later write.

The trade-off is deliberate: availability of the memory tools wins over audit
completeness. Watch the three warning events above if you need to detect audit
gaps.
