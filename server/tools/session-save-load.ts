import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { authIdentity, textResult, type MemoryToolDependencies } from "./types.ts";
import { namespacePredicate } from "../auth/namespace-policy.ts";
import { authorize, contentHash, embeddingFields, sessionEmbedText } from "./memory-helpers.ts";

export function registerSessionSaveLoadTools(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "session_save",
    {
      description: "Save a session summary with structured fields for session continuity across context compactions",
      inputSchema: {
        summary: z.string().min(1),
        project: z.string().optional(),
        session_id: z.string().optional(),
        tags: z.array(z.string()).optional(),
        blockers: z.array(z.string()).optional(),
        next_steps: z.array(z.string()).optional(),
        key_decisions: z.array(z.string()).optional(),
        namespace: z.string().min(1).max(500).optional(),
      },
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
          auth.identity.clientId,
          auth.namespace,
          embedded.embedding,
          contentHash(`${args.summary}|${args.project ?? ""}`),
          embedded.embeddedAt,
          embedded.model,
        ],
      );
      const row = rows.rows[0];
      dependencies.logger.info({ tool: "session_save", namespace: auth.namespace }, "tool_result");
      return textResult({
        id: row.id,
        namespace: auth.namespace,
        ...(args.session_id ? { session_id: args.session_id } : {}),
        embedded: embedded.embedded,
        merged: !row.is_new,
      });
    },
  );

  server.registerTool(
    "session_load",
    {
      description: "Load the most recent session summary, optionally filtered by project",
      inputSchema: { project: z.string().optional() },
      annotations: {
        title: "Load Session",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = authorize(authIdentity(extra.authInfo), "read", "sessions", "cannot read sessions");
      if (!auth.ok) return auth.response;
      // Global roles read every namespace, so the predicate builder returns an
      // empty clause for them. Hardcoding the caller's own namespace list here
      // would silently hide rows from admin, ob-admin, and promoter.
      const values: unknown[] = [];
      const projectClause = args.project ? ` AND project = $${values.push(args.project)}` : "";
      const predicate = namespacePredicate(auth.identity, "read", values.length + 1);
      values.push(...predicate.values);
      const rows = await dependencies.pool.query(
        `SELECT id, project, summary, tags, blockers, next_steps, key_decisions,
                created_by, created_at
           FROM sessions
          WHERE archived_at IS NULL${projectClause}${predicate.clause}
          ORDER BY created_at DESC`,
        values,
      );
      if (rows.rows.length === 0) {
        return textResult(args.project ? `No sessions found for project: ${args.project}` : "No sessions found");
      }
      dependencies.logger.info({ tool: "session_load", project: args.project ?? null }, "tool_result");
      return textResult(rows.rows[0]);
    },
  );
}
