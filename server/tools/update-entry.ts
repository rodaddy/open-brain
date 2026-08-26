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
import type { PoolClient } from "pg";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toSql } from "pgvector/pg";
import { namespacePredicate } from "../auth/namespace-policy.ts";
import type { AuthIdentity, ResourceTable } from "../auth/types.ts";
import {
  authIdentity,
  errorResult,
  textResult,
  type MemoryToolDependencies,
} from "./types.ts";
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

/** Frozen `update_entry` argument contract: the field names are the API. */
const updateEntryInputSchema = {
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
};

/** Tool annotations; `update_entry` mutates an existing row in place. */
const updateEntryAnnotations = {
  title: "Update Entry",
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
};

const UPDATE_ENTRY_DESCRIPTION =
  "Update a brain entry's mutable fields. Re-embeds content when semantic fields change.";

/** Build the embeddable text for a merged post-update row. */
function buildEmbeddableText(
  table: ResourceTable,
  merged: Record<string, unknown>,
): string {
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
function buildHashInput(
  table: ResourceTable,
  merged: Record<string, unknown>,
): string {
  if (table === "sessions") return sessionSourceHashInput(merged);
  return buildEmbeddableText(table, merged);
}

/** Narrow the validated args to the mutable fields this table actually accepts. */
function collectProvidedFields(
  table: ResourceTable,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const providedFields: Record<string, unknown> = {};
  for (const field of VALID_FIELDS[table]) {
    if (args[field] !== undefined) providedFields[field] = args[field];
  }
  return providedFields;
}

/** The locked pre-update row, or the error envelope that ended the transaction. */
type LockedRow =
  | { ok: true; row: Record<string, unknown> }
  | { ok: false; response: ReturnType<typeof errorResult> };

/**
 * Lock the target row under the caller's write namespace predicate.
 *
 * The `FOR UPDATE` lock is what makes the archived guard below meaningful: it
 * holds the row against a concurrent archive between this SELECT and the UPDATE.
 */
async function lockExistingRow(
  client: PoolClient,
  identity: AuthIdentity,
  request: { table: ResourceTable; id: string },
): Promise<LockedRow> {
  const { table, id } = request;
  const selectColumns = [...VALID_FIELDS[table], "archived_at"].join(", ");
  const selectPredicate = namespacePredicate(identity, "write", 2);
  const { rows: existingRows } = await client.query(
    `SELECT id, namespace, ${selectColumns} FROM ${table}
            WHERE id = $1${selectPredicate.clause} FOR UPDATE`,
    [id, ...selectPredicate.values],
  );
  if (existingRows.length === 0) {
    await client.query("ROLLBACK");
    return { ok: false, response: errorResult("Not found") };
  }
  const existingRow = existingRows[0];
  if (existingRow.archived_at != null) {
    await client.query("ROLLBACK");
    return {
      ok: false,
      response: errorResult("Entry is archived -- restore it first"),
    };
  }
  return { ok: true, row: existingRow };
}

/** Merge the provided semantic fields over the locked row's stored values. */
function mergeContentFields(
  table: ResourceTable,
  providedFields: Record<string, unknown>,
  existingRow: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const field of CONTENT_FIELDS[table]) {
    merged[field] =
      providedFields[field] !== undefined
        ? providedFields[field]
        : existingRow[field];
  }
  return merged;
}

/** A computed re-embedding, or the error envelope that ended the transaction. */
type Reembedding =
  | { ok: true; embedding: number[] | null; hash: string | null }
  | { ok: false; response: ReturnType<typeof errorResult> };

/**
 * Recompute the content hash and embedding for a semantic change.
 *
 * The collision check runs inside the same transaction as the caller's row
 * lock, so an identical concurrent write cannot land between the check and the
 * UPDATE and leave two rows sharing a content hash in one namespace.
 */
async function computeReembedding(
  client: PoolClient,
  dependencies: MemoryToolDependencies,
  request: {
    table: ResourceTable;
    id: string;
    providedFields: Record<string, unknown>;
    existingRow: Record<string, unknown>;
  },
): Promise<Reembedding> {
  const { table, id, providedFields, existingRow } = request;
  const merged = mergeContentFields(table, providedFields, existingRow);
  const hash = contentHash(buildHashInput(table, merged));
  const { rows: collisions } = await client.query(
    `SELECT id FROM ${table} WHERE content_hash = $1 AND id != $2 AND namespace = $3`,
    [hash, id, existingRow.namespace],
  );
  if (collisions.length > 0) {
    await client.query("ROLLBACK");
    return {
      ok: false,
      response: errorResult("Duplicate content exists in another entry"),
    };
  }
  const embedding = await dependencies.embedFn(
    buildEmbeddableText(table, merged),
  );
  return { ok: true, embedding, hash };
}

/** A dynamic `SET` list and its positional parameters, in matching order. */
interface UpdateAssignments {
  setClauses: string[];
  params: unknown[];
}

/** Append the caller's mutable field assignments, jsonb-encoding where needed. */
function appendFieldAssignments(
  assignments: UpdateAssignments,
  table: ResourceTable,
  providedFields: Record<string, unknown>,
): void {
  const { setClauses, params } = assignments;
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
}

