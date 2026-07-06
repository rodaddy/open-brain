import type { Table } from "./types.ts";

export function promotionMetadataSelect(table: Table, alias = "t"): string {
  if (table === "thoughts" || table === "decisions") {
    return `${alias}.extracted_metadata`;
  }
  if (table === "relationships" || table === "projects") {
    return `${alias}.metadata`;
  }
  return "NULL::jsonb";
}

export function explicitSharedNominationSqlPredicate(
  table: Table,
  alias = "t",
): string {
  if (table === "thoughts" || table === "decisions") {
    return ` AND ${alias}.extracted_metadata->>'share_candidate' = 'true' AND ${alias}.extracted_metadata->>'memory_lifecycle_action' = 'nominate_shared'`;
  }
  if (table === "relationships" || table === "projects") {
    return ` AND ${alias}.metadata->>'share_candidate' = 'true' AND ${alias}.metadata->>'memory_lifecycle_action' = 'nominate_shared'`;
  }
  return " AND false";
}

export function isExplicitSharedNomination(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  return (
    metadata != null &&
    (metadata?.share_candidate === true ||
      metadata?.share_candidate === "true") &&
    metadata.memory_lifecycle_action === "nominate_shared"
  );
}
