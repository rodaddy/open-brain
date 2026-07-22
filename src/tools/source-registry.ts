import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "../types.ts";
import { logger } from "../logger.ts";
import {
  SOURCE_KINDS,
  APPROVAL_STATES,
  LIFECYCLE_STATES,
  SYNC_STATES,
  registerSource,
  listSources,
  updateSource,
  removeSource,
  resolveIngestionEligibility,
  type SourceRecord,
  type SourceRegistryResult,
} from "../source-registry.ts";
import type { ToolDeps } from "./index.ts";

// Stable, content-free error text for a source-registry failure. Maps the
// module's typed result code to a fixed downstream-safe message; the module's
// `reason` (already content-free) is included but the shape never leaks a
// source body, path, or secret. Every failing tool call returns isError.
function errorResult(result: SourceRegistryResult<unknown>) {
  const code = result.code ?? "error";
  const reason = result.reason ?? "source registry operation failed";
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ok: false, code, error: reason }),
      },
    ],
    isError: true,
  };
}

function okResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ok: true, ...(payload as object) }),
      },
    ],
  };
}

function unauthenticated() {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          ok: false,
          code: "unauthenticated",
          error: "not authenticated",
        }),
      },
    ],
    isError: true,
  };
}

// One stable, content-free envelope for an UNEXPECTED database (or other
// internal) failure that escapes the registry layer as a thrown error. Typed
// expected results (namespace_denied, not_found, stale_revision, retired,
// conflict, approval_state) go through errorResult and are unaffected; this is
// only for the throw path. The response body is fixed text and never carries
// err.message, row/source values, ids, paths, or config.
function internalError() {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          ok: false,
          code: "internal_error",
          error: "source registry operation failed",
        }),
      },
    ],
    isError: true,
  };
}

// Content-free label for a thrown error: the error's class/name or an
// allowlisted string code only -- never err.message, which can carry a raw
// driver string echoing row/source values. Mirrors extraction.ts's label so
// registry logs stay body-free.
function internalErrorLabel(err: unknown): string {
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Za-z_]{1,32}$/.test(code)) {
      return code;
    }
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string" && /^[A-Za-z_]{1,64}$/.test(name)) {
      return name;
    }
  }
  return "unknown_error";
}

// Run a registry call, converting any UNEXPECTED thrown failure into the stable
// content-free internal_error envelope while logging only the operation name and
// an allowlisted error code/name. Typed SourceRegistryResult values (including
// their content-free `reason`) are returned to the caller unchanged; only the
// throw path is intercepted. Never logs or returns err.message.
async function guarded<T>(
  operation: string,
  run: () => Promise<T>,
): Promise<T | ReturnType<typeof internalError>> {
  try {
    return await run();
  } catch (err) {
    logger.error("source_registry_internal_error", {
      operation,
      error: internalErrorLabel(err),
    });
    return internalError();
  }
}

// Content-free public view of a source record. Excludes nothing sensitive
// (the row never stores bodies), but centralizing the shape keeps the tool
// output stable and free of internal-only columns should any be added later.
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

export function registerSourceRegistry(
  server: McpServer,
  deps: ToolDeps,
): void {
  server.registerTool(
    "register_source",
    {
      description:
        "Register an ingestion source (git/directory/drop/conversation) in a " +
        "namespace. Sources start pending; only an approved, active source is " +
        "ingestion-eligible. Re-registering an identical source is idempotent.",
      inputSchema: {
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
      },
      annotations: {
        title: "Register Source",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth) return unauthenticated();
      return guarded("register_source", async () => {
        const result = await registerSource(deps.pool, auth, args);
        if (!result.ok || !result.data) return errorResult(result);
        logger.info("register_source_success", {
          namespace: result.data.namespace,
          source_kind: result.data.source_kind,
          approval_state: result.data.approval_state,
        });
        return okResult({ source: publicRecord(result.data) });
      });
    },
  );

  server.registerTool(
    "list_sources",
    {
      description:
        "List registered sources visible to you, constrained to your readable " +
        "namespaces. Supports filtering by kind, approval, and lifecycle state.",
      inputSchema: {
        source_kind: z.enum(SOURCE_KINDS).optional(),
        approval_state: z.enum(APPROVAL_STATES).optional(),
        lifecycle_state: z.enum(LIFECYCLE_STATES).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      annotations: {
        title: "List Sources",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth) return unauthenticated();
      return guarded("list_sources", async () => {
        const sources = await listSources(deps.pool, auth, args);
        logger.info("list_sources_success", { count: sources.length });
        return okResult({
          count: sources.length,
          sources: sources.map(publicRecord),
        });
      });
    },
  );

  server.registerTool(
    "update_source",
    {
      description:
        "Update a registered source by id within its namespace. Requires the " +
        "last-observed revision (optimistic concurrency). Approval transitions " +
        "are authorized server-side; a caller cannot self-approve.",
      inputSchema: {
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
      },
      annotations: {
        title: "Update Source",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth) return unauthenticated();
      return guarded("update_source", async () => {
        const result = await updateSource(deps.pool, auth, args);
        if (!result.ok || !result.data) return errorResult(result);
        logger.info("update_source_success", {
          namespace: result.data.namespace,
          id: result.data.id,
        });
        return okResult({ source: publicRecord(result.data) });
      });
    },
  );

  server.registerTool(
    "remove_source",
    {
      description:
        "Retire a registered source (soft delete) within its namespace so it " +
        "can never become ingestion-eligible again; provenance is preserved.",
      inputSchema: {
        id: z.string().uuid(),
        target_namespace: targetNamespaceArg.optional(),
      },
      annotations: {
        title: "Remove Source",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth) return unauthenticated();
      return guarded("remove_source", async () => {
        const result = await removeSource(
          deps.pool,
          auth,
          args.id,
          args.target_namespace,
        );
        if (!result.ok || !result.data) return errorResult(result);
        logger.info("remove_source_success", { id: result.data.id });
        return okResult({ id: result.data.id });
      });
    },
  );

  server.registerTool(
    "source_ingestion_eligibility",
    {
      description:
        "Check whether a source location is ingestion-eligible in a namespace. " +
        "Eligible only when a matching registry entry is approved and active; " +
        "unregistered or unapproved locations are rejected server-side.",
      inputSchema: {
        source_kind: z.enum(SOURCE_KINDS),
        external_id: z.string().trim().min(1).max(1000),
        target_namespace: targetNamespaceArg.optional(),
      },
      annotations: {
        title: "Source Ingestion Eligibility",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth) return unauthenticated();
      return guarded("source_ingestion_eligibility", async () => {
        const result = await resolveIngestionEligibility(deps.pool, auth, args);
        if (!result.ok || !result.data) {
          // Ineligibility is an expected answer, not a tool error: return a
          // content-free eligible=false envelope with the typed reason code.
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
