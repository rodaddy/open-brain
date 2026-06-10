import type { Table } from "./types.ts";

export const TABLE_COLUMNS: Record<Table, string> = {
  thoughts:
    "id, content, tags, source, created_by, created_at, updated_at, tier, usefulness_score, access_count, last_accessed_at, extracted_metadata, namespace, promoted_from",
  decisions:
    "id, title, rationale, alternatives, context, tags, created_by, created_at, updated_at, tier, usefulness_score, access_count, last_accessed_at, extracted_metadata, namespace, promoted_from",
  relationships:
    "id, person_name, context, relationship_type, warmth, email, phone, tags, metadata, created_by, created_at, tier, usefulness_score, access_count, namespace, promoted_from",
  projects:
    "id, name, status, description, metadata, tags, created_by, created_at, tier, usefulness_score, access_count, namespace, promoted_from",
  sessions:
    "id, session_id, project, summary, tags, blockers, next_steps, key_decisions, created_by, created_at, updated_at, tier, namespace, promoted_from",
};
