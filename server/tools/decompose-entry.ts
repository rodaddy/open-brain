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
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead, canWrite } from "../auth/permissions.ts";
import {
  createEntryWriteRepository,
  type DecompositionSourceRow,
  type EntryWriteRepository,
} from "../db/entry-write-repository.ts";
import { withTransaction } from "../db/transaction.ts";
import { canTargetNamespace, namespacePredicate } from "../auth/namespace-policy.ts";
import type { AuthIdentity, ResourceTable } from "../auth/types.ts";
import {
  DEFAULT_DECOMPOSITION_MAX_CHARS,
  DEFAULT_DECOMPOSITION_OVERLAP_CHARS,
  planEntryDecomposition,
  type DecompositionPlan,
  type ReplacementProposal,
} from "../domain/decomposition.ts";
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

/** Frozen `decompose_entry` argument contract: the names, types, and rule values are the API. */
const decomposeEntryInputSchema = {
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
};

/** Tool annotations; a plan never mutates and an apply is additive, so a repeat is idempotent. */
const decomposeEntryAnnotations = {
  title: "Decompose Entry",
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
};

type DecomposeEntryArgs = z.infer<z.ZodObject<typeof decomposeEntryInputSchema>>;

/** Chunk sizing after defaults, or a caller-facing reason the pair is unusable. */
interface ChunkSizing {
  readonly maxChunkChars: number;
  readonly overlapChars: number;
  readonly rejection?: string;
}

/**
 * Resolve the request's guard rails before any database work.
 *
 * An apply request missing its explicit mode is refused outright rather than
 * quietly downgraded to a plan, and an overlap that cannot produce progress is
 * refused rather than silently clamped.
 */
function resolveChunkSizing(args: DecomposeEntryArgs): ChunkSizing {
  const maxChunkChars = args.max_chunk_chars ?? DEFAULT_DECOMPOSITION_MAX_CHARS;
  const overlapChars = args.overlap_chars ?? DEFAULT_DECOMPOSITION_OVERLAP_CHARS;
  if (overlapChars >= maxChunkChars) {
    return {
      maxChunkChars,
      overlapChars,
      rejection: "overlap_chars must be less than max_chunk_chars",
    };
  }
  return { maxChunkChars, overlapChars };
}

/** @returns The source row, or `undefined` when it is absent or archived. */
async function loadSourceRow(
  dependencies: MemoryToolDependencies,
  identity: AuthIdentity,
  args: DecomposeEntryArgs,
): Promise<DecompositionSourceRow | undefined> {
  const predicate = namespacePredicate(identity, "read", 2);
  const repository = createEntryWriteRepository(dependencies.pool);
  return repository.loadDecompositionSource({
    table: args.table,
    contentSql: SOURCE_CONTENT_SQL[args.table],
    id: args.id,
    predicateClause: predicate.clause,
    predicateValues: predicate.values,
  });
}

/** The zeroed-but-successful apply body for a plan that proposed nothing. */
function emptyApplyResult(plan: DecompositionPlan): Record<string, unknown> {
  return {
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
  };
}

/** Write the planned replacements and shape the applied response body. */
async function applyPlan(
  dependencies: MemoryToolDependencies,
  identity: AuthIdentity,
  namespace: string,
  plan: DecompositionPlan,
): Promise<Record<string, unknown>> {
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
  const applySummary = buildApplySummary(plan, applied);
  return {
    ...plan,
    status: "applied",
    dry_run: false,
    written_ids: applied.writtenIds,
    skipped_duplicates: applied.skippedDuplicates,
    intra_batch_duplicates: applied.intraBatchDuplicates,
    fully_written: applySummary.fully_written,
    apply_summary: applySummary,
  };
}

