/**
 * `update_entry`: mutable-field updates with re-embedding on semantic change.
 *
 * The whole handler runs inside one transaction with `SELECT ... FOR UPDATE`,
 * because the archived-guard and the content-hash collision check are both
 * read-then-write pairs: without the lock, a concurrent archive or an identical
 * concurrent write lands between the SELECT and the UPDATE and the guard passes
 * on state that no longer holds.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toSql } from "pgvector/pg";
import { namespacePredicate } from "../auth/namespace-policy.ts";
import type { ResourceTable } from "../auth/types.ts";
import { authIdentity, errorResult, textResult, type MemoryToolDependencies } from "./types.ts";
import { authorize, contentHash } from "./memory-helpers.ts";
import { tableEnum } from "./curation-helpers.ts";
import {
  decisionCanonicalText,
  sessionCanonicalEmbedText,
  sessionSourceHashInput,
} from "./entry-text.ts";

/** Mutable fields per table. Anything outside this map never reaches SQL. */
const VALID_FIELDS: Readonly<Record<ResourceTable, readonly string[]>> = {
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
  sessions: ["summary", "project", "key_decisions", "next_steps", "blockers", "tags"],
};

/**
 * Fields whose change makes the stored embedding stale.
 *
 * For decisions and sessions this MUST list every field the canonical builder
 * folds in, not just the primary text: the repair registry recomputes the
 * source hash from all of them, so a context/tags edit that skipped re-embedding
 * would leave the stored hash disagreeing with the registry immediately.
 */
const CONTENT_FIELDS: Readonly<Record<ResourceTable, readonly string[]>> = {
  thoughts: ["content"],
  decisions: ["title", "rationale", "context", "alternatives", "tags"],
  relationships: ["person_name", "context", "notes"],
  projects: ["name", "description"],
  sessions: ["summary", "project", "key_decisions", "next_steps", "blockers"],
};

/** Build the embeddable text for a merged post-update row. */
function buildEmbeddableText(table: ResourceTable, merged: Record<string, unknown>): string {
  switch (table) {
    case "thoughts":
      return String(merged.content ?? "");
    case "decisions":
      return decisionCanonicalText(merged);
    case "relationships":
      return [merged.person_name, merged.context ?? "", merged.notes ?? ""]
        .filter(Boolean)
        .join("\n");
    case "projects":
      return `${merged.name}: ${merged.description ?? ""}`;
    case "sessions":
      return sessionCanonicalEmbedText(merged);
  }
}

/** Build the source-hash input, which sessions compute differently. */
function buildHashInput(table: ResourceTable, merged: Record<string, unknown>): string {
  if (table === "sessions") return sessionSourceHashInput(merged);
  return buildEmbeddableText(table, merged);
}

