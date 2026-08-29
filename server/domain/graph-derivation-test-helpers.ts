/**
 * Shared harness for the graph-derivation unit suites: the logger-field
 * capture used by the content-free sentinels, the in-memory ob_entities /
 * ob_links stand-in that honors both partial-unique indexes, and the
 * canonical auth/input fixtures.
 */
import type { DeriveGraphInput, GraphDerivationPool } from "./graph-derivation.ts";
import { logger } from "../../src/logger.ts";
import type { AuthInfo } from "../../src/types.ts";

/**
 * Capture every field the primitive hands the logger during `fn`, then restore
 * the real logger. Used by the content-free sentinel tests: the derivation
 * primitive must never emit a namespace value, a content/derivation hash value,
 * an anchor id, or any extracted term through observability. Only stable
 * categories (anchor_type / status) and structural counts may leave the server.
 */
export async function captureLoggerFields(
  fn: () => Promise<void>,
): Promise<Record<string, unknown>[]> {
  const captured: Record<string, unknown>[] = [];
  const original = {
    info: logger.info,
    debug: logger.debug,
    warn: logger.warn,
    error: logger.error,
  };
  const record = (extra?: Record<string, unknown>) => {
    if (extra) captured.push(extra);
  };
  logger.info = (_m, extra) => record(extra);
  logger.debug = (_m, extra) => record(extra);
  logger.warn = (_m, extra) => record(extra);
  logger.error = (_m, extra) => record(extra);
  try {
    await fn();
  } finally {
    logger.info = original.info;
    logger.debug = original.debug;
    logger.warn = original.warn;
    logger.error = original.error;
  }
  return captured;
}

/** Postgres-style unique-violation surfaced when an unarbitrated index collides. */
export class FakeUniqueViolation extends Error {
  code = "23505";
  constructor(public constraint: string) {
    super(`duplicate key value violates unique constraint "${constraint}"`);
    this.name = "FakeUniqueViolation";
  }
}

export interface FakeEntityRow {
  id: string;
  namespace: string;
  entity_type: string;
  name: string;
  canonical_id: string | null;
  metadata: Record<string, unknown>;
}

/** Link row keyed by the (namespace, from, to, relation) live identity. */
export interface FakeLinkRow {
  id: string;
  namespace: string;
  from_id: string;
  to_id: string;
  relation: string;
  archived: boolean;
}

/** The only result shape the primitive reads back off this fake. */
interface FakeQueryResult {
  rows: Record<string, unknown>[];
}

/**
 * Realistic in-memory stand-in for the ob_entities / ob_links graph.
 *
 * It models the graph as a flat row set and honors BOTH partial-unique indexes
 * migration 017 defines on ob_entities, not just one:
 *   - idx_ob_entities_lookup_unique (namespace, entity_type, lower(name))
 *     WHERE archived_at IS NULL
 *   - idx_ob_entities_canonical    (namespace, entity_type, canonical_id)
 *     WHERE canonical_id IS NOT NULL AND archived_at IS NULL
 * plus the (namespace, from,to,relation) link identity, all scoped to a single
 * namespace. An INSERT resolves the row addressed by its declared ON CONFLICT
 * arbiter; if the resulting row would collide on the OTHER unique index, that is
 * an UNARBITRATED violation and throws a 23505 exactly as Postgres would. This
 * is what lets the rename regression below observe the canonical-index breach
 * that a name-only fake would silently swallow. `is_new` mirrors `(xmax = 0)`.
 */
export class FakeGraph implements GraphDerivationPool {
  rows: FakeEntityRow[] = [];
  // Link rows carry archived state so the prune UPDATE (soft-delete) and the
  // partial-unique WHERE archived_at IS NULL revive-on-conflict are both
  // observable, exactly like the real ob_links table under migration 017.
  links = new Map<string, FakeLinkRow>();
  calls: Array<{ sql: string; params: unknown[] }> = [];
  private seq = 0;

  private nextId(prefix: string): string {
    this.seq += 1;
    const n = String(this.seq).padStart(12, "0");
    return `00000000-0000-4000-8000-${n}` + prefix.slice(0, 0);
  }

