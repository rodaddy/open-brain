import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { authIdentity, textResult, type MemoryToolDependencies } from "./types.ts";
import { authorize, contentHash, decisionText, embeddingFields } from "./memory-helpers.ts";
import { writeThoughtChunks, chunkReceiptFields } from "../../src/chunk-write.ts";

const sourceRefsSchema = z.array(z.record(z.string(), z.unknown())).max(20);

export function registerCaptureTools(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "log_thought",
    {
      description: "Log a thought, idea, or observation to the brain",
      inputSchema: {
        content: z.string().min(1),
        tags: z.array(z.string()).optional(),
        namespace: z.string().min(1).max(500).optional(),
        source_refs: sourceRefsSchema.optional(),
      },
      annotations: {
        title: "Log Thought",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args, extra) => {
      const auth = authorize(
        authIdentity(extra.authInfo),
        "write",
        "thoughts",
        "cannot write to thoughts",
        args.namespace,
      );
      if (!auth.ok) return auth.response;
      return writeThought(dependencies, auth.identity.clientId, auth.namespace, args);
    },
  );

  server.registerTool(
    "log_decision",
    {
      description: "Record a decision with rationale and alternatives considered",
      inputSchema: {
        title: z.string().min(1),
        rationale: z.string().min(1),
        alternatives: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        context: z.string().optional(),
        namespace: z.string().min(1).max(500).optional(),
        source_refs: sourceRefsSchema.optional(),
      },
      annotations: {
        title: "Log Decision",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args, extra) => {
      const auth = authorize(
        authIdentity(extra.authInfo),
        "write",
        "decisions",
        "cannot write to decisions",
        args.namespace,
      );
      if (!auth.ok) return auth.response;
      return writeDecision(dependencies, auth.identity.clientId, auth.namespace, args);
    },
  );
}

async function writeThought(
  dependencies: MemoryToolDependencies,
  createdBy: string,
  namespace: string,
  args: {
    content: string;
    tags?: string[];
    source_refs?: Array<Record<string, unknown>>;
  },
) {
  const embedded = await embeddingFields(
    dependencies,
    args.tags?.length ? `${args.content}\n${args.tags.join(" ")}` : args.content,
  );
  const rows = await dependencies.pool.query(
    `INSERT INTO thoughts
       (content, tags, source, created_by, namespace, embedding, content_hash,
        embedded_at, embedding_model, source_refs)
     VALUES ($1, $2, 'mcp', $3, $4, $5, $6, $7, $8, $9::jsonb)
     ON CONFLICT (content_hash, namespace) WHERE content_hash IS NOT NULL
     DO UPDATE SET tags = EXCLUDED.tags, updated_at = NOW()
     RETURNING id, (xmax = 0) AS is_new, source_refs`,
    [
      args.content,
      args.tags ?? [],
      createdBy,
      namespace,
      embedded.embedding,
      contentHash(args.content),
      embedded.embeddedAt,
      embedded.model,
      JSON.stringify(args.source_refs ?? []),
    ],
  );
  const row = rows.rows[0];

  // CHUNK ROWS FOR A LONG ENTRY (#605). The parent above holds the full text
  // and its own whole-text vector; these add per-section resolution. This tree
  // previously reported a hardcoded chunks_written: 0 while writing no chunks
  // at all, which read as "short entry" for entries of any length.
  const chunks = await writeThoughtChunks(dependencies.pool, {
    parentId: row.id as string,
    namespace,
    createdBy,
    content: args.content,
    tags: args.tags ?? [],
    embedFn: dependencies.embedFn,
    source: "mcp-chunk",
    isNew: row.is_new as boolean,
    caller: "server/log_thought",
  });

  dependencies.logger.info({ tool: "log_thought", embedded: embedded.embedded }, "tool_result");
  return textResult({
    id: row.id,
    namespace,
    embedded: embedded.embedded,
    merged: !row.is_new,
    source_refs: row.source_refs,
    ...chunkReceiptFields(chunks),
  });
}

async function writeDecision(
  dependencies: MemoryToolDependencies,
  createdBy: string,
  namespace: string,
  args: {
    title: string;
    rationale: string;
    alternatives?: string[];
    tags?: string[];
    context?: string;
    source_refs?: Array<Record<string, unknown>>;
  },
) {
  const canonical = decisionText(args);
  const embedded = await embeddingFields(dependencies, canonical);
  const rows = await dependencies.pool.query(
    `INSERT INTO decisions
       (title, rationale, alternatives, tags, context, created_by, namespace,
        embedding, content_hash, embedded_at, embedding_model, source_refs)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
     ON CONFLICT (content_hash, namespace) WHERE content_hash IS NOT NULL
     DO UPDATE SET tags = EXCLUDED.tags, updated_at = NOW()
     RETURNING id, (xmax = 0) AS is_new, source_refs`,
    [
      args.title,
      args.rationale,
      JSON.stringify(args.alternatives ?? []),
      args.tags ?? [],
      args.context ?? null,
      createdBy,
      namespace,
      embedded.embedding,
      contentHash(canonical),
      embedded.embeddedAt,
      embedded.model,
      JSON.stringify(args.source_refs ?? []),
    ],
  );
  const row = rows.rows[0];
  dependencies.logger.info({ tool: "log_decision", embedded: embedded.embedded }, "tool_result");
  return textResult({
    id: row.id,
    namespace,
    embedded: embedded.embedded,
    merged: !row.is_new,
    source_refs: row.source_refs,
  });
}
