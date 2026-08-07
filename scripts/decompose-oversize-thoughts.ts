#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { Pool, type PoolClient } from "pg";
import { contentHash } from "../src/embedding.ts";
import {
  planEntryDecomposition,
  type DecompositionPlan,
  type ReplacementProposal,
} from "../src/decomposition.ts";

export const REMEDIATION_VERSION = "issue-604-v1";
const TARGET_SOURCE = "planning-skippy-agentspace";
const PIECE_SOURCE = "issue-604-transcript-decomposition";
const REMEDIATION_ACTOR = "issue-604-remediation";
const MIN_TRANSCRIPT_RECORDS = 100;
const REQUIRED_RECORD_FIELDS = ["type", "uuid", "sessionId"] as const;

type ThoughtRow = {
  id: string;
  content: string;
  tags: string[] | null;
  source: string | null;
  created_by: string | null;
  namespace: string;
  tier: string | null;
  created_at: Date | string;
  archived_at: Date | string | null;
};

type TargetPlan = {
  row: ThoughtRow;
  recordCount: number;
  decomposition: DecompositionPlan;
};

type AppliedTarget = {
  original_id: string;
  namespace: string;
  original_bytes: number;
  record_count: number;
  planned_pieces: number;
  written_ids: string[];
  reused_ids: string[];
  piece_ids: string[];
  archived: boolean;
  discard_recorded: boolean;
  embedding_status: "pending";
};

type SourceReference = {
  source_type: "document";
  document_id: string;
  title: string;
  section: string;
  source_hash: string;
};

export function isRawTranscriptDump(content: string): {
  matched: boolean;
  recordCount: number;
} {
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length < MIN_TRANSCRIPT_RECORDS) {
    return { matched: false, recordCount: lines.length };
  }

  let signatureMatches = 0;
  for (const line of lines) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return { matched: false, recordCount: lines.length };
    }
    if (!isObjectRecord(record)) return { matched: false, recordCount: lines.length };
    const hasSignature = REQUIRED_RECORD_FIELDS.every(
      (field) => typeof record[field] === "string",
    );
    if (hasSignature) signatureMatches++;
  }

  return {
    matched: signatureMatches >= Math.ceil(lines.length * 0.8),
    recordCount: lines.length,
  };
}

export function buildTargetPlan(row: ThoughtRow): TargetPlan | null {
  if (row.source !== TARGET_SOURCE || row.archived_at !== null) return null;
  const classification = isRawTranscriptDump(row.content);
  if (!classification.matched) return null;
  const decomposition = planEntryDecomposition({
    table: "thoughts",
    id: row.id,
    namespace: row.namespace,
    content: row.content,
  });
  if (!decomposition.oversized) return null;
  return { row, recordCount: classification.recordCount, decomposition };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readTargets(pool: Pool): Promise<TargetPlan[]> {
  const { rows } = await pool.query<ThoughtRow>(
    `SELECT id, content, tags, source, created_by, namespace, tier, created_at, archived_at
       FROM thoughts
      WHERE source = $1
        AND archived_at IS NULL
        AND parent_id IS NULL
      ORDER BY created_at, id`,
    [TARGET_SOURCE],
  );
  return rows.flatMap((row) => {
    const plan = buildTargetPlan(row);
    return plan ? [plan] : [];
  });
}

function sourceReference(
  target: TargetPlan,
  proposal: ReplacementProposal,
): SourceReference {
  return {
    source_type: "document",
    document_id: target.row.id,
    title: `Archived Claude Code transcript dump ${target.row.id}`,
    section: `chunk:${proposal.chunk_index}`,
    source_hash: contentHash(target.row.content),
  };
}

function promotedFrom(
  target: TargetPlan,
  proposal: ReplacementProposal,
): Record<string, unknown> {
  return {
    source: PIECE_SOURCE,
    remediation_version: REMEDIATION_VERSION,
    source_table: "thoughts",
    source_id: target.row.id,
    source_namespace: target.row.namespace,
    chunk_index: proposal.chunk_index,
  };
}

function pieceTags(target: TargetPlan): string[] {
  return Array.from(
    new Set([
      ...(target.row.tags ?? []),
      "issue-604-decomposition",
      "claude-code-transcript",
    ]),
  );
}

async function appendSourceReference(
  client: PoolClient,
  id: string,
  reference: SourceReference,
  provenance: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `UPDATE thoughts
        SET source_refs = CASE
              WHEN EXISTS (
                SELECT 1
                  FROM jsonb_array_elements(COALESCE(source_refs, '[]'::jsonb)) AS ref(value)
                 WHERE ref.value->>'document_id' = $3
                   AND ref.value->>'section' = $4
              ) THEN COALESCE(source_refs, '[]'::jsonb)
              ELSE COALESCE(source_refs, '[]'::jsonb) || $2::jsonb
            END,
            promoted_from = COALESCE(promoted_from, $5::jsonb)
      WHERE id = $1`,
    [
      id,
      JSON.stringify([reference]),
      reference.document_id,
      reference.section,
      JSON.stringify(provenance),
    ],
  );
}

