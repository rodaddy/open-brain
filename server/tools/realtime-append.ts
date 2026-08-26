/**
 * `working_set_append`, `recovery_wal_append`, `recovery_wal_mark` — the write
 * half of the realtime surface.
 *
 * Design authority: the same one the stores already cite —
 * `docs/decisions/realtime-working-set.md`, recorded as observed behavior in
 * `contracts/server/server-realtime-working-recovery.fixture.json`.
 *
 * These three tools are ADAPTERS AND NOTHING ELSE. Every rule about what may be
 * appended, how long it lives, when it is trimmed, and what a near-miss scope is
 * allowed to reveal already lives in `server/realtime/working-set.ts` and
 * `server/realtime/recovery-wal.ts`, which the read half
 * (`agent_context_pack`'s `working_set` and `recovery` sections) has been going
 * through since it was written. Re-deciding any of that here would give the
 * write path a second opinion about a store the read path already governs, and
 * the two would drift in exactly the place where drift is invisible: RAM state
 * nothing persists and no migration would catch.
 *
 * So the adapter owns three things only — the MCP schema, the authorization
 * gate, and the response envelope — and the store owns the rest. In particular
 * `isError` is `!result.accepted`: a rejected append is a real error to the
 * caller, and a `not_found` mark is the fixture's recorded error case rather
 * than a silent no-op.
 *
 * The stores are taken from `dependencies`, never constructed here. They are
 * process-lifetime state; a store built inside a handler would accept a write
 * into an object the next request cannot see, and the append would report
 * success for content that had already ceased to exist.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  RECOVERY_WAL_ACTIONS,
  RECOVERY_WAL_STATUSES,
} from "../realtime/recovery-wal.ts";
import {
  WORKING_SET_ITEM_KINDS,
  type WorkingSetScope,
} from "../realtime/working-set.ts";
import { scopeInputSchema } from "./context-pack-args.ts";
import { recoveryWalStoreFor, workingSetStoreFor } from "./realtime-stores.ts";
import { authorize } from "./memory-helpers.ts";
import { authIdentity, type MemoryToolDependencies } from "./types.ts";

/**
 * Arguments carrying the seven scope coordinates, as `scopeInputSchema` parses
 * them. `namespace` is excluded: the scope's namespace is the AUTHORIZED one,
 * not the requested one, so the caller-supplied value is consumed by the
 * permission gate and never reaches the store.
 */
interface ScopeArguments {
  readonly agent: string;
  readonly platform: string;
  readonly server_id: string;
  readonly channel_id: string;
  readonly thread_id?: string | undefined;
  readonly session_key: string;
}

/**
 * Build the store scope from the AUTHORIZED namespace plus the caller's six
 * remaining coordinates.
 *
 * The namespace argument is the one `authorize()` returned, not `args.namespace`.
 * Passing the requested value would let a caller name a namespace it was denied
 * and still land the write in it — the check would have run and changed nothing,
 * which is the failure mode namespace isolation exists to prevent.
 */
function storeScope(namespace: string, args: ScopeArguments): WorkingSetScope {
  return {
    namespace,
    agent: args.agent,
    platform: args.platform,
    server_id: args.server_id,
    channel_id: args.channel_id,
    thread_id: args.thread_id ?? null,
    session_key: args.session_key,
  };
}

/** Emit a store result as the recorded JSON envelope, error-flagged on rejection. */
function realtimeResult(
  payload: Record<string, unknown>,
  accepted: boolean,
): {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
} {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    isError: !accepted,
  };
}

/**
 * Each tool gets its own registration function. They were one block, which
 * grew past the point where a reader could see where one tool ended and the
 * next began; the schemas and handlers are unchanged by the split.
 */
export function registerRealtimeAppendTools(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  registerWorkingSetAppendTool(server, dependencies);
  registerRecoveryWalAppendTool(server, dependencies);
  registerRecoveryWalMarkTool(server, dependencies);
}