/** Append the four embedding columns, all null when the embed call returned null. */
function appendEmbeddingAssignments(
  assignments: UpdateAssignments,
  dependencies: MemoryToolDependencies,
  computed: { embedding: number[] | null; hash: string | null },
): void {
  const { setClauses, params } = assignments;
  const { embedding, hash } = computed;
  params.push(embedding ? toSql(embedding) : null);
  setClauses.push(`embedding = $${params.length}`);
  params.push(hash);
  setClauses.push(`content_hash = $${params.length}`);
  params.push(embedding ? new Date().toISOString() : null);
  setClauses.push(`embedded_at = $${params.length}`);
  params.push(embedding ? (dependencies.embeddingModel ?? null) : null);
  setClauses.push(`embedding_model = $${params.length}`);
}

/** Build the whole `SET` list for this update, embedding columns included. */
function buildAssignments(
  dependencies: MemoryToolDependencies,
  request: {
    table: ResourceTable;
    providedFields: Record<string, unknown>;
    reembedding: { embedding: number[] | null; hash: string | null } | null;
  },
): UpdateAssignments {
  const assignments: UpdateAssignments = { setClauses: [], params: [] };
  appendFieldAssignments(assignments, request.table, request.providedFields);
  if (request.reembedding !== null) {
    appendEmbeddingAssignments(assignments, dependencies, request.reembedding);
  }
  assignments.setClauses.push("updated_at = NOW()");
  return assignments;
}

/** Run the UPDATE under the caller's write predicate and commit. Returns the new id. */
async function applyUpdate(
  client: PoolClient,
  identity: AuthIdentity,
  request: { table: ResourceTable; id: string; assignments: UpdateAssignments },
): Promise<string | null> {
  const { table, id, assignments } = request;
  const params = [...assignments.params, id];
  const idParam = params.length;
  const updatePredicate = namespacePredicate(identity, "write", idParam + 1);
  const { rows: updatedRows } = await client.query(
    `UPDATE ${table} SET ${assignments.setClauses.join(", ")}
            WHERE id = $${idParam}${updatePredicate.clause} RETURNING id`,
    [...params, ...updatePredicate.values],
  );
  await client.query("COMMIT");
  if (updatedRows.length === 0) return null;
  return updatedRows[0].id as string;
}

/** The tool result envelope every branch of the handler returns. */
type ToolResponse =
  ReturnType<typeof textResult> | ReturnType<typeof errorResult>;

/**
 * Run one authorized update inside the caller's open transaction.
 *
 * Every early return rolls back before answering, so a denied guard never
 * leaves the row locked for the rest of the pool's lifetime.
 */
async function runUpdate(
  client: PoolClient,
  dependencies: MemoryToolDependencies,
  request: {
    identity: AuthIdentity;
    table: ResourceTable;
    id: string;
    providedFields: Record<string, unknown>;
  },
): Promise<ToolResponse> {
  const { identity, table, id, providedFields } = request;
  const locked = await lockExistingRow(client, identity, { table, id });
  if (!locked.ok) return locked.response;

  const needsReembed = CONTENT_FIELDS[table].some(
    (field) => providedFields[field] !== undefined,
  );
  let reembedding: { embedding: number[] | null; hash: string | null } | null =
    null;
  if (needsReembed) {
    const computed = await computeReembedding(client, dependencies, {
      table,
      id,
      providedFields,
      existingRow: locked.row,
    });
    if (!computed.ok) return computed.response;
    reembedding = { embedding: computed.embedding, hash: computed.hash };
  }

  const assignments = buildAssignments(dependencies, {
    table,
    providedFields,
    reembedding,
  });
  const updatedId = await applyUpdate(client, identity, {
    table,
    id,
    assignments,
  });
  if (updatedId === null) return errorResult("Update failed");

  dependencies.logger.info(
    {
      tool: "update_entry",
      table,
      id: updatedId,
      fields: Object.keys(providedFields),
      reembedded: needsReembed,
    },
    "tool_result",
  );
  return textResult({
    id: updatedId,
    table,
    updated: true,
    embedded: needsReembed && reembedding?.embedding != null,
  });
}

export function registerUpdateEntryTool(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "update_entry",
    {
      description: UPDATE_ENTRY_DESCRIPTION,
      inputSchema: updateEntryInputSchema,
      annotations: updateEntryAnnotations,
    },
    async (args, extra) => {
      const auth = authorize(authIdentity(extra.authInfo), {
        operation: "write",
        table: args.table,
        permissionMessage: `cannot write to ${args.table}`,
      });
      if (!auth.ok) return auth.response;
      const table = args.table;

      const providedFields = collectProvidedFields(
        table,
        args as Record<string, unknown>,
      );
      if (Object.keys(providedFields).length === 0) {
        return errorResult(`No valid fields to update for table ${table}`);
      }

      const client = await dependencies.pool.connect();
      try {
        await client.query("BEGIN");
        return await runUpdate(client, dependencies, {
          identity: auth.identity,
          table,
          id: args.id,
          providedFields,
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