export function registerUpdateEntryTool(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "update_entry",
    {
      description:
        "Update a brain entry's mutable fields. Re-embeds content when semantic fields change.",
      inputSchema: {
        table: tableEnum,
        id: z.string().uuid(),
        content: z.string().optional(),
        title: z.string().optional(),
        rationale: z.string().optional(),
        alternatives: z.array(z.string()).optional(),
        summary: z.string().optional(),
        project: z.string().optional(),
        key_decisions: z.array(z.string()).optional(),
        next_steps: z.array(z.string()).optional(),
        blockers: z.array(z.string()).optional(),
        person_name: z.string().optional(),
        context: z.string().optional(),
        name: z.string().optional(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        relationship_type: z.string().optional(),
        warmth: z.number().int().min(1).max(5).optional(),
        last_contact: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        notes: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: {
        title: "Update Entry",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args, extra) => {
      const auth = authorize(
        authIdentity(extra.authInfo),
        "write",
        args.table,
        `cannot write to ${args.table}`,
      );
      if (!auth.ok) return auth.response;
      const table = args.table;

      const argsRecord = args as Record<string, unknown>;
      const providedFields: Record<string, unknown> = {};
      for (const field of VALID_FIELDS[table]) {
        if (argsRecord[field] !== undefined) providedFields[field] = argsRecord[field];
      }
      if (Object.keys(providedFields).length === 0) {
        return errorResult(`No valid fields to update for table ${table}`);
      }

      const client = await dependencies.pool.connect();
      try {
        await client.query("BEGIN");

        const selectColumns = [...VALID_FIELDS[table], "archived_at"].join(", ");
        const selectPredicate = namespacePredicate(auth.identity, "write", 2);
        const { rows: existingRows } = await client.query(
          `SELECT id, namespace, ${selectColumns} FROM ${table}
            WHERE id = $1${selectPredicate.clause} FOR UPDATE`,
          [args.id, ...selectPredicate.values],
        );
        if (existingRows.length === 0) {
          await client.query("ROLLBACK");
          return errorResult("Not found");
        }
        const existingRow = existingRows[0];
        if (existingRow.archived_at != null) {
          await client.query("ROLLBACK");
          return errorResult("Entry is archived -- restore it first");
        }

        const contentFieldNames = CONTENT_FIELDS[table];
        const needsReembed = contentFieldNames.some(
          (field) => providedFields[field] !== undefined,
        );
        let embedding: number[] | null = null;
        let hash: string | null = null;

        if (needsReembed) {
          const merged: Record<string, unknown> = {};
          for (const field of contentFieldNames) {
            merged[field] =
              providedFields[field] !== undefined ? providedFields[field] : existingRow[field];
          }
          hash = contentHash(buildHashInput(table, merged));
          const { rows: collisions } = await client.query(
            `SELECT id FROM ${table} WHERE content_hash = $1 AND id != $2 AND namespace = $3`,
            [hash, args.id, existingRow.namespace],
          );
          if (collisions.length > 0) {
            await client.query("ROLLBACK");
            return errorResult("Duplicate content exists in another entry");
          }
          embedding = await dependencies.embedFn(buildEmbeddableText(table, merged));
        }

        const setClauses: string[] = [];
        const params: unknown[] = [];
        for (const [field, value] of Object.entries(providedFields)) {
          // decisions.alternatives is jsonb: a raw JS array would serialize as a
          // Postgres array literal, which is not valid JSON.
          if (table === "decisions" && field === "alternatives") {
            params.push(JSON.stringify(value ?? []));
            setClauses.push(`${field} = $${params.length}::jsonb`);
          } else {
            params.push(value);
            setClauses.push(`${field} = $${params.length}`);
          }
        }
        if (needsReembed) {
          params.push(embedding ? toSql(embedding) : null);
          setClauses.push(`embedding = $${params.length}`);
          params.push(hash);
          setClauses.push(`content_hash = $${params.length}`);
          params.push(embedding ? new Date().toISOString() : null);
          setClauses.push(`embedded_at = $${params.length}`);
          params.push(embedding ? (dependencies.embeddingModel ?? null) : null);
          setClauses.push(`embedding_model = $${params.length}`);
        }
        setClauses.push("updated_at = NOW()");

        params.push(args.id);
        const idParam = params.length;
        const updatePredicate = namespacePredicate(auth.identity, "write", idParam + 1);
        const { rows: updatedRows } = await client.query(
          `UPDATE ${table} SET ${setClauses.join(", ")}
            WHERE id = $${idParam}${updatePredicate.clause} RETURNING id`,
          [...params, ...updatePredicate.values],
        );
        await client.query("COMMIT");

        if (updatedRows.length === 0) return errorResult("Update failed");
        dependencies.logger.info(
          {
            tool: "update_entry",
            table,
            id: updatedRows[0].id,
            fields: Object.keys(providedFields),
            reembedded: needsReembed,
          },
          "tool_result",
        );
        return textResult({
          id: updatedRows[0].id,
          table,
          updated: true,
          embedded: needsReembed && embedding !== null,
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  );
}
