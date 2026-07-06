import { z } from "zod";
import { toSql } from "pgvector/pg";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { contentHash, EMBEDDING_MODEL } from "../embedding.ts";
import { canRead, canWrite } from "../permissions.ts";
import { canWriteNamespace } from "../namespace-policy.ts";
import { appendReadNamespacePredicate } from "../read-policy.ts";
import { canonicalNamespace } from "../shared-namespace.ts";
import type { AuthInfo, Table } from "../types.ts";
import {
  DEFAULT_DECOMPOSITION_MAX_CHARS,
  DEFAULT_DECOMPOSITION_OVERLAP_CHARS,
  planEntryDecomposition,
  type DecompositionPlan,
  type ReplacementProposal,
} from "../decomposition.ts";
import type { ToolDeps } from "./index.ts";

const SOURCE_CONTENT_SQL: Record<Table, string> = {
  thoughts: "COALESCE(content, '')",
  decisions:
    "COALESCE(title, '') || CASE WHEN rationale IS NOT NULL AND rationale <> '' THEN E'\\n' || rationale ELSE '' END" +
    " || CASE WHEN jsonb_typeof(alternatives) = 'array' AND jsonb_array_length(alternatives) > 0 THEN E'\\nAlternatives: ' || (SELECT string_agg(value, '; ') FROM jsonb_array_elements_text(alternatives) AS alternative(value)) ELSE '' END" +
    " || CASE WHEN context IS NOT NULL AND context <> '' THEN E'\\nContext: ' || context ELSE '' END",
  relationships:
    "COALESCE(person_name, '') || CASE WHEN context IS NOT NULL AND context <> '' THEN E'\\n' || context ELSE '' END",
  projects:
    "COALESCE(name, '') || CASE WHEN status IS NOT NULL AND status <> '' THEN E'\\nStatus: ' || status ELSE '' END" +
    " || CASE WHEN description IS NOT NULL AND description <> '' THEN E'\\n' || description ELSE '' END",
  sessions:
    "COALESCE(project || ': ', '') || COALESCE(summary, '')" +
    " || CASE WHEN key_decisions IS NOT NULL AND array_length(key_decisions, 1) > 0 THEN E'\\nDecisions: ' || immutable_array_to_string(key_decisions, '; ') ELSE '' END" +
    " || CASE WHEN next_steps IS NOT NULL AND array_length(next_steps, 1) > 0 THEN E'\\nNext: ' || immutable_array_to_string(next_steps, '; ') ELSE '' END" +
    " || CASE WHEN blockers IS NOT NULL AND array_length(blockers, 1) > 0 THEN E'\\nBlockers: ' || immutable_array_to_string(blockers, '; ') ELSE '' END",
};

export function registerDecomposeEntry(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "decompose_entry",
    {
      description:
        "Plan dry-run-first decomposition of an oversized entry into smaller linked thoughts. " +
        "No writes occur unless dry_run=false and apply_mode=write_replacements.",
      inputSchema: {
        table: z.enum(["thoughts", "decisions", "relationships", "projects", "sessions"]),
        id: z.string().uuid(),
        max_chunk_chars: z
          .number()
          .int()
          .min(500)
          .max(8000)
          .optional()
          .describe("Maximum proposed replacement size in characters"),
        overlap_chars: z
          .number()
          .int()
          .min(0)
          .max(1000)
          .optional()
          .describe("Character overlap between proposed replacements"),
        dry_run: z
          .boolean()
          .optional()
          .describe("Defaults true. false requires apply_mode=write_replacements."),
        apply_mode: z
          .enum(["write_replacements"])
          .optional()
          .describe("Required with dry_run=false to write replacement thoughts"),
      },
      annotations: {
        title: "Decompose Entry",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      const table = args.table as Table;
      if (!auth || !canRead(auth.role, table)) {
        return {
          content: [{ type: "text" as const, text: `Permission denied: cannot read ${table}` }],
          isError: true,
        };
      }
      if (args.dry_run === false && args.apply_mode !== "write_replacements") {
        return {
          content: [
            {
              type: "text" as const,
              text: "dry_run=false requires apply_mode=write_replacements",
            },
          ],
          isError: true,
        };
      }
      const maxChunkChars = args.max_chunk_chars ?? DEFAULT_DECOMPOSITION_MAX_CHARS;
      const overlapChars = args.overlap_chars ?? DEFAULT_DECOMPOSITION_OVERLAP_CHARS;
      if (overlapChars >= maxChunkChars) {
        return {
          content: [
            {
              type: "text" as const,
              text: "overlap_chars must be less than max_chunk_chars",
            },
          ],
          isError: true,
        };
      }

      const row = await fetchSourceEntry(deps, auth, table, args.id);
      if (!row) {
        return {
          content: [{ type: "text" as const, text: "Entry not found or archived" }],
          isError: true,
        };
      }

      const namespace = String(row.namespace);
      const plan = planEntryDecomposition({
        table,
        id: String(row.id),
        namespace: canonicalNamespace(namespace),
        content: String(row.content_text ?? ""),
        maxChunkChars,
        overlapChars,
      });

      if (args.dry_run === false) {
        const applyCheck = canApplyReplacements(auth, namespace);
        if (!applyCheck.allowed) {
          return {
            content: [{ type: "text" as const, text: `Permission denied: ${applyCheck.reason}` }],
            isError: true,
          };
        }
        if (plan.proposed_replacements.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ...plan,
                  dry_run: false,
                  written_ids: [],
                  skipped_duplicates: [],
                  intra_batch_duplicates: [],
                  fully_written: true,
                  apply_summary: {
                    requested_writes: 0,
                    written_count: 0,
                    preexisting_duplicate_count: 0,
                    intra_batch_duplicate_count: 0,
                    fully_written: true,
                    source_row_mutation: "unchanged",
                  },
                }),
              },
            ],
          };
        }
        const applied = await writeReplacementThoughts(deps, auth, namespace, plan);
        const applySummary = buildApplySummary(plan, applied);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ...plan,
                status: "applied",
                dry_run: false,
                written_ids: applied.writtenIds,
                skipped_duplicates: applied.skippedDuplicates,
                intra_batch_duplicates: applied.intraBatchDuplicates,
                fully_written: applySummary.fully_written,
                apply_summary: applySummary,
              }),
            },
          ],
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(plan) }],
      };
    },
  );
}

