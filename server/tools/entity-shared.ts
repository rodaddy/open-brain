/**
 * Shared graph vocabulary and namespace resolution for the `ob_entities` and
 * `ob_links` tools.
 *
 * These sit in one module rather than being restated per tool file so the
 * schemas that define a write's uniqueness key -- the relation enum, the id
 * format, the metadata shape -- cannot drift between the entity tools and the
 * link tools that key off them.
 */
import { z } from "zod";
import { toSql } from "pgvector/pg";
import {
  canTargetNamespace,
  namespacePredicate,
} from "../auth/namespace-policy.ts";
import type { AuthIdentity } from "../auth/types.ts";
import type { MemoryToolDependencies } from "./types.ts";

/**
 * Graph node UUID.
 *
 * Deliberately more permissive than `z.string().uuid()`: existing graph rows
 * carry ids that do not all set the RFC 4122 version/variant nibbles, and a
 * strict check would make those rows unfetchable. Format is still enforced.
 */
const RELAXED_UUID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const graphUuid = z.string().regex(RELAXED_UUID, "Invalid UUID");

export const ENTITY_COLUMNS = `id, entity_type, name, canonical_id, namespace, metadata,
  created_by, created_at, updated_at`;

/**
 * Graph link relations from `009_knowledge_graph.sql`.
 *
 * A Zod enum rather than a free string: `relation` participates in the link
 * uniqueness key, so an unlisted value is a write that the database rejects
 * rather than one the boundary catches.
 */
export const LINK_RELATIONS = [
  "artifact",
  "depends_on",
  "supersedes",
  "caused_by",
  "same_lane",
  "adjacent",
  "mentions",
  "implemented_by",
  "blocked_by",
  "decided_by",
  "relates_to",
  "contradicts",
  "duplicates",
  "supplements",
] as const;

/** Caller-supplied JSON metadata, shaped exactly as current-src shapes it. */
export const metadataSchema = z
  .record(z.string().max(100), z.unknown())
  .optional()
  .refine(
    (value) =>
      !value ||
      (Object.keys(value).length <= 50 &&
        JSON.stringify(value).length <= 100_000),
    { message: "metadata: max 50 keys, max 100KB total" },
  )
  .describe("Arbitrary JSON metadata; max 50 keys, max 100KB total");

/** Namespace argument shared by every graph mutation. */
export const writeNamespaceSchema = z
  .string()
  .max(500)
  .optional()
  .describe("Namespace for isolation (defaults to agent's clientId)");

/**
 * Resolve the namespace a graph mutation will write to.
 *
 * The default is the caller's own lane, and a requested namespace is checked
 * against the auth-derived policy rather than trusted -- a caller-supplied
 * namespace is an input, never an authorization.
 */
export function resolveWriteNamespace(
  identity: AuthIdentity,
  requested: string | undefined,
): { namespace: string } | { denied: string } {
  const namespace = requested ?? identity.clientId;
  if (!canTargetNamespace(identity, "write", namespace)) {
    return { denied: "namespace write denied" };
  }
  return { namespace };
}

/**
 * Embed text, treating provider failure as absence rather than an error.
 *
 * @returns The pgvector literal, or `null` when the provider gave nothing.
 */
export async function embedQuietly(
  dependencies: MemoryToolDependencies,
  text: string,
): Promise<string | null> {
  try {
    const embedding = await dependencies.embedFn(text);
    return embedding ? toSql(embedding) : null;
  } catch (error) {
    dependencies.logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "entity_embed_failed",
    );
    return null;
  }
}

/**
 * Accumulates `WHERE` fragments alongside their positional parameters.
 *
 * Written as one object because the two halves must stay in step: a fragment
 * naming `$3` is only correct if the value it refers to is the third pushed,
 * and hand-tracking that across a chain of optional filters is where the
 * off-by-one lives.
 */
export class SqlFilters {
  readonly values: unknown[] = [];
  private readonly clauses: string[];

  constructor(...initial: string[]) {
    this.clauses = [...initial];
  }

  /** Append `<fragment built from the new placeholder>` with its value. */
  add(build: (placeholder: string) => string, value: unknown): void {
    this.values.push(value);
    this.clauses.push(build(`$${this.values.length}`));
  }

  /** Append a fragment that needs no parameter of its own. */
  addBare(clause: string): void {
    this.clauses.push(clause);
  }

  /** Position the NEXT value would take, for a predicate builder that needs it. */
  nextIndex(): number {
    return this.values.length + 1;
  }

  /** Append several values at once and build one fragment from the last. */
  addAll(
    build: (placeholder: string) => string,
    values: readonly unknown[],
  ): void {
    this.values.push(...values);
    this.clauses.push(build(`$${this.values.length}`));
  }

  /** Push a trailing value with no clause, e.g. LIMIT/OFFSET. */
  push(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  where(): string {
    return this.clauses.join(" AND ");
  }
}

/**
 * Narrow a query to the namespaces the caller may act in.
 *
 * A named namespace has already been authorized by the caller, so it narrows
 * to exactly that one; otherwise the auth-derived predicate supplies the set.
 * Shared because the list and hydrate paths must agree on this, and a
 * divergence between them is a namespace leak rather than a style difference.
 */
export function applyNamespaceScope(
  filters: SqlFilters,
  identity: AuthIdentity,
  action: "read" | "write",
  requested: string | undefined,
): void {
  if (requested) {
    filters.add((placeholder) => `namespace = ${placeholder}`, requested);
    return;
  }
  const predicate = namespacePredicate(identity, action, filters.nextIndex());
  if (predicate.values.length > 0) {
    filters.addAll(
      (placeholder) => `namespace = ANY(${placeholder}::text[])`,
      predicate.values,
    );
  }
}
