import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo, Table } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";

const CONTENT_COLUMNS: Record<Table, string> = {
  thoughts:
    "content, tags, source, created_by, embedding, content_hash, embedded_at, embedding_model, tier, usefulness_score, extracted_metadata",
  decisions:
    "title, rationale, alternatives, context, tags, created_by, embedding, content_hash, embedded_at, embedding_model, tier, usefulness_score, extracted_metadata",
  relationships:
    "person_name, context, relationship_type, warmth, last_contact, email, phone, notes, tags, metadata, created_by, embedding, content_hash, embedded_at, embedding_model, tier, usefulness_score",
  projects:
    "name, status, description, metadata, tags, created_by, embedding, content_hash, embedded_at, embedding_model, tier, usefulness_score",
  sessions:
    "session_id, project, summary, tags, blockers, next_steps, key_decisions, created_by, embedding, content_hash, embedded_at, embedding_model, tier",
};

export function registerPromoteEntry(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "promote_entry",
    {
      description:
        "Promote an entry from an agent namespace to collab (or another target namespace). " +
        "Copies the entry with provenance tracking. Checks for duplicates by content_hash.",
      inputSchema: {
        table: z.enum(["thoughts", "decisions", "relationships", "projects", "sessions"]).describe("Source table"),
        id: z.string().uuid().describe("Source entry UUID"),
        reason: z.string().max(1000).optional().describe("Why this entry is being promoted"),
        target_namespace: z.string().min(1).max(500).optional().describe("Target namespace (default: collab)"),
      },
      annotations: {
        title: "Promote Entry",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth || (auth.role !== "admin" && auth.role !== "n8n")) {
        return {
          content: [{ type: "text" as const, text: "Permission denied: admin or n8n role required" }],
          isError: true,
        };
      }

      const table = args.table as Table;
      const targetNs = args.target_namespace ?? "collab";

      const { rows: sourceRows } = await deps.pool.query(
        `SELECT *, namespace AS source_namespace FROM ${table} WHERE id = $1 AND archived_at IS NULL`,
        [args.id],
      );

      if (sourceRows.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Source entry not found or archived" }],
          isError: true,
        };
      }

      const source = sourceRows[0];

      if (source.namespace === targetNs) {
        return {
          content: [{ type: "text" as const, text: `Entry is already in namespace '${targetNs}'` }],
          isError: true,
        };
      }

      if (source.content_hash) {
        const { rows: dupes } = await deps.pool.query(
          `SELECT id FROM ${table} WHERE content_hash = $1 AND namespace = $2 AND archived_at IS NULL`,
          [source.content_hash, targetNs],
        );

        if (dupes.length > 0) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "duplicate",
                existing_id: dupes[0].id,
                source_id: args.id,
                target_namespace: targetNs,
              }),
            }],
          };
        }
      }

      const provenance = {
        source_namespace: source.namespace,
        source_id: args.id,
        source_agent: source.created_by,
        promotion_reason: args.reason ?? null,
        promoted_at: new Date().toISOString(),
        promoted_by: auth.clientId,
      };

      const columns = CONTENT_COLUMNS[table];
      const { rows: inserted } = await deps.pool.query(
        `INSERT INTO ${table} (${columns}, namespace, promoted_from)
         SELECT ${columns}, $2, $3::jsonb
         FROM ${table} WHERE id = $1
         RETURNING id`,
        [args.id, targetNs, JSON.stringify(provenance)],
      );

      const newId = inserted[0].id;

      logger.info("promote_entry_ok", {
        table,
        source_id: args.id,
        new_id: newId,
        source_namespace: source.namespace,
        target_namespace: targetNs,
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "promoted",
            new_id: newId,
            source_id: args.id,
            source_namespace: source.namespace,
            target_namespace: targetNs,
            provenance,
          }),
        }],
      };
    },
  );
}
