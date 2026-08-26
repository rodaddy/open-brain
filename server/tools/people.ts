/**
 * People/contact tools over the `relationships` table.
 *
 * These are gated on the `relationships` resource rather than `sessions`: a
 * contact record is its own permission surface, and reusing the graph's gate
 * would let a session-only role read personal data.
 *
 * Both tools carry the auth-derived namespace predicate on every read and
 * write. `find_person` returns the SAME "no people found" text for a foreign
 * namespace as for a genuine miss, so a caller cannot probe for the existence
 * of a contact in a lane it cannot read.
 */
import { z } from "zod";
import { toSql } from "pgvector/pg";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead, canWrite } from "../auth/permissions.ts";
import {
  canTargetNamespace,
  namespacePredicate,
} from "../auth/namespace-policy.ts";
import type { NamespacePredicate } from "../auth/namespace-policy.ts";
import { contentHash, embeddingFields } from "./memory-helpers.ts";
import {
  authIdentity,
  errorResult,
  textResult,
  type MemoryToolDependencies,
} from "./types.ts";

/** Columns `find_person` returns, matching observed current-src. */
const PERSON_COLUMNS = `id, person_name, context, relationship_type, warmth,
  last_contact, email, phone, notes, tags, metadata, created_at`;

/**
 * `upsert_person` input, hoisted so the write's uniqueness key -- the name that
 * `ON CONFLICT` matches on -- is readable next to the SQL that relies on it.
 */
const UPSERT_PERSON_INPUT = {
  name: z.string().min(1).describe("Person's full name (used as unique key)"),
  context: z
    .string()
    .optional()
    .describe("How you know them, where they work, etc."),
  relationship_type: z
    .string()
    .optional()
    .describe(
      "Relationship category: friend, family, colleague, acquaintance, etc.",
    ),
  warmth: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe("Closeness rating 1-5 (1=distant, 5=very close)"),
  last_contact: z
    .string()
    .optional()
    .describe("Date of last contact (ISO 8601 date, e.g. 2026-03-19)"),
  email: z.string().optional().describe("Email address"),
  phone: z.string().optional().describe("Phone number"),
  notes: z.string().optional().describe("Freeform notes about the person"),
  tags: z.array(z.string()).optional().describe("Tags for categorization"),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Additional structured data (e.g. apple_id, imessage, social handles)",
    ),
  namespace: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe("Namespace to store in (defaults to caller's clientId)"),
};

