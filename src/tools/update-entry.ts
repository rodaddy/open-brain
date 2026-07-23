import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toSql } from "pgvector/pg";
import { canWrite } from "../permissions.ts";
import { appendWriteNamespacePredicate } from "../namespace-policy.ts";
import { contentHash, EMBEDDING_MODEL } from "../embedding.ts";
import {
  decisionCanonicalText,
  sessionEmbedText,
  sessionSourceHashInput,
} from "../embedding-canonical.ts";
import type { AuthInfo, Table } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";

/** Which optional fields are valid for each table */
const VALID_FIELDS: Record<Table, string[]> = {
  thoughts: ["content", "tags"],
  decisions: ["title", "rationale", "context", "alternatives", "tags"],
  relationships: [
    "person_name",
    "context",
    "relationship_type",
    "warmth",
    "last_contact",
    "email",
    "phone",
    "notes",
    "tags",
    "metadata",
  ],
  projects: ["name", "description", "tags"],
  sessions: [
    "summary",
    "project",
    "key_decisions",
    "next_steps",
    "blockers",
    "tags",
  ],
};

/**
 * Which fields, when changed, mark the embedding stale and require re-embedding.
 *
 * For decisions and sessions this MUST list every field the shared canonical
 * builder folds into the embed text / source-hash input -- not just the primary
 * text. The repair registry (src/embedding-targets.ts) recomputes the source
 * hash from ALL of these fields, so if a context/alternatives/tags edit (or a
 * project/key_decisions/next_steps/blockers edit) did not re-embed, the stored
 * content_hash would immediately disagree with the registry and repair would
 * flag the freshly-updated row as source_drift.
 */
const CONTENT_FIELDS: Record<Table, string[]> = {
  thoughts: ["content"],
  decisions: ["title", "rationale", "context", "alternatives", "tags"],
  relationships: ["person_name", "context", "notes"],
  projects: ["name", "description"],
  sessions: ["summary", "project", "key_decisions", "next_steps", "blockers"],
};

/**
 * Source-hash input for the merged post-update row.
 *
 * For most tables the embed text and the hash input are the same string, so this
 * returns the embed text. Sessions are the exception: they HASH `summary|project`
 * but EMBED a richer continuity text, so the registry's sourceHash is computed
 * from sessionSourceHashInput(), NOT from the embed text. Keeping the hash input
 * distinct here mirrors src/embedding-targets.ts:sessions exactly.
 */
function buildHashInput(table: Table, merged: Record<string, unknown>): string {
  if (table === "sessions") {
    return sessionSourceHashInput(merged);
  }
  return buildEmbeddableText(table, merged);
}

/**
 * Build embeddable text from merged field values.
 *
 * decisions and sessions route through the shared canonical builders
 * (decisionCanonicalText / sessionEmbedText) so this writer, the other live
 * writers, and the embedding-repair registry all agree on the exact string.
 */
function buildEmbeddableText(
  table: Table,
  merged: Record<string, unknown>,
): string {
  switch (table) {
    case "thoughts":
      return merged.content as string;
    case "decisions":
      return decisionCanonicalText(merged);
    case "relationships":
      return [merged.person_name, merged.context ?? "", merged.notes ?? ""]
        .filter(Boolean)
        .join("\n");
    case "projects":
      return `${merged.name}: ${merged.description ?? ""}`;
    case "sessions":
      return sessionEmbedText(merged);
  }
}

