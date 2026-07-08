-- Privacy-safe MCP tool request audit log.
-- This table records operation metadata only: no request bodies, raw
-- parameter values, prompt text, file paths, headers, or unknown key names.

CREATE TABLE IF NOT EXISTS mcp_tool_audit_log (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  operation TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'error', 'exception')),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  caller_role TEXT,
  caller_client_id TEXT,
  caller_token_client_id TEXT,
  caller_agent_id TEXT,
  namespace_source TEXT,
  declared_parameter_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  unknown_parameter_count INTEGER NOT NULL DEFAULT 0 CHECK (unknown_parameter_count >= 0),
  payload_size_bucket TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_tool_audit_log_created_at
  ON mcp_tool_audit_log(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mcp_tool_audit_log_operation_created_at
  ON mcp_tool_audit_log(operation, created_at DESC);
