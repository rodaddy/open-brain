/**
 * Dry-run-first decomposition of an oversized entry into linked replacements.
 *
 * Design authority: `docs/dream-design.md` (DreamEngine plans, it does not
 * mutate) and `docs/decisions/cognitive-tiering-dream-cycle.md`.
 *
 * THE DRY-RUN DEFAULT IS THE CONTRACT. Planning is delegated to
 * `planEntryDecomposition`, which is a pure function with no pool and no auth
 * imports, so the planning path *cannot* write even if a future edit forgot to
 * check the flag. Writing requires BOTH `dry_run: false` AND an explicit
 * `apply_mode: "write_replacements"`; either alone reports.
 *
 * The response literals here are frozen observed wire values reproduced for
 * parity -- `content_length_basis: "trimmed_chunk_text"` and the
 * `apply_summary` shape are what current-src emits, and renaming either would
 * break the clients this port exists to keep working.
 */
import { z } from "zod";
import { toSql } from "pgvector/pg";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PoolClient } from "pg";
import { canRead, canWrite } from "../auth/permissions.ts";
import {
  canTargetNamespace,
  namespacePredicate,
} from "../auth/namespace-policy.ts";
import type { AuthIdentity, ResourceTable } from "../auth/types.ts";
import {
  DEFAULT_DECOMPOSITION_MAX_CHARS,
  DEFAULT_DECOMPOSITION_OVERLAP_CHARS,
  planEntryDecomposition,
  type DecompositionPlan,
  type ReplacementProposal,
} from "../../src/decomposition.ts";
import { contentHash } from "./memory-helpers.ts";
import {
  authIdentity,
  errorResult,
  textResult,
  type MemoryToolDependencies,
} from "./types.ts";
import { tableEnum } from "./curation-helpers.ts";

/**
 * Per-table expression assembling the text a decomposition reads.
 *
 * Frozen observed current-src SQL (`src/tools/decompose-entry.ts`). Static
 * fragments only -- never caller input -- and the table they are keyed by is
 * narrowed by `tableEnum` before it reaches an interpolated position.
 */
