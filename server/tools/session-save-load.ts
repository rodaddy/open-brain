import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  authIdentity,
  textResult,
  type MemoryToolDependencies,
} from "./types.ts";
import { namespacePredicate } from "../auth/namespace-policy.ts";
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
  const rows = await dependencies.pool.query(
    `INSERT INTO sessions
       (session_id, project, summary, tags, blockers, next_steps, key_decisions,
        created_by, namespace, embedding, content_hash, embedded_at, embedding_model)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (namespace, session_id) WHERE session_id IS NOT NULL
     DO UPDATE SET summary = EXCLUDED.summary, tags = EXCLUDED.tags,
       blockers = EXCLUDED.blockers, next_steps = EXCLUDED.next_steps,
       key_decisions = EXCLUDED.key_decisions, embedding = EXCLUDED.embedding,
       content_hash = EXCLUDED.content_hash, embedded_at = EXCLUDED.embedded_at,
       embedding_model = EXCLUDED.embedding_model, updated_at = NOW()
     RETURNING id, (xmax = 0) AS is_new`,
    [
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
  );
  const row = rows.rows[0];
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
      const auth = authorize(
        authIdentity(extra.authInfo),
        "write",
        "sessions",
        "cannot write to sessions",
        args.namespace,
      );
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
  const rows = await dependencies.pool.query(
    `SELECT id, project, summary, tags, blockers, next_steps, key_decisions,
            created_by, created_at
       FROM sessions
      WHERE archived_at IS NULL${projectClause}${predicate.clause}
      ORDER BY created_at DESC`,
    values,
  );
  return rows.rows;
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
      const auth = authorize(
        authIdentity(extra.authInfo),
        "read",
        "sessions",
        "cannot read sessions",
      );
      if (!auth.ok) return auth.response;
      const rows = await loadSessions(dependencies, auth.identity, args);
      if (rows.length === 0) {
        return textResult(
          args.project
            ? `No sessions found for project: ${args.project}`
            : "No sessions found",
        );
      }
      dependencies.logger.info(
        { tool: "session_load", project: args.project ?? null },
        "tool_result",
      );
      return textResult(rows[0]);
    },
  );
}
