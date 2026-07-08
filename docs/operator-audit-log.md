# MCP Tool Audit Log (Operator Guide)

Open Brain records a privacy-safe audit row for every tool call dispatched
through the MCP server, i.e. tools registered via `registerTool` and reached
over the HTTP `/mcp` transport (issue #269). Calls that bypass the MCP server
-- notably the NATS-bridge runtime paths -- are **not** covered by this log.
Calls that fail input validation for a **registered** tool are audited with
status `validation_error`; calls naming an **unknown tool** are rejected by
the SDK above any repo-owned hook and produce no audit row (known limitation).
The log answers "who called which tool, when, with what outcome and rough
payload shape" without ever persisting request content.

Implementation: `src/audit-log.ts`. Schema:
`src/db/migrations/022_mcp_tool_audit_log.sql`.

## Table: `mcp_tool_audit_log`

| Column | Type | Meaning |
|--------|------|---------|
| `id` | `BIGSERIAL` | Row id. |
| `created_at` | `TIMESTAMPTZ` | Insert time (`NOW()` default). Retention and both indexes key on this. |
| `operation` | `TEXT` | MCP tool name (e.g. `log_thought`). |
| `status` | `TEXT` | `success`, `error` (tool returned `isError: true`), `exception` (handler threw), or `validation_error` (request rejected by input validation before reaching the handler). |
| `duration_ms` | `INTEGER` | Handler duration, rounded, never negative. For `validation_error` rows this is the validation duration. |
| `caller_role` | `TEXT` | Auth-derived role (`admin`, `agent`, ...), or `NULL` if absent. All caller fields are `NULL` on `validation_error` rows: the validation hook runs before the SDK exposes any auth context. |
| `caller_client_id` | `TEXT` | Effective client id from auth context. |
| `caller_token_client_id` | `TEXT` | Client id bound to the bearer token. |
| `caller_agent_id` | `TEXT` | Agent id from auth context. |
| `namespace_source` | `TEXT` | How the namespace was resolved (e.g. `header`). |
| `declared_parameter_keys` | `JSONB` | Sorted, de-duplicated key names from the tool's **declared** input schema only. |
| `unknown_parameter_count` | `INTEGER` | Count of **raw** request argument keys not in the declared schema, measured before Zod validation strips undeclared keys. The unknown key names themselves are never stored. If a request carries more than 256 argument keys, per-key comparison is skipped and the total raw key count is recorded instead. |
| `payload_size_bucket` | `TEXT` | Coarse size bucket of the **raw** request arguments, measured before Zod validation strips undeclared keys (`0b`, `le_128b`, `le_512b`, `le_1kb`, `le_4kb`, `le_16kb`, `le_64kb`, `le_256kb`, `le_1mb`, `gt_1mb`). The size is an approximation from a bounded traversal (string lengths plus structural overhead, with an early exit into `gt_1mb`), not an exact serialization -- the request path never materializes a full JSON copy of the arguments. The sentinel `unknown` is recorded when the arguments cannot be JSON-serialized (never conflated with `0b`). |

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

All variables are read at server start (`readMcpAuditConfig`). Values must be
plain base-10 integers (digits only); anything else -- including `1.5`,
`1000ms`, or padded whitespace -- and out-of-range values fall back to the
default.

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
- At most 4 audit inserts may be in flight against the pool at once (kept
  well below the pool size), and audit writes are also skipped whenever the
  pool reports waiting clients. In both cases the write is skipped entirely
  and logged as `mcp_tool_audit_write_skipped`, so audit writes can never
  hold every pool connection and starve real tool queries.
- Retention cleanup fires detached after a successful insert and never runs
  inside the request-latency window. Failures are caught and logged as
  `mcp_tool_audit_cleanup_failed` and retried on a later write. The cleanup
  clock is process-scoped per pool, so per-session MCP server construction
  does not re-trigger the retention DELETE.
- Audit warning log lines carry only the error `code`/`name` (for example the
  Postgres error code), never the raw error message.

The trade-off is deliberate: availability of the memory tools wins over audit
completeness. Watch the four warning events above if you need to detect audit
gaps.
