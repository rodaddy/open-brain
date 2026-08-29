/**
 * Ingestion source registry tools over `ob_sources`.
 *
 * Design authority: `docs/decisions/source-registry.md` -- a source is
 * ingestion-eligible ONLY when a matching registry row is both approved and
 * active, so an unregistered location cannot be ingested by asking nicely.
 *
 * The authorization, namespace resolution, optimistic-concurrency, and
 * approval-transition rules all live in `server/domain/source-registry*.ts` and
 * are reused here rather than reimplemented. That module is the boundary that
 * decides who may approve what; duplicating its logic in the tool layer is how
 * the two would drift, and a drifted copy of an approval rule is a privilege
 * bug.
 *
 * ERROR TEXT HERE IS DELIBERATELY CONTENT-FREE. Failures return a typed code
 * and a fixed reason -- never a driver message, path, row value, or config,
 * any of which can echo a source body downstream.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "../types.ts";
import {
  APPROVAL_STATES,
  LIFECYCLE_STATES,
  SOURCE_KINDS,
  SYNC_STATES,
  listSources,
  registerSource,
  removeSource,
  resolveIngestionEligibility,
  updateSource,
  type SourceRecord,
  type SourceRegistryResult,
} from "../domain/source-registry.ts";
import {
  collectDropFolder,
  type CollectDropFolderResult,
} from "../capture/drop-folder-collector.ts";
import type { AuthIdentity } from "../auth/types.ts";
import { authIdentity, textResult, type MemoryToolDependencies } from "./types.ts";

/**
 * Convert the server's identity into the registry module's shape.
 *
 * The two disagree on one value and it is the one that matters: the server
 * calls an admin-delegated identity `delegated`, while the registry calls it
 * `header`. Both mean "this namespace did not come from the token", which is
 * what the registry's authorization checks key on -- so this is a rename, not
 * a widening. Casting instead of mapping would silently hand the registry an
 * unknown value and lose the distinction.
 */
function registryAuth(identity: AuthIdentity): AuthInfo {
  return {
    role: identity.role,
    clientId: identity.clientId,
    tokenClientId: identity.tokenClientId,
    namespaceSource: identity.namespaceSource === "delegated" ? "header" : "token",
  };
}

/** Public projection of a registry row; the row never stores source bodies. */
function publicRecord(record: SourceRecord) {
  return {
    id: record.id,
    namespace: record.namespace,
    scope: record.scope,
    source_kind: record.source_kind,
    external_id: record.external_id,
    title: record.title,
    approval_state: record.approval_state,
    approved_by: record.approved_by,
    approved_at: record.approved_at,
    lifecycle_state: record.lifecycle_state,
    sync_state: record.sync_state,
    language: record.language,
    config: record.config,
    content_hash: record.content_hash,
    last_synced_at: record.last_synced_at,
    revision: record.revision,
    created_by: record.created_by,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

function okResult(payload: object) {
  return textResult({ ok: true, ...payload });
}

function failure(code: string, error: string) {
  return { ...textResult({ ok: false, code, error }), isError: true as const };
}

/** Map a typed registry result to its content-free envelope. */
function registryFailure(result: SourceRegistryResult<unknown>) {
  return failure(
    result.code ?? "error",
    result.reason ?? "source registry operation failed",
  );
}

/**
 * Label a thrown error by class or allowlisted code ONLY.
 *
 * Never `err.message`: a raw driver string can echo the row values that caused
 * the failure, which is exactly the content this layer must not emit.
 */
function internalErrorLabel(error: unknown): string {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Za-z_]{1,32}$/.test(code)) return code;
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && /^[A-Za-z_]{1,64}$/.test(name)) return name;
  }
  return "unknown_error";
}

const scopeArg = z
  .record(z.string().min(1).max(200), z.string().max(500))
  .describe("Content-free key/value scope (never source bodies)");

const configArg = z
  .record(z.string().min(1).max(200), z.unknown())
  .describe("Structural collector config (never source bodies)");

const targetNamespaceArg = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .describe(
    "Namespace to operate in. Defaults to your own. A global admin/ob-admin " +
      "token may target another namespace; header-scoped identities are bound " +
      "to their header namespace.",
  );

/**
 * Run a registry call, converting an UNEXPECTED throw into one stable
 * envelope. Typed results pass through untouched; only the throw path is
 * intercepted, and the log carries an allowlisted label, never a message.
 */
async function guarded<T>(
  dependencies: MemoryToolDependencies,
  operation: string,
  run: () => Promise<T>,
): Promise<T | ReturnType<typeof failure>> {
  try {
    return await run();
  } catch (error) {
    dependencies.logger.error(
      { operation, error: internalErrorLabel(error) },
      "source_registry_internal_error",
    );
    return failure("internal_error", "source registry operation failed");
  }
}