const SOURCE_CONTENT_SQL: Readonly<Record<ResourceTable, string>> = {
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

interface ReplacementWriteResult {
  readonly writtenIds: string[];
  readonly skippedDuplicates: string[];
  readonly intraBatchDuplicates: string[];
}

export function registerDecomposeEntryTool(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "decompose_entry",
    {
      description:
        "Plan dry-run-first decomposition of an oversized entry into smaller linked thoughts. " +
        "No writes occur unless dry_run=false and apply_mode=write_replacements.",
      inputSchema: {
        table: tableEnum,
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
      const identity = authIdentity(extra.authInfo);
      if (!identity || !canRead(identity.role, args.table)) {
        return errorResult(`Permission denied: cannot read ${args.table}`);
      }

      // Checked BEFORE any work: an apply request that is missing its explicit
      // mode is refused outright rather than quietly downgraded to a plan.
      const applying = args.dry_run === false;
      if (applying && args.apply_mode !== "write_replacements") {
        return errorResult("dry_run=false requires apply_mode=write_replacements");
      }

      const maxChunkChars = args.max_chunk_chars ?? DEFAULT_DECOMPOSITION_MAX_CHARS;
      const overlapChars = args.overlap_chars ?? DEFAULT_DECOMPOSITION_OVERLAP_CHARS;
      if (overlapChars >= maxChunkChars) {
        return errorResult("overlap_chars must be less than max_chunk_chars");
      }

      const predicate = namespacePredicate(identity, "read", 2);
      const { rows } = await dependencies.pool.query(
        `SELECT id, namespace, ${SOURCE_CONTENT_SQL[args.table]} AS content_text
           FROM ${args.table}
          WHERE id = $1 AND archived_at IS NULL${predicate.clause}`,
        [args.id, ...predicate.values],
      );
      const row = rows[0];
      if (!row) return errorResult("Entry not found or archived");

      const namespace = String(row.namespace);
      const plan = planEntryDecomposition({
        table: args.table,
        id: String(row.id),
        namespace,
        content: String(row.content_text ?? ""),
        maxChunkChars,
        overlapChars,
      });

      if (!applying) return textResult(plan);

      const denial = applyDenialReason(identity, namespace);
      if (denial) return errorResult(`Permission denied: ${denial}`);

      // Nothing to write is still a successful apply, reported with a zeroed
      // summary so a caller can distinguish it from a refusal.
      if (plan.proposed_replacements.length === 0) {
        return textResult({
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
        });
      }

      const applied = await writeReplacementThoughts(
        dependencies,
        identity,
        namespace,
        plan,
      );
      dependencies.logger.info(
        { tool: "decompose_entry", written: applied.writtenIds.length },
        "tool_result",
      );
      return textResult({
        ...plan,
        status: "applied",
        dry_run: false,
        written_ids: applied.writtenIds,
        skipped_duplicates: applied.skippedDuplicates,
        intra_batch_duplicates: applied.intraBatchDuplicates,
        fully_written: buildApplySummary(plan, applied).fully_written,
        apply_summary: buildApplySummary(plan, applied),
      });
    },
  );
}

/** @returns A denial reason, or `undefined` when the apply may proceed. */
function applyDenialReason(
  identity: AuthIdentity,
  namespace: string,
): string | undefined {
  if (!canWrite(identity.role, "thoughts")) {
    return "cannot write replacement thoughts";
  }
  if (!canTargetNamespace(identity, "write", namespace)) {
    return "namespace rejected";
  }
  return undefined;
}

/**
 * Insert the planned replacements in one transaction.
 *
 * Duplicates are reported, not errors: a hash already present in the namespace
 * is recorded as pre-existing, and a repeat within this same batch is recorded
 * separately, so a partial apply is always explainable from the summary.
 */
async function writeReplacementThoughts(
  dependencies: MemoryToolDependencies,
  identity: AuthIdentity,
  namespace: string,
  plan: DecompositionPlan,
): Promise<ReplacementWriteResult> {
  const client = await dependencies.pool.connect();
  const writtenIds: string[] = [];
  const skippedDuplicates: string[] = [];
  const intraBatchDuplicates: string[] = [];
  const writtenIdsByHash = new Map<string, string>();
  try {
    await client.query("BEGIN");
    for (const proposal of plan.proposed_replacements) {
      const hash = contentHash(proposal.content);
      const alreadyWritten = writtenIdsByHash.get(hash);
      if (alreadyWritten) {
        intraBatchDuplicates.push(alreadyWritten);
        continue;
      }
      const insertedId = await insertReplacement(
        client,
        dependencies,
        identity,
        namespace,
        plan,
        proposal,
        hash,
      );
      if (insertedId) {
        writtenIds.push(insertedId);
        writtenIdsByHash.set(hash, insertedId);
        continue;
      }
      const existing = await client.query(
        `SELECT id FROM thoughts
          WHERE content_hash = $1 AND namespace = $2 AND archived_at IS NULL`,
        [hash, namespace],
      );
      const existingId = existing.rows[0]?.id;
      if (typeof existingId === "string") skippedDuplicates.push(existingId);
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

/** @returns The new row id, or `undefined` when the hash already existed. */
async function insertReplacement(
  client: PoolClient,
  dependencies: MemoryToolDependencies,
  identity: AuthIdentity,
  namespace: string,
  plan: DecompositionPlan,
  proposal: ReplacementProposal,
  hash: string,
): Promise<string | undefined> {
  const embedding = await dependencies.embedFn(proposal.content);
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
      identity.clientId,
      namespace,
      embedding ? toSql(embedding) : null,
      hash,
      embedding ? new Date().toISOString() : null,
      embedding ? (dependencies.embeddingModel ?? null) : null,
      JSON.stringify(proposal.provenance),
      // ONLY for a `thoughts` source: the FK targets `thoughts(id)`
      // (`011_chunking.sql`), so a decision's id here would violate it. For the
      // other four tables the JSON provenance above stays the only lineage.
      plan.source_ref.table === "thoughts" ? plan.source_ref.id : null,
      proposal.chunk_index,
    ],
  );
  const insertedId = rows[0]?.id;
  return typeof insertedId === "string" ? insertedId : undefined;
}

function buildApplySummary(
  plan: DecompositionPlan,
  applied: ReplacementWriteResult,
): {
  requested_writes: number;
  written_count: number;
  preexisting_duplicate_count: number;
  intra_batch_duplicate_count: number;
  fully_written: boolean;
  source_row_mutation: "unchanged";
} {
  const accounted =
    applied.writtenIds.length +
    applied.skippedDuplicates.length +
    applied.intraBatchDuplicates.length;
  return {
    requested_writes: plan.would_write,
    written_count: applied.writtenIds.length,
    preexisting_duplicate_count: applied.skippedDuplicates.length,
    intra_batch_duplicate_count: applied.intraBatchDuplicates.length,
    fully_written: accounted === plan.would_write,
    // The source row is never edited or archived by a decomposition; the
    // replacements are additive and lineage is carried on the children.
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