async function fetchSourceEntry(
  deps: ToolDeps,
  auth: AuthInfo,
  table: Table,
  id: string,
): Promise<Record<string, unknown> | null> {
  const params: unknown[] = [id];
  const namespacePredicate = appendReadNamespacePredicate(auth, params);
  const { rows } = await deps.pool.query(
    `SELECT id, namespace, ${SOURCE_CONTENT_SQL[table]} AS content_text
       FROM ${table}
      WHERE id = $1 AND archived_at IS NULL${namespacePredicate}`,
    params,
  );
  return (rows[0] as Record<string, unknown> | undefined) ?? null;
}

function canApplyReplacements(
  auth: AuthInfo,
  namespace: string,
): { allowed: true } | { allowed: false; reason: string } {
  if (!canWrite(auth.role, "thoughts")) {
    return { allowed: false, reason: "cannot write replacement thoughts" };
  }
  const namespaceCheck = canWriteNamespace(auth, namespace);
  if (!namespaceCheck.allowed) {
    return { allowed: false, reason: namespaceCheck.reason ?? "namespace rejected" };
  }
  return { allowed: true };
}

interface ReplacementWriteResult {
  writtenIds: string[];
  skippedDuplicates: string[];
  intraBatchDuplicates: string[];
}

async function writeReplacementThoughts(
  deps: ToolDeps,
  auth: AuthInfo,
  namespace: string,
  plan: DecompositionPlan,
): Promise<ReplacementWriteResult> {
  const client = await deps.pool.connect();
  const writtenIds: string[] = [];
  const skippedDuplicates: string[] = [];
  const intraBatchDuplicates: string[] = [];
  const writtenIdsByHash = new Map<string, string>();
  try {
    await client.query("BEGIN");
    for (const proposal of plan.proposed_replacements) {
      const hash = contentHash(proposal.content);
      const alreadyWrittenId = writtenIdsByHash.get(hash);
      if (alreadyWrittenId) {
        intraBatchDuplicates.push(alreadyWrittenId);
        continue;
      }
      const embedding = await deps.embedFn(proposal.content);
      const { rows } = await client.query(
        `INSERT INTO thoughts
           (content, tags, source, created_by, namespace, embedding, content_hash,
            embedded_at, embedding_model, promoted_from, parent_id, chunk_index)
         VALUES ($1, $2, 'dreamengine-decomposition', $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (content_hash, namespace) WHERE content_hash IS NOT NULL DO NOTHING
         RETURNING id`,
        [
          proposal.content,
          replacementTags(proposal),
          auth.clientId,
          namespace,
          embedding ? toSql(embedding) : null,
          hash,
          embedding ? new Date().toISOString() : null,
          embedding ? EMBEDDING_MODEL : null,
          JSON.stringify(proposal.provenance),
          null,
          proposal.chunk_index,
        ],
      );
      const insertedId = rows[0]?.id;
      if (typeof insertedId === "string") {
        writtenIds.push(insertedId);
        writtenIdsByHash.set(hash, insertedId);
        continue;
      }
      const existing = await client.query(
        `SELECT id FROM thoughts WHERE content_hash = $1 AND namespace = $2 AND archived_at IS NULL`,
        [hash, namespace],
      );
      const existingId = existing.rows[0]?.id;
      if (typeof existingId === "string") {
        skippedDuplicates.push(existingId);
      }
    }
    await client.query("COMMIT");
    return { writtenIds, skippedDuplicates, intraBatchDuplicates };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function buildApplySummary(plan: DecompositionPlan, applied: ReplacementWriteResult): {
  requested_writes: number;
  written_count: number;
  preexisting_duplicate_count: number;
  intra_batch_duplicate_count: number;
  fully_written: boolean;
  source_row_mutation: "unchanged";
} {
  return {
    requested_writes: plan.would_write,
    written_count: applied.writtenIds.length,
    preexisting_duplicate_count: applied.skippedDuplicates.length,
    intra_batch_duplicate_count: applied.intraBatchDuplicates.length,
    fully_written:
      applied.writtenIds.length +
        applied.skippedDuplicates.length +
        applied.intraBatchDuplicates.length ===
      plan.would_write,
    source_row_mutation: "unchanged",
  };
}

function replacementTags(proposal: ReplacementProposal): string[] {
  return [
    "dreamengine-decomposition",
    `source:${proposal.source_ref.table}`,
    `source-id:${proposal.source_ref.id}`,
  ];
}