async function handleDecomposeEntry(
  dependencies: MemoryToolDependencies,
  identity: AuthIdentity,
  args: DecomposeEntryArgs,
): Promise<ReturnType<typeof textResult>> {
  const applying = args.dry_run === false;
  if (applying && args.apply_mode !== "write_replacements") {
    return errorResult("dry_run=false requires apply_mode=write_replacements");
  }

  const sizing = resolveChunkSizing(args);
  if (sizing.rejection) return errorResult(sizing.rejection);

  const row = await loadSourceRow(dependencies, identity, args);
  if (!row) return errorResult("Entry not found or archived");

  const namespace = String(row.namespace);
  const plan = planEntryDecomposition({
    table: args.table,
    id: String(row.id),
    namespace,
    content: String(row.content_text ?? ""),
    maxChunkChars: sizing.maxChunkChars,
    overlapChars: sizing.overlapChars,
  });

  if (!applying) return textResult(plan);

  const denial = applyDenialReason(identity, namespace);
  if (denial) return errorResult(`Permission denied: ${denial}`);

  if (plan.proposed_replacements.length === 0) {
    return textResult(emptyApplyResult(plan));
  }
  return textResult(await applyPlan(dependencies, identity, namespace, plan));
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
      inputSchema: decomposeEntryInputSchema,
      annotations: decomposeEntryAnnotations,
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      if (!identity || !canRead(identity.role, args.table)) {
        return errorResult(`Permission denied: cannot read ${args.table}`);
      }
      return handleDecomposeEntry(dependencies, identity, args);
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
  const writtenIds: string[] = [];
  const skippedDuplicates: string[] = [];
  const intraBatchDuplicates: string[] = [];
  const writtenIdsByHash = new Map<string, string>();
  return withTransaction({
    pool: dependencies.pool,
    run: async (tx) => {
      const repository = createEntryWriteRepository(tx);
      for (const proposal of plan.proposed_replacements) {
        const hash = contentHash(proposal.content);
        const alreadyWritten = writtenIdsByHash.get(hash);
        if (alreadyWritten) {
          intraBatchDuplicates.push(alreadyWritten);
          continue;
        }
        const insertedId = await insertReplacement({
          repository,
          dependencies,
          identity,
          namespace,
          plan,
          proposal,
          hash,
        });
        if (insertedId) {
          writtenIds.push(insertedId);
          writtenIdsByHash.set(hash, insertedId);
          continue;
        }
        const existingId = await repository.findLiveThoughtByHash({
          contentHash: hash,
          namespace,
        });
        if (typeof existingId === "string") skippedDuplicates.push(existingId);
      }
      return { writtenIds, skippedDuplicates, intraBatchDuplicates };
    },
    onRollbackFailure: (rollbackError) =>
      dependencies.logger.warn(
        {
          tool: "decompose_entry",
          errorName: rollbackError instanceof Error ? rollbackError.name : "unknown",
        },
        "decompose_replacement_rollback_failed",
      ),
  });
}

/** Everything one replacement insert needs; grouped so the call site stays readable. */
interface ReplacementInsert {
  readonly repository: EntryWriteRepository;
  readonly dependencies: MemoryToolDependencies;
  readonly identity: AuthIdentity;
  readonly namespace: string;
  readonly plan: DecompositionPlan;
  readonly proposal: ReplacementProposal;
  readonly hash: string;
}

/** @returns The new row id, or `undefined` when the hash already existed. */
async function insertReplacement({
  repository,
  dependencies,
  identity,
  namespace,
  plan,
  proposal,
  hash,
}: ReplacementInsert): Promise<string | undefined> {
  const embedding = await dependencies.embedFn(proposal.content);
  return repository.insertDecompositionReplacement({
    content: proposal.content,
    tags: replacementTags(proposal),
    createdBy: identity.clientId,
    namespace,
    embedding,
    contentHash: hash,
    embeddedAt: embedding ? new Date().toISOString() : null,
    embeddingModel: embedding ? (dependencies.embeddingModel ?? null) : null,
    provenance: JSON.stringify(proposal.provenance),
    // ONLY for a `thoughts` source: the FK targets `thoughts(id)`
    // (`011_chunking.sql`), so a decision's id here would violate it. For the
    // other four tables the JSON provenance above stays the only lineage.
    parentId: plan.source_ref.table === "thoughts" ? plan.source_ref.id : null,
    chunkIndex: proposal.chunk_index,
  });
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