const REGISTER_SOURCE_INPUT = {
  source_kind: z.enum(SOURCE_KINDS),
  external_id: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .describe("Stable opaque external locator (repo URL, path, drop id)"),
  target_namespace: targetNamespaceArg.optional(),
  title: z.string().trim().min(1).max(500).optional(),
  scope: scopeArg.optional(),
  language: z.string().trim().min(1).max(100).optional(),
  config: configArg.optional(),
  approved: z
    .boolean()
    .optional()
    .describe(
      "Request approval on create. Honored only for an authorized " +
        "admin/ob-admin token identity; otherwise the call is rejected.",
    ),
};

const LIST_SOURCES_INPUT = {
  source_kind: z.enum(SOURCE_KINDS).optional(),
  approval_state: z.enum(APPROVAL_STATES).optional(),
  lifecycle_state: z.enum(LIFECYCLE_STATES).optional(),
  limit: z.number().int().min(1).max(500).optional(),
};

const UPDATE_SOURCE_INPUT = {
  id: z.string().uuid(),
  expected_revision: z.number().int().min(1),
  target_namespace: targetNamespaceArg.optional(),
  title: z.string().trim().min(1).max(500).nullable().optional(),
  scope: scopeArg.optional(),
  language: z.string().trim().min(1).max(100).nullable().optional(),
  config: configArg.optional(),
  lifecycle_state: z.enum(LIFECYCLE_STATES).optional(),
  sync_state: z.enum(SYNC_STATES).optional(),
  last_synced_at: z.string().datetime().nullable().optional(),
  approval_state: z.enum(APPROVAL_STATES).optional(),
};

const REMOVE_SOURCE_INPUT = {
  id: z.string().uuid(),
  target_namespace: targetNamespaceArg.optional(),
};

const ELIGIBILITY_INPUT = {
  source_kind: z.enum(SOURCE_KINDS),
  external_id: z.string().trim().min(1).max(1000),
  target_namespace: targetNamespaceArg.optional(),
};

const COLLECT_DROP_FOLDER_INPUT = {
  external_id: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .describe("The registered drop source's stable external locator"),
  target_namespace: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "Namespace the drop source lives in. Defaults to your own. A " +
        "global admin/ob-admin token may target another namespace; " +
        "header-scoped identities are bound to their header namespace. " +
        "Write authority for this namespace is enforced before any read.",
    ),
  tags: z
    .array(z.string().trim().min(1).max(120))
    .max(64)
    .optional()
    .describe(
      "Content-free tags to carry onto every durable row from this collection (never bodies)",
    ),
};

export function registerSourceRegistryTools(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  registerRegisterSource(server, dependencies);
  registerListSources(server, dependencies);
  registerUpdateSource(server, dependencies);
  registerRemoveSource(server, dependencies);
  registerIngestionEligibility(server, dependencies);
  registerCollectDropFolder(server, dependencies);
}

function registerRegisterSource(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "register_source",
    {
      description:
        "Register an ingestion source (git/directory/drop/conversation) in a " +
        "namespace. Sources start pending; only an approved, active source is " +
        "ingestion-eligible. Re-registering an identical source is idempotent.",
      inputSchema: REGISTER_SOURCE_INPUT,
      annotations: {
        title: "Register Source",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      if (!identity) return failure("unauthenticated", "not authenticated");
      return guarded(dependencies, "register_source", async () => {
        const result = await registerSource(
          dependencies.pool,
          registryAuth(identity),
          args,
        );
        if (!result.ok || !result.data) return registryFailure(result);
        dependencies.logger.info(
          {
            tool: "register_source",
            namespace: result.data.namespace,
            approvalState: result.data.approval_state,
          },
          "tool_result",
        );
        return okResult({ source: publicRecord(result.data) });
      });
    },
  );
}

function registerListSources(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "list_sources",
    {
      description:
        "List registered sources visible to you, constrained to your readable " +
        "namespaces. Supports filtering by kind, approval, and lifecycle state.",
      inputSchema: LIST_SOURCES_INPUT,
      annotations: {
        title: "List Sources",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      if (!identity) return failure("unauthenticated", "not authenticated");
      return guarded(dependencies, "list_sources", async () => {
        const sources = await listSources(
          dependencies.pool,
          registryAuth(identity),
          args,
        );
        dependencies.logger.info(
          { tool: "list_sources", count: sources.length },
          "tool_result",
        );
        return okResult({
          count: sources.length,
          sources: sources.map(publicRecord),
        });
      });
    },
  );
}

function registerUpdateSource(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "update_source",
    {
      description:
        "Update a registered source by id within its namespace. Requires the " +
        "last-observed revision (optimistic concurrency). Approval transitions " +
        "are authorized server-side; a caller cannot self-approve.",
      inputSchema: UPDATE_SOURCE_INPUT,
      annotations: {
        title: "Update Source",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      if (!identity) return failure("unauthenticated", "not authenticated");
      return guarded(dependencies, "update_source", async () => {
        const result = await updateSource(
          dependencies.pool,
          registryAuth(identity),
          args,
        );
        if (!result.ok || !result.data) return registryFailure(result);
        dependencies.logger.info(
          { tool: "update_source", id: result.data.id },
          "tool_result",
        );
        return okResult({ source: publicRecord(result.data) });
      });
    },
  );
}

