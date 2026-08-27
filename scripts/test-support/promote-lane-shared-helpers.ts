/**
 * Shared harness for the two live promote-lane-shared suites.
 *
 * Holds the seeding, cleanup, and environment plumbing that both
 * `scripts/promote-lane-shared.test.ts` and
 * `scripts/promote-lane-shared-clustering.test.ts` drive. It holds no test and
 * creates no pool: each test file owns its module-scope pool and hands it in.
 */
import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { parseArgs } from "../promote-lane-shared.ts";
import { sharedNamespaceConfig } from "../../src/shared-namespace.ts";

export const DEFAULT_MIN = 24;
// minLen <= len < minLen*1.5 → manual-review. minLen=24 → [24, 36).
export const MANUAL_REVIEW_CONTENT = "x".repeat(30); // len 30, in the ambiguity band.
// len >= minLen*1.5 (>=36) and a shareable type → share.
export const SHARE_CONTENT =
  "This is a substantive shared-worthy decision about the schema design choices.";
export const TEST_NAMESPACE = "test-promote-lane-shared-live";

/** Narrows an optional value, throwing a labelled error when it is absent. */
export function expectDefined<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
}

export interface PromoterHarness {
  ns: string;
  applyDbEnv: () => void;
  restoreDbEnv: () => void;
  cleanupNs: () => Promise<void>;
  explicitNominationMetadata: () => Record<string, unknown>;
  seedLane: () => Promise<string>;
  seedEvent: (laneId: string, content: string, createdAt: string) => Promise<string>;
  seedThought: (content: string, createdAt: string) => Promise<string>;
  seedThoughtWithEmbedding: (
    content: string,
    createdAt: string,
    vecLiteral: string,
  ) => Promise<string>;
  seedSharedAnchor: (content: string, vecLiteral: string) => Promise<string>;
  supplementsLinks: (
    fromId: string,
  ) => Promise<Array<{ to_id: string; metadata: Record<string, unknown> }>>;
  makeArgs: (apply: boolean, stateFile: string) => ReturnType<typeof parseArgs>;
  readState: (stateFile: string) => {
    cursors: Record<string, { created_at?: string; id?: string }>;
  };
}

/**
 * Builds the seeding/cleanup harness both live suites use.
 *
 * @param pool - the caller's module-scope pool, used for seeding and cleanup.
 * @param databaseUrl - the test database URL, from `requireTestDatabaseUrl()`.
 */
