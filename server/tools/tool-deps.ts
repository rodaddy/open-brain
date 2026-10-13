/**
 * The dependency bag an MCP tool registration takes.
 *
 * The declaration lives here, under `server/tools/`, because its consumers do:
 * the `server/**` modules that register tools name it, so the type sits beside
 * them rather than being reached for across a package boundary.
 *
 * The two realtime members are typed against the server store declarations
 * themselves (`server/realtime/working-set.ts`, `server/realtime/recovery-wal.ts`),
 * so `server/` owns the real stores and nothing here adapts to a wrapper.
 */
import type pg from "pg";
import type { generateEmbedding } from "../embedding/provider.ts";
import type { NatsBridgeHealth } from "../application/nats-bridge-types.ts";
import type { NatsRuntimeBoundary } from "../application/nats-runtime.ts";
import type { WorkingSetStore } from "../realtime/working-set.ts";
import type { RecoveryWalStore } from "../realtime/recovery-wal.ts";
import type { McpAuditConfig } from "../security/audit-log.ts";

export interface ToolDeps {
  pool: pg.Pool;
  embedFn: typeof generateEmbedding;
  allowNonTransactionalAppendFallback?: boolean;
  workingSetStore?: WorkingSetStore;
  recoveryWalStore?: RecoveryWalStore;
  natsRuntimeBoundary?: NatsRuntimeBoundary;
  natsBridgeHealth?: NatsBridgeHealth;
  mcpAuditConfig?: McpAuditConfig;
}