  /** Active row matching the lower(name) partial-unique index, if any. */
  private byName(ns: string, type: string, name: string): FakeEntityRow | undefined {
    return this.rows.find(
      (r) =>
        r.namespace === ns &&
        r.entity_type === type &&
        r.name.toLowerCase() === name.toLowerCase(),
    );
  }

  /** Active row matching the canonical_id partial-unique index, if any. */
  private byCanonical(
    ns: string,
    type: string,
    canonical: string,
  ): FakeEntityRow | undefined {
    return this.rows.find(
      (r) =>
        r.namespace === ns && r.entity_type === type && r.canonical_id === canonical,
    );
  }

  /**
   * Prior-anchor SELECT. Mirrors the real statement: both hash keys read from
   * the anchor metadata, and a jsonb ->> of an absent key is NULL.
   */
  private selectPriorAnchor(params: unknown[]): FakeQueryResult {
    const [ns, type, canonical] = params as [string, string, string];
    const found = this.byCanonical(ns, type, canonical);
    if (!found) return { rows: [] };
    return {
      rows: [
        {
          name: found.name,
          display_name: found.metadata["display_name"] ?? null,
          derivation_hash: found.metadata["derivation_hash"] ?? null,
          content_hash: found.metadata["content_hash"] ?? null,
        },
      ],
    };
  }

  /**
   * Anchor refresh on the unchanged derivation path: update the collision-safe
   * storage name plus display/content metadata without touching nodes or edges.
   */
  private refreshAnchor(params: unknown[]): FakeQueryResult {
    const [ns, type, canonical, name, patch] = params as [
      string,
      string,
      string,
      string,
      string,
    ];
    const row = this.byCanonical(ns, type, canonical);
    if (row) {
      row.name = name;
      row.metadata = {
        ...row.metadata,
        ...(JSON.parse(patch) as Record<string, unknown>),
      };
    }
    return { rows: [] };
  }

  /**
   * DO UPDATE branch of an entity upsert: resolve the arbitrated row, then
   * re-check the OTHER partial-unique index exactly as a real UPDATE would.
   */
  private updateConflictedEntity(
    conflictRow: FakeEntityRow,
    arbitratesCanonical: boolean,
    name: string,
    meta: Record<string, unknown>,
  ): FakeQueryResult {
    // The anchor upsert sets name = EXCLUDED.name; the derived-term upsert
    // leaves name as-is.
    if (arbitratesCanonical) conflictRow.name = name;
    conflictRow.metadata = { ...conflictRow.metadata, ...meta };
    const nameClash = this.byName(
      conflictRow.namespace,
      conflictRow.entity_type,
      conflictRow.name,
    );
    if (nameClash && nameClash !== conflictRow) {
      throw new FakeUniqueViolation("idx_ob_entities_lookup_unique");
    }
    return {
      rows: [{ id: conflictRow.id, is_new: false, namespace: conflictRow.namespace }],
    };
  }

  /** Fresh INSERT branch: Postgres still enforces the unarbitrated index. */
  private insertEntity(draft: Omit<FakeEntityRow, "id">): FakeQueryResult {
    const { namespace: ns, entity_type: type, name, canonical_id: canonical } = draft;
    if (canonical !== null && this.byCanonical(ns, type, canonical)) {
      throw new FakeUniqueViolation("idx_ob_entities_canonical");
    }
    if (this.byName(ns, type, name)) {
      throw new FakeUniqueViolation("idx_ob_entities_lookup_unique");
    }
    const id = this.nextId("e");
    this.rows.push({ id, ...draft });
    return { rows: [{ id, is_new: true, namespace: ns }] };
  }

  private upsertEntity(text: string, params: unknown[]): FakeQueryResult {
    const [type, name, canonical, ns] = params as [string, string, string, string];
    // The anchor INSERT binds metadata as $5::jsonb; the derived-entity INSERT
    // uses an inline '{}'::jsonb literal and has no metadata param. Detect by
    // the SQL shape so we read the right slot.
    const meta = text.includes("$5::jsonb")
      ? (JSON.parse(params[4] as string) as Record<string, unknown>)
      : {};
    const arbitratesCanonical = text.includes(
      "ON CONFLICT (namespace, entity_type, canonical_id)",
    );
    const conflictRow = arbitratesCanonical
      ? this.byCanonical(ns, type, canonical)
      : this.byName(ns, type, name);

    if (conflictRow) {
      return this.updateConflictedEntity(conflictRow, arbitratesCanonical, name, meta);
    }
    return this.insertEntity({
      namespace: ns,
      entity_type: type,
      name,
      canonical_id: canonical,
      metadata: meta,
    });
  }

