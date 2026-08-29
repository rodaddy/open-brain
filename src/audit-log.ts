// L5 adapter (issue 864): legacy call form over server/security/audit-log.ts; retired with src/ at L6.
import {
  installMcpAudit as installMcpAuditWithConfig,
  readMcpAuditConfig as readMcpAuditConfigFromEnv,
  type McpAuditConfig,
  type McpAuditDeps,
  type McpAuditEnvironment,
} from "../server/security/audit-log.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export * from "../server/security/audit-log.ts";

/**
 * The pre-move call form: the env argument is optional and defaults to
 * `process.env`, read at call time rather than at module load so a caller that
 * mutates the environment still sees its own values. The server/ function
 * takes the same values as one required parameter.
 */
export function readMcpAuditConfig(
  env: McpAuditEnvironment = process.env,
): McpAuditConfig {
  return readMcpAuditConfigFromEnv(env);
}

/**
 * The pre-move call form: an absent `config` fell back to the environment.
 * The server/ function treats absent as disabled, so the fallback lives here.
 */
export function installMcpAudit(server: McpServer, deps: McpAuditDeps): void {
  installMcpAuditWithConfig(server, {
    ...deps,
    config: deps.config ?? readMcpAuditConfig(),
  });
}
