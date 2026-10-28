import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { authIdentity, textResult, type MemoryToolDependencies } from "./types.ts";
import { namespacePredicate } from "../auth/namespace-policy.ts";
import { createSessionRepository } from "../db/session-repository.ts";
import { insertEntryAccessLog } from "../db/access-log-repository.ts";
import {
  authorize,
  contentHash,
  embeddingFields,
  sessionEmbedText,
} from "./memory-helpers.ts";

/**
 * The declared input shapes of the two tools, lifted out of their registration
 * calls so each registration body stays readable. Values and constraints are
 * unchanged from the inline schemas they replace.
 */
const SAVE_INPUT_SCHEMA = {
  summary: z.string().min(1),
  project: z.string().optional(),
  session_id: z.string().optional(),
  tags: z.array(z.string()).optional(),
  blockers: z.array(z.string()).optional(),
  next_steps: z.array(z.string()).optional(),
  key_decisions: z.array(z.string()).optional(),
  namespace: z.string().min(1).max(500).optional(),
};

const LOAD_INPUT_SCHEMA = { project: z.string().optional() };

type SaveArgs = z.infer<z.ZodObject<typeof SAVE_INPUT_SCHEMA>>;
type LoadArgs = z.infer<z.ZodObject<typeof LOAD_INPUT_SCHEMA>>;

export function registerSessionSaveLoadTools(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  registerSessionSave(server, dependencies);
  registerSessionLoad(server, dependencies);
}

/**
 * Upsert the session row, keyed on (namespace, session_id) when the caller
 * supplied one. `xmax = 0` distinguishes an insert from an update on the same
 * statement, which is what the tool reports back as `merged`.
 */
async function saveSession(
  dependencies: MemoryToolDependencies,
  namespace: string,
  clientId: string,
  args: SaveArgs,
): Promise<{ id: unknown; merged: boolean; embedded: boolean }> {
  const embedded = await embeddingFields(dependencies, sessionEmbedText(args));
  const repository = createSessionRepository(dependencies.pool);
  const row = await repository.upsertSavedSession({
    values: [
      args.session_id ?? null,
      args.project ?? null,
      args.summary,
      args.tags ?? [],
      args.blockers ?? [],
      args.next_steps ?? [],
      args.key_decisions ?? [],
      clientId,
      namespace,
      embedded.embedding,
      contentHash(`${args.summary}|${args.project ?? ""}`),
      embedded.embeddedAt,
      embedded.model,
    ],
  });
  return { id: row.id, merged: !row.is_new, embedded: embedded.embedded };
}

function registerSessionSave(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "session_save",
    {
      description:
        "Save a session summary with structured fields for session continuity across context compactions",
      inputSchema: SAVE_INPUT_SCHEMA,
      annotations: {
        title: "Save Session",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args, extra) => {
      const auth = authorize(authIdentity(extra.authInfo), {
        operation: "write",
        table: "sessions",
        permissionMessage: "cannot write to sessions",
        requestedNamespace: args.namespace,
      });
      if (!auth.ok) return auth.response;
      const saved = await saveSession(
        dependencies,
        auth.namespace,
        auth.identity.clientId,
        args,
      );
      dependencies.logger.info(
        { tool: "session_save", namespace: auth.namespace },
        "tool_result",
      );
      return textResult({
        id: saved.id,
        namespace: auth.namespace,
        ...(args.session_id ? { session_id: args.session_id } : {}),
        embedded: saved.embedded,
        merged: saved.merged,
      });
    },
  );
}

/**
 * Read the most recent unarchived session, newest first.
 *
 * Global roles read every namespace, so the predicate builder returns an
 * empty clause for them. Hardcoding the caller's own namespace list here
 * would silently hide rows from admin, ob-admin, and promoter.
 */
async function loadSessions(
  dependencies: MemoryToolDependencies,
  identity: Parameters<typeof namespacePredicate>[0],
  args: LoadArgs,
): Promise<Record<string, unknown>[]> {
  const values: unknown[] = [];
  const projectClause = args.project
    ? ` AND project = $${values.push(args.project)}`
    : "";
  const predicate = namespacePredicate(identity, "read", values.length + 1);
  values.push(...predicate.values);
  const repository = createSessionRepository(dependencies.pool);
  return repository.selectSavedSessions({
    projectClause,
    namespaceClause: predicate.clause,
    values,
  });
}

/**
 * Log the loaded session to `entry_access_log` with context 'session_load'
 * (issue 1486), restoring the write the legacy `logSessionAccess` made.
 *
 * Fire-and-forget, as the removed writer was: the insert never delays or fails
 * the load. A failure is logged without content and swallowed.
 */
function logSessionAccess(
  dependencies: MemoryToolDependencies,
  sessionId: string,
  accessedBy: string,
): void {
  insertEntryAccessLog(dependencies.pool, {
    entries: [{ id: sessionId, table: "sessions" }],
    queryText: null,
    context: "session_load",
    accessedBy,
  }).catch((error: unknown) => {
    dependencies.logger.warn(
      { error_code: (error as { code?: unknown }).code ?? null },
      "session_load_access_log_error",
    );
  });
}

function registerSessionLoad(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "session_load",
    {
      description:
        "Load the most recent session summary, optionally filtered by project",
      inputSchema: LOAD_INPUT_SCHEMA,
      annotations: {
        title: "Load Session",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = authorize(authIdentity(extra.authInfo), {
        operation: "read",
        table: "sessions",
        permissionMessage: "cannot read sessions",
      });
      if (!auth.ok) return auth.response;
      const rows = await loadSessions(dependencies, auth.identity, args);
      if (rows.length === 0) {
        return textResult(
          args.project
            ? `No sessions found for project: ${args.project}`
            : "No sessions found",
        );
      }
      const loaded = rows[0];
      logSessionAccess(dependencies, String(loaded?.id), auth.identity.clientId);
      dependencies.logger.info(
        { tool: "session_load", project: args.project ?? null },
        "tool_result",
      );
      return textResult(loaded);
    },
  );
}
