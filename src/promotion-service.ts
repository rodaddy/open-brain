import type pg from "pg";
import type { AuthInfo, Table } from "./types.ts";
import {
  appendReadNamespacePredicate,
  canReadNamespace,
} from "./read-policy.ts";
import { canWriteNamespace } from "./namespace-policy.ts";
import {
  canonicalNamespace,
  isSharedNamespace,
  physicalNamespace,
} from "./shared-namespace.ts";

export const PROMOTION_CONTENT_COLUMNS: Record<Table, string> = {
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

/**
 * Nomination/audit keys that must NOT survive into a promoted copy. A promoted
 * row that still carries `share_candidate` would re-nominate itself on the next
 * promoter sweep (the sweep is namespace-wide), causing an endless re-scan and
 * re-promotion attempt. Stripped from the metadata column in the SELECT.
 */
const STRIPPED_PROMOTION_METADATA_KEYS = [
  "share_candidate",
  "share_rejected_sync",
  "share_promoted_at",
  "memory_lifecycle_action",
  "candidate_type",
  "candidate_reason",
  "candidate_confidence",
  "candidate_scope",
  "candidate_staleness_policy",
  "evidence_refs",
] as const;

/**
 * Build the SELECT projection for a promotion copy: identical to the INSERT
 * column list, except the metadata jsonb column (`extracted_metadata` for
 * thoughts/decisions, `metadata` for others) has the nomination keys stripped
 * via `- key` so the promoted copy is not itself a standing nomination.
 */
function promotionSelectExpression(columns: string): string {
  const metaCol = columns.includes("extracted_metadata")
    ? "extracted_metadata"
    : columns.includes(" metadata") || columns.startsWith("metadata")
      ? "metadata"
      : null;
  if (!metaCol) return columns;
  const stripped = STRIPPED_PROMOTION_METADATA_KEYS.map((k) => `- '${k}'`).join(
    " ",
  );
  // Replace the bare column token with the stripped expression aliased back to
  // the column name so positional INSERT/SELECT alignment is preserved.
  return columns
    .split(", ")
    .map((c) => (c === metaCol ? `(${metaCol} ${stripped}) AS ${metaCol}` : c))
    .join(", ");
}

export interface PromotionResult {
  status: "promoted" | "duplicate" | "dry_run";
  new_id?: string;
  existing_id?: string;
  existing_archived?: boolean;
  source_id: string;
  source_namespace?: string;
  target_namespace: string;
  provenance?: Record<string, unknown>;
  dry_run?: boolean;
  would_insert?: boolean;
  backoff?: {
    retryable: boolean;
    suggested_delay_ms: number;
  };
}

export interface PromotionOptions {
  dryRun?: boolean;
  now?: () => Date;
}

function duplicatePredicates(table: Table, source: any, params: unknown[]): string[] {
  const predicates: string[] = [];
  if (source.content_hash) {
    params.push(source.content_hash);
    predicates.push(`content_hash = $${params.length}`);
  }
  if (table === "relationships" && source.person_name) {
    params.push(source.person_name);
    predicates.push(`person_name = $${params.length}`);
  }
  if (table === "projects" && source.name) {
    params.push(source.name);
    predicates.push(`name = $${params.length}`);
  }
  if (table === "sessions" && source.session_id) {
    params.push(source.session_id);
    predicates.push(`session_id = $${params.length}`);
  }
  return predicates;
}

async function findDuplicate(
  pool: pg.Pool,
  table: Table,
  source: any,
  targetNamespace: string,
): Promise<{ id: string; archived_at: string | null } | null> {
  const params: unknown[] = [targetNamespace];
  const predicates = duplicatePredicates(table, source, params);
  if (predicates.length === 0) return null;

  const { rows } = await pool.query(
    `SELECT id, archived_at FROM ${table}
     WHERE namespace = $1 AND (${predicates.join(" OR ")})
     ORDER BY archived_at IS NULL DESC, created_at DESC
     LIMIT 1`,
    params,
  );
  return rows[0] ?? null;
}

export async function promoteEntry(
  pool: pg.Pool,
  table: Table,
  id: string,
  targetNamespace: string,
  reason: string | undefined,
  auth: AuthInfo,
  options: PromotionOptions = {},
): Promise<PromotionResult> {
  const sourceParams: unknown[] = [id];
  const sourceNamespacePredicate = appendReadNamespacePredicate(
    auth,
    sourceParams,
  );
  const { rows: sourceRows } = await pool.query(
    `SELECT *, namespace AS source_namespace FROM ${table} WHERE id = $1 AND archived_at IS NULL${sourceNamespacePredicate}`,
    sourceParams,
  );

  if (sourceRows.length === 0) {
    throw Object.assign(new Error("Source entry not found or archived"), {
      statusCode: 404,
    });
  }

  const source = sourceRows[0];
  if (!canReadNamespace(auth, targetNamespace)) {
    throw Object.assign(new Error("Target namespace read access denied"), {
      statusCode: 403,
    });
  }
  const writeCheck = canWriteNamespace(auth, targetNamespace);
  if (!writeCheck.allowed) {
    throw Object.assign(
      new Error(writeCheck.reason ?? "Target namespace write access denied"),
      {
        statusCode: 403,
      },
    );
  }

  const targetPhysicalNamespace = physicalNamespace(targetNamespace);
  const targetCanonicalNamespace = canonicalNamespace(targetPhysicalNamespace);

  if (source.namespace === targetPhysicalNamespace) {
    throw Object.assign(new Error(`Entry is already in namespace '${targetNamespace}'`), {
      statusCode: 409,
    });
  }

  const existing = await findDuplicate(pool, table, source, targetPhysicalNamespace);
  if (existing) {
    return {
      status: "duplicate",
      existing_id: existing.id,
      existing_archived: !!existing.archived_at,
      source_id: id,
      target_namespace: targetCanonicalNamespace,
    };
  }

  const promotedAt = (options.now ?? (() => new Date()))().toISOString();
  const provenance = {
    source_physical_namespace: source.namespace,
    source_namespace: source.namespace,
    source_table: table,
    source_id: id,
    source_lane_id: source.session_id ?? source.extracted_metadata?.lane_id ?? source.metadata?.lane_id ?? null,
    source_event_id: source.extracted_metadata?.event_id ?? source.metadata?.event_id ?? null,
    source_agent: source.created_by,
    source_identity: source.created_by ?? null,
    source_discord: {
      server_id: source.extracted_metadata?.discord_server_id ?? source.metadata?.discord_server_id ?? null,
      channel_id: source.extracted_metadata?.discord_channel_id ?? source.metadata?.discord_channel_id ?? null,
      thread_id: source.extracted_metadata?.discord_thread_id ?? source.metadata?.discord_thread_id ?? null,
    },
    source_repo: source.extracted_metadata?.repo ?? source.metadata?.repo ?? null,
    source_project: source.project ?? source.extracted_metadata?.project ?? source.metadata?.project ?? null,
    target_namespace: targetCanonicalNamespace,
    target_kind: isSharedNamespace(targetNamespace) ? "shared-kb" : "namespace",
    promotion_reason: reason ?? null,
    promotion_confidence: null,
    promoted_at: promotedAt,
    promoted_by: auth.tokenClientId ?? auth.clientId,
  };

  if (options.dryRun) {
    return {
      status: "dry_run",
      dry_run: true,
      would_insert: true,
      source_id: id,
      source_namespace: source.namespace,
      target_namespace: targetCanonicalNamespace,
      provenance,
      backoff: {
        retryable: true,
        suggested_delay_ms: 250,
      },
    };
  }

  if (process.env.OPENBRAIN_PROMOTION_KILL_SWITCH === "1") {
    throw Object.assign(new Error("Promotion apply mode disabled by OPENBRAIN_PROMOTION_KILL_SWITCH"), {
      statusCode: 503,
    });
  }

  const columns = PROMOTION_CONTENT_COLUMNS[table];
  const selectExpr = promotionSelectExpression(columns);
  const { rows: inserted } = await pool.query(
    `INSERT INTO ${table} (${columns}, namespace, promoted_from)
     SELECT ${selectExpr}, $2, $3::jsonb
     FROM ${table} WHERE id = $1 AND namespace = $4
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [id, targetPhysicalNamespace, JSON.stringify(provenance), source.namespace],
  );

  if (inserted.length === 0) {
    const duplicate = await findDuplicate(
      pool,
      table,
      source,
      targetPhysicalNamespace,
    );
    if (duplicate) {
      return {
        status: "duplicate",
        existing_id: duplicate.id,
        existing_archived: !!duplicate.archived_at,
        source_id: id,
        target_namespace: targetCanonicalNamespace,
      };
    }
    throw Object.assign(new Error("Promotion conflicted with an existing row"), {
      statusCode: 409,
    });
  }

  return {
    status: "promoted",
    new_id: inserted[0].id,
    source_id: id,
    source_namespace: source.namespace,
    target_namespace: targetCanonicalNamespace,
    provenance,
  };
}