  private upsertLink(params: unknown[]): FakeQueryResult {
    const [fromId, toId, relation, ns] = params as [string, string, string, string];
    const key = `${ns}|entity|${fromId}|entity|${toId}|${relation}`;
    const existing = this.links.get(key);
    if (existing) {
      // The ON CONFLICT ... WHERE archived_at IS NULL arbiter only matches a
      // LIVE edge. A previously-archived edge with the same identity is not
      // seen by the partial index, so the DO UPDATE revives it (archived_at =
      // NULL) — modeled here by clearing the archived flag. `xmax = 0` on a
      // conflict-resolved row is false either way (not a fresh insert).
      existing.archived = false;
      return {
        rows: [{ id: existing.id, is_new: false, namespace: existing.namespace }],
      };
    }
    const id = this.nextId("l");
    this.links.set(key, {
      id,
      namespace: ns,
      from_id: fromId,
      to_id: toId,
      relation,
      archived: false,
    });
    return { rows: [{ id, is_new: true, namespace: ns }] };
  }

  /**
   * Stale-edge prune (#346): soft-delete this anchor's live `mentions` edges
   * whose target dropped out of the derived set. Scoped by exact namespace +
   * anchor identity (from_type/from_id) + relation; the surviving-target list
   * is a bound uuid[] compared with NOT (to_id = ANY(...)). Returns the rows
   * it archived so the primitive can count and same-namespace-verify them.
   */
  private pruneLinks(params: unknown[]): FakeQueryResult {
    const [ns, fromId, relation, survivors] = params as [
      string,
      string,
      string,
      string[],
    ];
    const keep = new Set(survivors);
    const archived: Array<{ namespace: string }> = [];
    for (const link of this.links.values()) {
      if (
        link.namespace === ns &&
        link.from_id === fromId &&
        link.relation === relation &&
        !link.archived &&
        !keep.has(link.to_id)
      ) {
        link.archived = true;
        archived.push({ namespace: link.namespace });
      }
    }
    return { rows: archived };
  }

  /** Route one statement to the handler that models it. */
  private dispatch(text: string, params: unknown[]): FakeQueryResult {
    if (text.includes("metadata ->> 'derivation_hash' AS derivation_hash")) {
      return this.selectPriorAnchor(params);
    }
    if (
      text.includes("UPDATE ob_entities") &&
      text.includes("metadata = metadata || $5::jsonb")
    ) {
      return this.refreshAnchor(params);
    }
    if (text.includes("INSERT INTO ob_entities")) {
      return this.upsertEntity(text, params);
    }
    if (text.includes("INSERT INTO ob_links")) {
      return this.upsertLink(params);
    }
    if (text.includes("UPDATE ob_links") && text.includes("SET archived_at = NOW()")) {
      return this.pruneLinks(params);
    }
    throw new Error(`unexpected sql: ${text.slice(0, 60)}`);
  }

  // `pg.Pool["query"]` is a wide overload set; the fake implements only the
  // (sql, params) form the primitive actually calls.
  query: GraphDerivationPool["query"] = (async (
    sql: string,
    params: unknown[] = [],
  ): Promise<FakeQueryResult> => {
    this.calls.push({ sql, params });
    return this.dispatch(String(sql), params);
  }) as unknown as GraphDerivationPool["query"];
}

export const auth: AuthInfo = {
  role: "admin",
  clientId: "skippy",
  namespaceSource: "token",
};

export function baseInput(overrides: Partial<DeriveGraphInput> = {}): DeriveGraphInput {
  return {
    anchorType: "thought",
    anchorId: "11111111-1111-4111-8111-111111111111",
    anchorName: "release plan",
    namespace: "team-kb",
    metadata: { topics: ["Migrations", "pgvector"], people: ["Rico"] },
    ...overrides,
  };
}