async function writeProposal(
  client: PoolClient,
  target: TargetPlan,
  proposal: ReplacementProposal,
): Promise<{ id: string; written: boolean }> {
  const hash = contentHash(proposal.content);
  const reference = sourceReference(target, proposal);
  const provenance = promotedFrom(target, proposal);
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO thoughts
       (content, tags, source, created_by, namespace, embedding, content_hash,
        embedded_at, embedding_model, promoted_from, source_refs, parent_id,
        chunk_index, tier)
     VALUES ($1, $2, $3, $4, $5, NULL, $6, NULL, NULL, $7::jsonb, $8::jsonb,
             $9, $10, $11)
     ON CONFLICT (content_hash, namespace) WHERE content_hash IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [
      proposal.content,
      pieceTags(target),
      PIECE_SOURCE,
      REMEDIATION_ACTOR,
      target.row.namespace,
      hash,
      JSON.stringify(provenance),
      JSON.stringify([reference]),
      target.row.id,
      proposal.chunk_index,
      target.row.tier ?? "warm",
    ],
  );
  const insertedId = rows[0]?.id;
  if (insertedId) return { id: insertedId, written: true };

  const existing = await client.query<{ id: string }>(
    `SELECT id
       FROM thoughts
      WHERE content_hash = $1
        AND namespace = $2
        AND archived_at IS NULL`,
    [hash, target.row.namespace],
  );
  const existingId = existing.rows[0]?.id;
  if (!existingId) throw new Error("piece conflict resolved without a live row");
  await appendSourceReference(client, existingId, reference, provenance);
  return { id: existingId, written: false };
}

async function writePieces(
  client: PoolClient,
  target: TargetPlan,
): Promise<{ writtenIds: string[]; reusedIds: string[]; pieceIds: string[] }> {
  const writtenIds: string[] = [];
  const reusedIds: string[] = [];
  const pieceIds: string[] = [];
  for (const proposal of target.decomposition.proposed_replacements) {
    const result = await writeProposal(client, target, proposal);
    pieceIds.push(result.id);
    if (result.written) writtenIds.push(result.id);
    else reusedIds.push(result.id);
  }
  return { writtenIds, reusedIds, pieceIds };
}

async function archiveOriginal(
  client: PoolClient,
  target: TargetPlan,
  replacementId: string,
): Promise<{ archived: boolean; discardRecorded: boolean }> {
  const discard = await client.query(
    `INSERT INTO discarded_entries
       (original_id, source_table, original_content, tags, namespace,
        tier_at_discard, access_summary, reason, expires_at, consolidated_into)
     VALUES ($1, 'thoughts', $2, $3, $4, $5, $6::jsonb, 'manual', NULL, $7)`,
    [
      target.row.id,
      target.row.content,
      target.row.tags ?? [],
      target.row.namespace,
      target.row.tier,
      JSON.stringify({
        remediation_version: REMEDIATION_VERSION,
        replacement_count: target.decomposition.would_write,
      }),
      replacementId,
    ],
  );
  const archived = await client.query(
    `UPDATE thoughts
        SET archived_at = NOW()
      WHERE id = $1
        AND archived_at IS NULL`,
    [target.row.id],
  );
  return {
    archived: archived.rowCount === 1,
    discardRecorded: discard.rowCount === 1,
  };
}

async function applyTargets(pool: Pool, targets: TargetPlan[]): Promise<AppliedTarget[]> {
  const client = await pool.connect();
  const applied: AppliedTarget[] = [];
  try {
    await client.query("BEGIN");
    for (const target of targets) {
      const pieces = await writePieces(client, target);
      const replacementId = pieces.pieceIds[0];
      if (!replacementId) throw new Error("oversized transcript produced no pieces");
      const lifecycle = await archiveOriginal(client, target, replacementId);
      if (!lifecycle.archived || !lifecycle.discardRecorded) {
        throw new Error("original lifecycle transition did not complete");
      }
      applied.push({
        original_id: target.row.id,
        namespace: target.row.namespace,
        original_bytes: Buffer.byteLength(target.row.content, "utf8"),
        record_count: target.recordCount,
        planned_pieces: target.decomposition.would_write,
        written_ids: pieces.writtenIds,
        reused_ids: pieces.reusedIds,
        piece_ids: pieces.pieceIds,
        archived: lifecycle.archived,
        discard_recorded: lifecycle.discardRecorded,
        embedding_status: "pending",
      });
    }
    await client.query("COMMIT");
    return applied;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function dryRunReceipt(targets: TargetPlan[]): Record<string, unknown> {
  return {
    remediation_version: REMEDIATION_VERSION,
    mode: "dry-run",
    matched_originals: targets.length,
    total_original_bytes: targets.reduce(
      (sum, target) => sum + Buffer.byteLength(target.row.content, "utf8"),
      0,
    ),
    total_planned_pieces: targets.reduce(
      (sum, target) => sum + target.decomposition.would_write,
      0,
    ),
    originals: targets.map((target) => ({
      id: target.row.id,
      namespace: target.row.namespace,
      bytes: Buffer.byteLength(target.row.content, "utf8"),
      records: target.recordCount,
      planned_pieces: target.decomposition.would_write,
      largest_piece_chars: Math.max(
        ...target.decomposition.proposed_replacements.map(
          (proposal) => proposal.content_length,
        ),
      ),
      lifecycle: "copy to discarded_entries, then set thoughts.archived_at",
      embeddings: "new rows are written pending embedding repair",
    })),
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { apply: { type: "boolean", default: false } },
    strict: true,
  });
  const pool = new Pool();
  try {
    const targets = await readTargets(pool);
    const receipt = values.apply
      ? {
          remediation_version: REMEDIATION_VERSION,
          mode: "apply",
          matched_originals: targets.length,
          originals: await applyTargets(pool, targets),
        }
      : dryRunReceipt(targets);
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const name = error instanceof Error ? error.name : "unknown";
    process.stderr.write(`decompose-oversize-thoughts failed: ${name}\n`);
    process.exitCode = 1;
  });
}