function registerRemoveSource(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "remove_source",
    {
      description:
        "Retire a registered source (soft delete) within its namespace so it " +
        "can never become ingestion-eligible again; provenance is preserved.",
      inputSchema: REMOVE_SOURCE_INPUT,
      annotations: {
        title: "Remove Source",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      if (!identity) return failure("unauthenticated", "not authenticated");
      return guarded(dependencies, "remove_source", async () => {
        const result = await removeSource(
          dependencies.pool,
          registryAuth(identity),
          args.id,
          args.target_namespace,
        );
        if (!result.ok || !result.data) return registryFailure(result);
        dependencies.logger.info(
          { tool: "remove_source", id: result.data.id },
          "tool_result",
        );
        return okResult({ id: result.data.id });
      });
    },
  );
}

function registerIngestionEligibility(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "source_ingestion_eligibility",
    {
      description:
        "Check whether a source location is ingestion-eligible in a namespace. " +
        "Eligible only when a matching registry entry is approved and active; " +
        "unregistered or unapproved locations are rejected server-side.",
      inputSchema: ELIGIBILITY_INPUT,
      annotations: {
        title: "Source Ingestion Eligibility",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      if (!identity) return failure("unauthenticated", "not authenticated");
      return guarded(dependencies, "source_ingestion_eligibility", async () => {
        const result = await resolveIngestionEligibility(
          dependencies.pool,
          registryAuth(identity),
          args,
        );
        // Ineligibility is an ANSWER, not a tool failure: the caller asked a
        // yes/no question and gets `eligible: false` with the typed reason.
        if (!result.ok || !result.data) {
          return okResult({
            eligible: false,
            code: result.code ?? "not_found",
          });
        }
        return okResult({ eligible: true, source: publicRecord(result.data) });
      });
    },
  );
}

function registerCollectDropFolder(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "collect_drop_folder",
    {
      description:
        "Ingest files placed under a registered, approved, active 'drop' source's " +
        "folder. The server derives the folder root from the durable source " +
        "registry, discovers and reads bounded supported files itself, and " +
        "ingests them through the shared metadata + durable capture path. " +
        "Callers select the approved source and bounded options; they never " +
        "submit file bodies or paths. Unregistered/unapproved sources and " +
        "callers without write authority for the target namespace are rejected " +
        "before any file is read. Repeated content dedupes by hash, so a rerun " +
        "of an unchanged folder is a no-op.",
      inputSchema: COLLECT_DROP_FOLDER_INPUT,
      annotations: {
        title: "Collect Drop Folder",
        readOnlyHint: false,
        destructiveHint: false,
        // Repeated identical content dedupes by hash, so re-running an
        // unchanged folder produces no new durable state.
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      if (!identity) return failure("unauthenticated", "not authenticated");
      try {
        // The collector proves eligibility AND write authority for the target
        // namespace before it reads a single file.
        const result = await collectDropFolder(
          { pool: dependencies.pool, embedFn: dependencies.embedFn },
          registryAuth(identity),
          args,
          dependencies.dropCollectorBounds
            ? { bounds: dependencies.dropCollectorBounds }
            : {},
        );
        dependencies.logger.info(
          {
            tool: "collect_drop_folder",
            eligible: result.eligible,
            code: result.code,
            collected: result.collected,
          },
          "tool_result",
        );
        return textResult(publicCollection(result));
      } catch (error) {
        dependencies.logger.error(
          {
            operation: "collect_drop_folder",
            error: internalErrorLabel(error),
          },
          "drop_folder_internal_error",
        );
        return failure("internal_error", "drop folder collection failed");
      }
    },
  );
}

/**
 * Content-free public view of a collection.
 *
 * The collector's own result is already body-free -- typed codes, opaque file
 * tokens, counts, durable ids -- and centralizing the projection here keeps a
 * later-added internal field from leaking by default.
 */
function publicCollection(result: CollectDropFolderResult) {
  if (!result.eligible) {
    return { ok: false, eligible: false as const, code: result.code };
  }
  // Eligible but unable to resolve a folder root: still content-free, still
  // reported as a typed failure rather than an empty success.
  if (!result.ok) {
    return {
      ok: false,
      eligible: true as const,
      code: result.code,
      namespace: result.namespace,
    };
  }
  return {
    ok: true,
    eligible: true as const,
    namespace: result.namespace,
    collected: result.collected,
    deduped: result.deduped,
    skipped: result.skipped,
    truncated: result.truncated,
    files: result.files,
  };
}