export function registerUpdateEntry(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "update_entry",
    {
      description:
        "Update a brain entry's mutable fields. Re-embeds content when semantic fields change.",
      inputSchema: {
        table: z
          .enum([
            "thoughts",
            "decisions",
            "relationships",
            "projects",
            "sessions",
          ])
          .describe("Table containing the entry"),
        id: z.string().uuid().describe("UUID of the entry to update"),
        content: z.string().optional().describe("New content (thoughts)"),
        title: z.string().optional().describe("New title (decisions)"),
        rationale: z.string().optional().describe("New rationale (decisions)"),
        alternatives: z
          .array(z.string())
          .optional()
          .describe("New alternatives considered (decisions)"),
        summary: z.string().optional().describe("New summary (sessions)"),
        project: z.string().optional().describe("New project (sessions)"),
        key_decisions: z
          .array(z.string())
          .optional()
          .describe("New key decisions (sessions)"),
        next_steps: z
          .array(z.string())
          .optional()
          .describe("New next steps (sessions)"),
        blockers: z
          .array(z.string())
          .optional()
          .describe("New blockers (sessions)"),
        person_name: z
          .string()
          .optional()
          .describe("New person name (relationships)"),
        context: z
          .string()
          .optional()
          .describe("New context (decisions, relationships)"),
        name: z.string().optional().describe("New name (projects)"),
        description: z
          .string()
          .optional()
          .describe("New description (projects)"),
        tags: z.array(z.string()).optional().describe("New tags (any table)"),
        relationship_type: z
          .string()
          .optional()
          .describe("Relationship category (relationships)"),
        warmth: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe("Closeness 1-5 (relationships)"),
        last_contact: z
          .string()
          .optional()
          .describe("Last contact date (relationships)"),
        email: z.string().optional().describe("Email (relationships)"),
        phone: z.string().optional().describe("Phone (relationships)"),
        notes: z.string().optional().describe("Notes (relationships)"),
        metadata: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Additional data (relationships)"),
      },
      annotations: {
        title: "Update Entry",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      const table = args.table as Table;

      if (!auth || !canWrite(auth.role, table)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: cannot write to " + table,
            },
          ],
          isError: true,
        };
      }

      // Filter to valid fields for this table
      const validFieldNames = VALID_FIELDS[table];
      const providedFields: Record<string, unknown> = {};
      const argsRecord = args as Record<string, unknown>;
      for (const field of validFieldNames) {
        if (argsRecord[field] !== undefined) {
          providedFields[field] = argsRecord[field];
        }
      }

      if (Object.keys(providedFields).length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No valid fields to update for table ${table}`,
            },
          ],
          isError: true,
        };
      }

      // Use a transaction to prevent TOCTOU races between SELECT and UPDATE
      const client = await deps.pool.connect();
      try {
        await client.query("BEGIN");

        // SELECT existing row with FOR UPDATE lock -- explicit columns to avoid fetching embeddings
        const selectCols = [...VALID_FIELDS[table], "archived_at"].join(", ");
        const selectParams: unknown[] = [args.id];
        const selectNamespacePredicate = appendWriteNamespacePredicate(
          auth,
          selectParams,
        );
        const { rows: existingRows } = await client.query(
          `SELECT id, namespace, ${selectCols} FROM ${table} WHERE id = $1${selectNamespacePredicate} FOR UPDATE`,
          selectParams,
        );

        if (existingRows.length === 0) {
          await client.query("ROLLBACK");
          return {
            content: [{ type: "text" as const, text: "Not found" }],
            isError: true,
          };
        }

        const existingRow = existingRows[0];

        // Archived guard
        if (existingRow.archived_at != null) {
          await client.query("ROLLBACK");
          return {
            content: [
              {
                type: "text" as const,
                text: "Entry is archived -- restore it first",
              },
            ],
            isError: true,
          };
        }

        // Determine if re-embedding is needed
        const contentFieldNames = CONTENT_FIELDS[table];
        const needsReembed = contentFieldNames.some(
          (f) => providedFields[f] !== undefined,
        );

        let embedding: number[] | null = null;
        let hash: string | null = null;

        if (needsReembed) {
          // Merge changed fields over existing row
          const merged: Record<string, unknown> = {};
          for (const f of contentFieldNames) {
            merged[f] =
              providedFields[f] !== undefined
                ? providedFields[f]
                : existingRow[f];
          }

          const embeddableText = buildEmbeddableText(table, merged);
          // Sessions hash `summary|project` but embed a richer text; every other
          // table hashes the same string it embeds. buildHashInput() keeps this
          // split aligned with the embedding-repair registry so the row we write
          // is not immediately flagged as source_drift.
          hash = contentHash(buildHashInput(table, merged));

          // Check content_hash collision
          const { rows: collisionRows } = await client.query(
            `SELECT id FROM ${table} WHERE content_hash = $1 AND id != $2 AND namespace = $3`,
            [hash, args.id, existingRow.namespace],
          );

          if (collisionRows.length > 0) {
            await client.query("ROLLBACK");
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Duplicate content exists in another entry",
                },
              ],
              isError: true,
            };
          }

          embedding = await deps.embedFn(embeddableText);
          logger.info("update_entry_embedding", {
            tool: "update_entry",
            table,
            embedded: !!embedding,
          });
        }

        // Build dynamic UPDATE
        const setClauses: string[] = [];
        const params: unknown[] = [];
        let paramIndex = 1;

        // Add provided fields
        for (const [field, value] of Object.entries(providedFields)) {
          // decisions.alternatives is a jsonb column -- a raw JS array serializes
          // as a Postgres array literal ("{..}"), which is invalid JSON. Encode
          // it explicitly, matching the log_decision / REST writers.
          if (table === "decisions" && field === "alternatives") {
            setClauses.push(`${field} = $${paramIndex}::jsonb`);
            params.push(JSON.stringify(value ?? []));
          } else {
            setClauses.push(`${field} = $${paramIndex}`);
            params.push(value);
          }
          paramIndex++;
        }

        // Add embedding fields if re-embedding
        if (needsReembed) {
          setClauses.push(`embedding = $${paramIndex}`);
          params.push(embedding ? toSql(embedding) : null);
          paramIndex++;

          setClauses.push(`content_hash = $${paramIndex}`);
          params.push(hash);
          paramIndex++;

          setClauses.push(`embedded_at = $${paramIndex}`);
          params.push(embedding ? new Date().toISOString() : null);
          paramIndex++;

          setClauses.push(`embedding_model = $${paramIndex}`);
          params.push(embedding ? EMBEDDING_MODEL : null);
          paramIndex++;
        }

        setClauses.push("updated_at = NOW()");

        // Add WHERE id plus caller write-scope namespace guard
        params.push(args.id);
        const idParam = params.length;
        const updateNamespacePredicate = appendWriteNamespacePredicate(
          auth,
          params,
        );
        const updateSql = `UPDATE ${table} SET ${setClauses.join(", ")} WHERE id = $${idParam}${updateNamespacePredicate} RETURNING id`;

        const { rows: updatedRows } = await client.query(updateSql, params);

        await client.query("COMMIT");

        if (updatedRows.length === 0) {
          return {
            content: [{ type: "text" as const, text: "Update failed" }],
            isError: true,
          };
        }

        logger.info("update_entry_success", {
          table,
          id: updatedRows[0].id,
          fields: Object.keys(providedFields),
          reembedded: needsReembed,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                id: updatedRows[0].id,
                table,
                updated: true,
                embedded: needsReembed && !!embedding,
              }),
            },
          ],
        };
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  );
}
