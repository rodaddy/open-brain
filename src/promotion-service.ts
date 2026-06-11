import type pg from "pg";
import type { AuthInfo, Table } from "./types.ts";
import {
  appendReadNamespacePredicate,
  canReadNamespace,
} from "./read-policy.ts";
import { canWriteNamespace } from "./namespace-policy.ts";

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

export interface PromotionResult {
  status: "promoted" | "duplicate";
  new_id?: string;
  existing_id?: string;
  existing_archived?: boolean;
  source_id: string;
  source_namespace?: string;
  target_namespace: string;
  provenance?: Record<string, unknown>;
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

  if (source.namespace === targetNamespace) {
    throw Object.assign(new Error(`Entry is already in namespace '${targetNamespace}'`), {
      statusCode: 409,
    });
  }

  const existing = await findDuplicate(pool, table, source, targetNamespace);
  if (existing) {
    return {
      status: "duplicate",
      existing_id: existing.id,
      existing_archived: !!existing.archived_at,
      source_id: id,
      target_namespace: targetNamespace,
    };
  }

  const provenance = {
    source_namespace: source.namespace,
    source_id: id,
    source_agent: source.created_by,
    promotion_reason: reason ?? null,
    promoted_at: new Date().toISOString(),
    promoted_by: auth.clientId,
  };

  const columns = PROMOTION_CONTENT_COLUMNS[table];
  const { rows: inserted } = await pool.query(
    `INSERT INTO ${table} (${columns}, namespace, promoted_from)
     SELECT ${columns}, $2, $3::jsonb
     FROM ${table} WHERE id = $1 AND namespace = $4
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [id, targetNamespace, JSON.stringify(provenance), source.namespace],
  );

  if (inserted.length === 0) {
    const duplicate = await findDuplicate(pool, table, source, targetNamespace);
    if (duplicate) {
      return {
        status: "duplicate",
        existing_id: duplicate.id,
        existing_archived: !!duplicate.archived_at,
        source_id: id,
        target_namespace: targetNamespace,
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
    target_namespace: targetNamespace,
    provenance,
  };
}