/** RAM-only scoped working-set append. */
function registerWorkingSetAppendTool(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "working_set_append",
    {
      description:
        "Append one RAM-only scoped working-set item for the exact active " +
        "namespace/agent/platform/server/channel/thread/session. This does " +
        "not write durable memory or shared-kb.",
      inputSchema: {
        ...scopeInputSchema,
        kind: z.enum(WORKING_SET_ITEM_KINDS).describe("Working-set item kind"),
        content: z
          .string()
          .min(1)
          .max(4000)
          .describe("Bounded working context content, not durable memory"),
        confidence: z.number().min(0).max(1).optional(),
        stale_at: z.string().max(100).optional(),
        trace_id: z.string().max(500).optional(),
        source_ref: z.string().max(1000).optional(),
        durable_ref: z
          .object({
            table: z.string().min(1).max(100),
            id: z.string().min(1).max(200),
          })
          .optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: {
        title: "Working Set Append",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args, extra) => {
      const auth = authorize(
        authIdentity(extra.authInfo),
        "write",
        "sessions",
        "cannot write working set",
        args.namespace,
      );
      if (!auth.ok) return auth.response;

      const result = workingSetStoreFor(dependencies).append(
        storeScope(auth.namespace, args),
        {
          kind: args.kind,
          content: args.content,
          confidence: args.confidence,
          stale_at: args.stale_at ?? null,
          trace_id: args.trace_id ?? null,
          source_ref: args.source_ref ?? null,
          durable_ref: args.durable_ref ?? null,
          metadata: args.metadata,
        },
      );

      return realtimeResult(
        {
          accepted: result.accepted,
          reason: result.reason ?? null,
          item: result.item ?? null,
          counters: result.counters,
          not_durable_memory: true,
        },
        result.accepted,
      );
    },
  );
}

/** Quarantined recovery WAL append. */
function registerRecoveryWalAppendTool(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "recovery_wal_append",
    {
      description:
        "Append one quarantined recovery WAL record for the exact active " +
        "namespace/agent/platform/server/channel/thread/session. Recovery " +
        "records are unreviewed, not durable memory, and not searchable recall.",
      inputSchema: {
        ...scopeInputSchema,
        content: z
          .string()
          .min(1)
          .max(8000)
          .describe("Bounded quarantined recovery content, not durable memory"),
        status: z.enum(RECOVERY_WAL_STATUSES).optional(),
        trace_id: z.string().max(500).optional(),
        source_ref: z.string().max(1000).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: {
        title: "Recovery WAL Append",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args, extra) => {
      const auth = authorize(
        authIdentity(extra.authInfo),
        "write",
        "sessions",
        "cannot write recovery WAL",
        args.namespace,
      );
      if (!auth.ok) return auth.response;

      const result = recoveryWalStoreFor(dependencies).append(
        storeScope(auth.namespace, args),
        {
          content: args.content,
          status: args.status,
          trace_id: args.trace_id ?? null,
          source_ref: args.source_ref ?? null,
          metadata: args.metadata,
        },
      );

      return realtimeResult(
        {
          accepted: result.accepted,
          reason: result.reason ?? null,
          item: result.item ?? null,
          counters: result.counters,
          not_durable_memory: true,
          not_searchable_recall: true,
          unreviewed_quarantine: true,
        },
        result.accepted,
      );
    },
  );
}

/** Review decision or purge on one quarantined record. */
function registerRecoveryWalMarkTool(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "recovery_wal_mark",
    {
      description:
        "Mark or purge one exact-scope quarantined recovery WAL record after " +
        "review. This never promotes recovery content into durable memory.",
      inputSchema: {
        ...scopeInputSchema,
        id: z.string().min(1).max(200),
        action: z.enum(RECOVERY_WAL_ACTIONS),
        status: z.enum(RECOVERY_WAL_STATUSES),
        purge: z
          .boolean()
          .optional()
          .describe("When true, remove the exact recovery record after review"),
      },
      annotations: {
        title: "Recovery WAL Mark",
        readOnlyHint: false,
        // A purge deletes a record outright, so the whole tool is annotated
        // destructive even though `purge` defaults false: the hint describes
        // what the tool CAN do, and a client that gates destructive calls must
        // gate this one before it learns which argument was sent.
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args, extra) => {
      const auth = authorize(
        authIdentity(extra.authInfo),
        "write",
        "sessions",
        "cannot mark recovery WAL",
        args.namespace,
      );
      if (!auth.ok) return auth.response;

      const result = recoveryWalStoreFor(dependencies).mark(
        storeScope(auth.namespace, args),
        args.id,
        {
          action: args.action,
          status: args.status,
          purge: args.purge ?? false,
        },
      );

      return realtimeResult(
        {
          accepted: result.accepted,
          reason: result.reason ?? null,
          item: result.item ?? null,
          purged: result.purged ?? false,
          counters: result.counters,
          not_durable_memory: true,
          not_searchable_recall: true,
        },
        result.accepted,
      );
    },
  );
}