/** `find_person` input, hoisted alongside the upsert schema for the same reason. */
const FIND_PERSON_INPUT = {
  query: z.string().min(1).describe("Person name or semantic search query"),
  mode: z
    .enum(["name", "semantic"])
    .optional()
    .describe(
      "Search mode: 'name' for ILIKE partial match (default), 'semantic' for embedding-based contextual search",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(250)
    .optional()
    .describe("Maximum results to return (default 5)"),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Number of results to skip for pagination (default 0)"),
};

/**
 * `INSERT ... ON CONFLICT` for a contact row.
 *
 * `tags`/`metadata` use a NULL-check rather than COALESCE on the update side so
 * that an explicitly-passed empty array or object REPLACES the stored value,
 * while omitting the field leaves it untouched. COALESCE alone cannot tell
 * those two cases apart.
 */
const UPSERT_PERSON_SQL = `INSERT INTO relationships (
           person_name, context, relationship_type, warmth, last_contact,
           email, phone, notes, tags, metadata,
           created_by, namespace, embedding, content_hash, embedded_at, embedding_model
         ) VALUES (
           $1, $2, $3, $4, $5::date,
           $6, $7, $8, COALESCE($9::text[], '{}'), COALESCE($10::jsonb, '{}'),
           $11, $12, $13, $14, $15, $16
         )
         ON CONFLICT (namespace, person_name) DO UPDATE SET
           context = COALESCE(EXCLUDED.context, relationships.context),
           relationship_type = COALESCE(EXCLUDED.relationship_type, relationships.relationship_type),
           warmth = COALESCE(EXCLUDED.warmth, relationships.warmth),
           last_contact = COALESCE(EXCLUDED.last_contact, relationships.last_contact),
           email = COALESCE(EXCLUDED.email, relationships.email),
           phone = COALESCE(EXCLUDED.phone, relationships.phone),
           notes = COALESCE(EXCLUDED.notes, relationships.notes),
           tags = CASE WHEN $9 IS NOT NULL THEN EXCLUDED.tags ELSE relationships.tags END,
           metadata = CASE WHEN $10 IS NOT NULL THEN EXCLUDED.metadata ELSE relationships.metadata END,
           embedding = EXCLUDED.embedding,
           content_hash = EXCLUDED.content_hash,
           embedded_at = EXCLUDED.embedded_at,
           embedding_model = EXCLUDED.embedding_model
         RETURNING id, (xmax = 0) AS inserted`;

/** Caller-supplied `upsert_person` arguments, as Zod hands them to the handler. */
type UpsertPersonArgs = {
  name: string;
  context?: string | undefined;
  relationship_type?: string | undefined;
  warmth?: number | undefined;
  last_contact?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  notes?: string | undefined;
  tags?: string[] | undefined;
  metadata?: Record<string, unknown> | undefined;
  namespace?: string | undefined;
};

/**
 * The text a contact is embedded from.
 *
 * Name, context, and notes only: the remaining columns are structured
 * identifiers rather than prose, and embedding them dilutes the vector.
 */
function personEmbedText(args: UpsertPersonArgs): string {
  return [args.name, args.context ?? "", args.notes ?? ""]
    .filter(Boolean)
    .join("\n");
}

/** Positional parameters for {@link UPSERT_PERSON_SQL}, in declaration order. */
function upsertPersonValues(options: {
  args: UpsertPersonArgs;
  clientId: string;
  namespace: string;
  embeddableText: string;
  embedding: Awaited<ReturnType<typeof embeddingFields>>;
}): unknown[] {
  const { args, embedding } = options;
  return [
    args.name,
    args.context ?? null,
    args.relationship_type ?? null,
    args.warmth ?? null,
    args.last_contact ?? null,
    args.email ?? null,
    args.phone ?? null,
    args.notes ?? null,
    args.tags ?? null,
    args.metadata ? JSON.stringify(args.metadata) : null,
    options.clientId,
    options.namespace,
    embedding.embedding,
    contentHash(options.embeddableText),
    embedding.embeddedAt,
    embedding.model,
  ];
}

/** Rows `find_person` reads, in either search mode. */
type PersonRow = Record<string, unknown>;

/** Semantic mode: nearest contacts by embedding distance. */
async function findPeopleSemantic(options: {
  dependencies: MemoryToolDependencies;
  query: string;
  rowCount: number;
  offset: number;
  predicate: NamespacePredicate;
}): Promise<PersonRow[] | null> {
  const { dependencies, predicate } = options;
  const embedding = await dependencies.embedFn(options.query);
  if (!embedding) return null;
  const result = await dependencies.pool.query(
    `SELECT ${PERSON_COLUMNS},
                  embedding <=> $1::halfvec(768) AS distance
             FROM relationships
            WHERE embedding IS NOT NULL AND archived_at IS NULL${predicate.clause}
            ORDER BY distance ASC
            LIMIT $2 OFFSET $3`,
    [toSql(embedding), options.rowCount, options.offset, ...predicate.values],
  );
  return result.rows;
}

/** Name mode: ILIKE partial match, warmest and most recently contacted first. */
async function findPeopleByName(options: {
  dependencies: MemoryToolDependencies;
  query: string;
  rowCount: number;
  offset: number;
  predicate: NamespacePredicate;
}): Promise<PersonRow[]> {
  const { predicate } = options;
  // `%` and `_` are ILIKE wildcards, so a caller searching for a literal
  // one must not have it treated as a pattern.
  const escaped = options.query.replaceAll("%", "\\%").replaceAll("_", "\\_");
  const result = await options.dependencies.pool.query(
    `SELECT ${PERSON_COLUMNS}
             FROM relationships
            WHERE person_name ILIKE $1 AND archived_at IS NULL${predicate.clause}
            ORDER BY warmth DESC NULLS LAST, last_contact DESC NULLS LAST
            LIMIT $2 OFFSET $3`,
    [`%${escaped}%`, options.rowCount, options.offset, ...predicate.values],
  );
  return result.rows;
}

export function registerPeopleTools(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  registerUpsertPerson(server, dependencies);
  registerFindPerson(server, dependencies);
}

function registerUpsertPerson(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "upsert_person",
    {
      description:
        "Create or update a person/contact in the brain. Matches on person_name (case-sensitive). If the person exists, updates provided fields; if not, creates a new record. A case-insensitive unique index is recommended.",
      inputSchema: UPSERT_PERSON_INPUT,
      annotations: {
        title: "Upsert Person",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      if (!identity || !canWrite(identity.role, "relationships")) {
        return errorResult("Permission denied: cannot write to relationships");
      }
      const namespace = args.namespace ?? identity.clientId;
      if (!canTargetNamespace(identity, "write", namespace)) {
        return errorResult("Permission denied: namespace write denied");
      }

      const embeddableText = personEmbedText(args);
      const embedding = await embeddingFields(dependencies, embeddableText);

      const { rows } = await dependencies.pool.query(
        UPSERT_PERSON_SQL,
        upsertPersonValues({
          args,
          clientId: identity.clientId,
          namespace,
          embeddableText,
          embedding,
        }),
      );

      const row = rows[0];
      const action = row.inserted ? "created" : "updated";
      dependencies.logger.info(
        { tool: "upsert_person", id: row.id, action },
        "tool_result",
      );
      return textResult({
        id: row.id,
        person_name: args.name,
        namespace,
        action,
        embedded: embedding.embedded,
      });
    },
  );
}

function registerFindPerson(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "find_person",
    {
      description:
        "Find a person in the brain by name (ILIKE partial match) or semantic search (embedding distance)",
      inputSchema: FIND_PERSON_INPUT,
      annotations: {
        title: "Find Person",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      if (!identity || !canRead(identity.role, "relationships")) {
        return errorResult("Permission denied: cannot read relationships");
      }

      const request = {
        dependencies,
        query: args.query,
        rowCount: args.limit ?? 5,
        offset: args.offset ?? 0,
        predicate: namespacePredicate(identity, "read", 4),
      };

      const rows =
        args.mode === "semantic"
          ? await findPeopleSemantic(request)
          : await findPeopleByName(request);
      if (rows === null)
        return errorResult("Failed to generate query embedding");

      dependencies.logger.info(
        {
          tool: "find_person",
          mode: args.mode ?? "name",
          returned: rows.length,
        },
        "tool_result",
      );
      // Not an error, and deliberately the same text a foreign-namespace hit
      // produces, so absence and inaccessibility are indistinguishable.
      if (rows.length === 0)
        return textResult(`No people found matching: ${args.query}`);
      return textResult(rows);
    },
  );
}