export function createPromoterHarness(
  pool: Pool,
  databaseUrl: string,
): PromoterHarness {
  const ns = TEST_NAMESPACE;
  let savedEnv: Record<string, string | undefined> = {};

  // Translate the connection URL into the env vars createPool() expects so the
  // runner's internal pool targets the same test database.
  function applyDbEnv(): void {
    const url = databaseUrl;
    const u = new URL(url);
    savedEnv = {
      DB_HOST: process.env.DB_HOST,
      DB_PORT: process.env.DB_PORT,
      DB_NAME: process.env.DB_NAME,
      DB_USER: process.env.DB_USER,
      DB_PASSWORD: process.env.DB_PASSWORD,
    };
    process.env.DB_HOST = u.hostname;
    process.env.DB_PORT = u.port || "5432";
    process.env.DB_NAME = u.pathname.replace(/^\//, "") || "open_brain";
    process.env.DB_USER = decodeURIComponent(u.username);
    process.env.DB_PASSWORD = decodeURIComponent(u.password);
  }

  function restoreDbEnv(): void {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  // The runner's events loop inserts promoted lane events into the REAL physical
  // shared-kb namespace (config.physicalSharedNamespace), not ns+"-shared", so we
  // resolve it the same way the runner does for an exhaustive cleanup.
  const sharedPhysicalNs = sharedNamespaceConfig().physicalSharedNamespace;

  async function cleanupNs(): Promise<void> {
    // Make cleanup namespace-exhaustive across EVERYTHING any test in this file
    // can create, deleting by namespace rather than by fragile source strings.
    //
    // Sources of residue per test:
    //  1. Seeded source thoughts  → namespace = ns
    //  2. promoteEntry-promoted thought/decision COPIES → namespace = ns+"-shared".
    //     These keep the SOURCE row's `source` value (NOT 'lane-shared-promotion')
    //     so a source-string predicate misses them entirely.
    //  3. Events + lanes → ob_session_events cascade-delete with ob_session_lanes.
    //  4. Promoted lane-event copies → namespace = sharedPhysicalNs (real shared-kb),
    //     source = 'lane-shared-promotion', provenance source_physical_namespace = ns.
    //
    // ob_links created by thought-cluster supplementation (#173) live in the
    // pinned shared namespace (ns+"-shared"); also sweep the real shared-kb ns
    // for any auto-cluster links the events loop could have produced.
    await pool.query(
      `DELETE FROM ob_links
        WHERE relation = 'supplements'
          AND namespace = ANY($1::text[])
          AND metadata->>'clustered_by' = 'lane-shared-promoter'`,
      [[ns + "-shared", sharedPhysicalNs]],
    );
    // Lanes/events: delete lanes for the test ns (events cascade).
    await pool.query("DELETE FROM ob_session_lanes WHERE namespace = $1", [ns]);
    // Seeded source rows AND promoteEntry-promoted copies, by namespace.
    await pool.query("DELETE FROM thoughts WHERE namespace = ANY($1::text[])", [
      [ns, ns + "-shared"],
    ]);
    await pool.query("DELETE FROM decisions WHERE namespace = ANY($1::text[])", [
      [ns, ns + "-shared"],
    ]);
    // Promoted lane-event copies that land in the real shared-kb namespace are
    // scoped to THIS test's provenance so we never touch unrelated shared-kb rows.
    await pool.query(
      `DELETE FROM thoughts
       WHERE namespace = $1
         AND source = 'lane-shared-promotion'
         AND promoted_from->>'source_physical_namespace' = $2`,
      [sharedPhysicalNs, ns],
    );
    // Belt-and-suspenders: any promoted copy whose provenance target points at
    // this test's shared namespace, regardless of which physical ns it landed in.
    await pool.query(
      `DELETE FROM thoughts
       WHERE promoted_from->>'source_physical_namespace' = $1`,
      [ns],
    );
  }

  const seeders = createSeeders(pool, ns);

  return { ns, applyDbEnv, restoreDbEnv, cleanupNs, ...seeders };
}

const EMBED_DIM = 768;

/** A 768-dim halfvec literal for a unit vector with the given [c0, c1] head. */
function unitVec(c0: number, c1: number): string {
  const rest = Array.from({ length: EMBED_DIM - 2 }, () => 0);
  return JSON.stringify([c0, c1, ...rest]);
}
/** The deterministic embedding vectors the clustering suite drives. */
export const NEW_VEC = unitVec(1, 0);
export const IN_BAND_VEC = unitVec(0.85, Math.sqrt(1 - 0.85 * 0.85));
export const FAR_VEC = unitVec(0.5, Math.sqrt(1 - 0.5 * 0.5));
export const DUP_VEC = unitVec(0.96, Math.sqrt(1 - 0.96 * 0.96));

/** The seeding and argument helpers, split out to keep each function small. */
function createSeeders(pool: Pool, ns: string) {
  function explicitNominationMetadata(): Record<string, unknown> {
    return {
      share_candidate: true,
      memory_lifecycle_action: "nominate_shared",
    };
  }

  async function seedLane(): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO ob_session_lanes (session_key, namespace, status, created_by)
       VALUES ($1, $2, 'active', $3)
       RETURNING id`,
      ["promote-test-lane", ns, "test"],
    );
    return rows[0].id as string;
  }

  /** Seed an event. created_at is explicit so cursor ordering is deterministic. */
  async function seedEvent(
    laneId: string,
    content: string,
    createdAt: string,
  ): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO ob_session_events
         (lane_id, event_type, content, importance, metadata, content_hash, created_by, created_at)
       VALUES ($1, 'fact', $2, 'warm', $3::jsonb, $4, 'test', $5::timestamptz)
       RETURNING id`,
      [
        laneId,
        content,
        JSON.stringify(explicitNominationMetadata()),
        // unique-ish hash so ON CONFLICT (lane_id, content_hash) won't collide
        `hash-${content.length}-${createdAt}`,
        createdAt,
      ],
    );
    return rows[0].id as string;
  }

  async function seedThought(content: string, createdAt: string): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO thoughts
         (content, namespace, extracted_metadata, created_by, created_at)
       VALUES ($1, $2, $3::jsonb, 'test', $4::timestamptz)
       RETURNING id`,
      [content, ns, JSON.stringify(explicitNominationMetadata()), createdAt],
    );
    return rows[0].id as string;
  }

  function makeArgs(apply: boolean, stateFile: string): ReturnType<typeof parseArgs> {
    const base = parseArgs([
      "--state-file",
      stateFile,
      "--min-content-length",
      String(DEFAULT_MIN),
      "--batch-size",
      "50",
      "--max-apply",
      "50",
      "--delay-ms",
      "0",
    ]);
    base.apply = apply;
    // Pin the target namespace away from real shared-kb to avoid cross-talk.
    base.targetNamespace = ns + "-shared";
    return base;
  }

  function readState(stateFile: string): {
    cursors: Record<string, { created_at?: string; id?: string }>;
  } {
    return JSON.parse(readFileSync(stateFile, "utf8")) as {
      cursors: Record<string, { created_at?: string; id?: string }>;
    };
  }

  // ── Thought-cluster supplementation (#173) ──
  //
  // We drive the THOUGHTS promoteEntry path with DETERMINISTIC embeddings so the
  const embedSeeders = createEmbeddingSeeders(pool, ns, explicitNominationMetadata);

  return {
    explicitNominationMetadata,
    seedLane,
    seedEvent,
    seedThought,
    makeArgs,
    readState,
    ...embedSeeders,
  };
}

/** Deterministic-embedding seeders, split out to keep each function small. */
function createEmbeddingSeeders(
  pool: Pool,
  ns: string,
  explicitNominationMetadata: () => Record<string, unknown>,
) {
  // cosine distance between a promoted thought and a seeded shared-kb anchor is
  // exact and controllable — no embedding server needed. promoteEntry copies the
  // source thought's `embedding` column verbatim into the shared-kb copy, so the
  // promoted row's vector equals the source vector we set here.
  //
  // Construction: all vectors are 768-dim unit vectors in the span of basis
  // components 0 and 1. For unit vectors u=[a,b,0…] and v=[c,d,0…] the cosine
  // similarity is a*c + b*d, and pgvector's `<=>` (halfvec_cosine_ops) returns
  // cosine DISTANCE = 1 - similarity. So choosing the dot product picks the band.

  /** Seed a source thought (namespace=ns) with a nomination flag + embedding. */
  async function seedThoughtWithEmbedding(
    content: string,
    createdAt: string,
    vecLiteral: string,
  ): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO thoughts
         (content, namespace, extracted_metadata, created_by, created_at,
          embedding, content_hash)
       VALUES ($1, $2, $3::jsonb, 'test', $4::timestamptz, $5::halfvec, $6)
       RETURNING id`,
      [
        content,
        ns,
        JSON.stringify(explicitNominationMetadata()),
        createdAt,
        vecLiteral,
        `src-hash-${createdAt}`,
      ],
    );
    return rows[0].id as string;
  }

  /** Seed an EXISTING shared-kb anchor thought with a controlled embedding. */
  async function seedSharedAnchor(
    content: string,
    vecLiteral: string,
  ): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO thoughts
         (content, namespace, created_by, embedding, content_hash)

       VALUES ($1, $2, 'test', $3::halfvec, $4)
       RETURNING id`,
      [content, ns + "-shared", vecLiteral, `anchor-hash-${content.length}-${content}`],
    );
    return rows[0].id as string;
  }

  /** Count supplements links FROM a given new thought. */
  async function supplementsLinks(
    fromId: string,
  ): Promise<Array<{ to_id: string; metadata: Record<string, unknown> }>> {
    const { rows } = await pool.query(
      `SELECT to_id, metadata FROM ob_links
        WHERE from_type = 'thought' AND from_id = $1
          AND relation = 'supplements' AND archived_at IS NULL`,
      [fromId],
    );
    return rows as Array<{ to_id: string; metadata: Record<string, unknown> }>;
  }
  return { seedThoughtWithEmbedding, seedSharedAnchor, supplementsLinks };
}
