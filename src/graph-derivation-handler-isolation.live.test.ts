import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import {
  GraphDerivationTerminalError,
  SOURCE_ANCHOR_ENTITY_TYPE,
  makeGraphDerivationHandler,
  selectSourcesNeedingDerivation,
} from "./graph-derivation-handler.ts";
import { requireTestDatabaseUrl } from "../scripts/test-support/require-test-database.ts";
import {
  auth,
  cleanup,
  expectDefined,
  hashA,
  hashB,
  insertSource,
  jobFor,
  ns,
  otherNs,
} from "./graph-derivation-handler-test-helpers.ts";

/**
 * Live-Postgres isolation and atomicity half of the #346 maintenance
 * integration suite (split out under #878).
 *
 * Proves against the REAL schema that derivation never leaks across a
 * namespace, that a mid-derivation failure leaves no partial graph, and that a
 * stale job serialized behind a newer one terminal-stops instead of
 * overwriting the newer committed graph.
 *
 * The suite demands OPENBRAIN_TEST_DATABASE_URL through the shared helper
 * rather than skipping itself when it is absent.
 */
const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

function poolFailingAfter(
  real: Pool,
  failOn: string,
): Pick<Pool, "connect"> & { armed: boolean } {
  const wrapper = {
    armed: true,
    connect: async () => {
      const client = await real.connect();
      const realQuery = client.query.bind(client);
      const realRelease = client.release.bind(client);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).query = ((...args: unknown[]) => {
        const sql = args[0];
        if (wrapper.armed && String(sql).includes(failOn)) {
          wrapper.armed = false;
          throw new Error("injected mid-derivation failure");
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (realQuery as any)(...args);
      }) as never;
      // Un-patch on release so the pooled connection returns to the pool with
      // its original query/release, never the failure-injecting override.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).release = ((...args: unknown[]) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (client as any).query = realQuery;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (client as any).release = realRelease;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (realRelease as any)(...args);
      }) as never;
      return client;
    },
  };
  return wrapper as Pick<Pool, "connect"> & { armed: boolean };
}

async function noDerivedEdgeCrossesNamespace(): Promise<void> {
  const here = await insertSource(pool, ns, { external_id: "iso-here" });
  const there = await insertSource(pool, otherNs, { external_id: "iso-there" });
  const handler = makeGraphDerivationHandler({ pool, auth });
  await handler(
    jobFor(
      {
        source_id: here.id,
        source_kind: "git",
        external_id: here.external_id,
        content_hash: hashA,
        revision: here.revision,
        metadata: { topics: ["Shared Topic"], people: [] },
      },
      ns,
    ),
  );
  await handler(
    jobFor(
      {
        source_id: there.id,
        source_kind: "git",
        external_id: there.external_id,
        content_hash: hashA,
        revision: there.revision,
        metadata: { topics: ["Shared Topic"], people: [] },
      },
      otherNs,
    ),
  );

  // Every edge sits entirely within one namespace on both endpoints.
  const crossing = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM ob_links l
       JOIN ob_entities f ON f.id = l.from_id
       JOIN ob_entities t ON t.id = l.to_id
      WHERE l.namespace = ANY($1::text[])
        AND (f.namespace <> l.namespace OR t.namespace <> l.namespace)`,
    [[ns, otherNs]],
  );
  expect(crossing.rows[0].n).toBe(0);
}

async function rollbackAtomicityLeavesNoPartialGraph(): Promise<void> {
  const src = await insertSource(pool, ns, { external_id: "rollback-src" });

  // Inject a failure on the stale-edge prune UPDATE — the LAST derivation
  // statement, which runs AFTER the anchor upsert has already stamped both the
  // derivation_hash and the content_hash and after every term node + mentions
  // edge has been inserted. Pre-fix (statements auto-committed on the pool),
  // those writes would survive and the stamped hash would falsely short-
  // circuit the retry. With the fix they all live in one transaction.
  const failingPool = poolFailingAfter(
    pool,
    "UPDATE ob_links\n        SET archived_at = NOW()",
  );
  const failingHandler = makeGraphDerivationHandler({
    pool: failingPool as unknown as Pool,
    auth,
  });

  await expect(
    failingHandler(
      jobFor(
        {
          source_id: src.id,
          source_kind: "git",
          external_id: src.external_id,
          content_hash: hashA,
          revision: src.revision,
          metadata: { topics: ["Migrations", "pgvector"], people: ["Rico"] },
        },
        ns,
      ),
    ),
  ).rejects.toThrow("injected mid-derivation failure");

  // ROLLBACK proof: nothing landed. No anchor, no term nodes, no edges — and
  // crucially NO stamped hash for a retry to short-circuit past.
  const entitiesAfterFail = await pool.query(
    "SELECT COUNT(*)::int AS n FROM ob_entities WHERE namespace = $1",
    [ns],
  );
  expect(entitiesAfterFail.rows[0].n).toBe(0);
  const linksAfterFail = await pool.query(
    "SELECT COUNT(*)::int AS n FROM ob_links WHERE namespace = $1",
    [ns],
  );
  expect(linksAfterFail.rows[0].n).toBe(0);
  const anchorAfterFail = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ob_entities
      WHERE namespace = $1 AND entity_type = $2 AND canonical_id = $3`,
    [ns, SOURCE_ANCHOR_ENTITY_TYPE, `${SOURCE_ANCHOR_ENTITY_TYPE}:${src.id}`],
  );
  expect(anchorAfterFail.rows[0].n).toBe(0);
  // The source is still selectable (never derived), proving no partial hash.
  const stillNeeded = await selectSourcesNeedingDerivation(pool, [ns]);
  expect(stillNeeded.length).toBe(1);
  expect(expectDefined(stillNeeded[0], "stillNeeded[0]").id).toBe(src.id);

  // Retry on the healthy pool: the derivation now converges fully.
  const handler = makeGraphDerivationHandler({ pool, auth });
  await handler(
    jobFor(
      {
        source_id: src.id,
        source_kind: "git",
        external_id: src.external_id,
        content_hash: hashA,
        revision: src.revision,
        metadata: { topics: ["Migrations", "pgvector"], people: ["Rico"] },
      },
      ns,
    ),
  );
  const entitiesAfterRetry = await pool.query(
    "SELECT COUNT(*)::int AS n FROM ob_entities WHERE namespace = $1",
    [ns],
  );
  // anchor + 2 topics + 1 person = 4 nodes; 3 mentions edges.
  expect(entitiesAfterRetry.rows[0].n).toBe(4);
  const linksAfterRetry = await pool.query(
    "SELECT COUNT(*)::int AS n FROM ob_links WHERE namespace = $1 AND relation = 'mentions'",
    [ns],
  );
  expect(linksAfterRetry.rows[0].n).toBe(3);
  const anchorAfterRetry = await pool.query(
    `SELECT metadata ->> 'content_hash' AS content_hash
       FROM ob_entities
      WHERE namespace = $1 AND entity_type = $2 AND canonical_id = $3
        AND archived_at IS NULL`,
    [ns, SOURCE_ANCHOR_ENTITY_TYPE, `${SOURCE_ANCHOR_ENTITY_TYPE}:${src.id}`],
  );
  expect(anchorAfterRetry.rows[0].content_hash).toBe(hashA);
  // Fully converged now: no longer selectable.
  const afterRetrySelect = await selectSourcesNeedingDerivation(pool, [ns]);
  expect(afterRetrySelect.length).toBe(0);
}

async function serializedInterleaveTerminalStopsOnDrift(): Promise<void> {
  // The source starts at revision R / hash A. The registry then advances it to
  // revision R+1 / hash B (new bytes AND new terms). A fresh job for (B, R+1)
  // derives the newer graph. The OLD job for (A, R) — still in the queue — must
  // never overwrite that newer graph: its FOR UPDATE guard re-reads the live
  // row under the (A, R) predicate, matches zero rows, and terminal-stops.
  const src = await insertSource(pool, ns, { external_id: "interleave-src" });
  const oldRevision = src.revision;
  const handler = makeGraphDerivationHandler({ pool, auth });

  // Old job runs first and commits the A-graph (one topic: "OldTopic").
  await handler(
    jobFor(
      {
        source_id: src.id,
        source_kind: "git",
        external_id: src.external_id,
        content_hash: hashA,
        revision: oldRevision,
        metadata: { topics: ["OldTopic"], people: [] },
      },
      ns,
    ),
  );

  // The registry observes new content and advances the source (hash + revision
  // bump, exactly as source-registry.ts does on a content change).
  const bumped = await pool.query(
    `UPDATE ob_sources SET content_hash = $1, revision = revision + 1
      WHERE id = $2 AND namespace = $3 RETURNING revision`,
    [hashB, src.id, ns],
  );
  const newRevision = bumped.rows[0].revision as number;

  // A fresh job for the newer snapshot derives the B-graph ("NewTopic").
  await handler(
    jobFor(
      {
        source_id: src.id,
        source_kind: "git",
        external_id: src.external_id,
        content_hash: hashB,
        revision: newRevision,
        metadata: { topics: ["NewTopic"], people: [] },
      },
      ns,
    ),
  );

  // The graph now reflects the NEWER snapshot: anchor stamped hashB, a live
  // anchor->NewTopic edge, and the stale anchor->OldTopic edge pruned.
  async function graphState() {
    const anchor = await pool.query(
      `SELECT id, metadata ->> 'content_hash' AS content_hash,
              metadata ->> 'derivation_hash' AS derivation_hash
         FROM ob_entities
        WHERE namespace = $1 AND entity_type = $2 AND canonical_id = $3
          AND archived_at IS NULL`,
      [ns, SOURCE_ANCHOR_ENTITY_TYPE, `${SOURCE_ANCHOR_ENTITY_TYPE}:${src.id}`],
    );
    const liveTopics = await pool.query(
      `SELECT e.name
         FROM ob_links l
         JOIN ob_entities e ON e.id = l.to_id
        WHERE l.namespace = $1 AND l.from_id = $2 AND l.relation = 'mentions'
          AND l.archived_at IS NULL
        ORDER BY e.name`,
      [ns, anchor.rows[0].id],
    );
    return {
      contentHash: anchor.rows[0].content_hash as string,
      derivationHash: anchor.rows[0].derivation_hash as string,
      liveTopics: liveTopics.rows.map((r) => r.name as string),
    };
  }
  const newer = await graphState();
  expect(newer.contentHash).toBe(hashB);
  expect(newer.liveTopics).toEqual(["NewTopic"]);

  // Now replay the OLD job for (A, R). It is obsolete: the live row is (B, R+1).
  // The FOR UPDATE snapshot guard matches zero rows -> terminal-stop. It must
  // NOT overwrite the newer graph or re-stamp the old hash.
  await expect(
    handler(
      jobFor(
        {
          source_id: src.id,
          source_kind: "git",
          external_id: src.external_id,
          content_hash: hashA,
          revision: oldRevision,
          metadata: { topics: ["OldTopic"], people: [] },
        },
        ns,
      ),
    ),
  ).rejects.toBeInstanceOf(GraphDerivationTerminalError);

  // The committed graph is UNCHANGED — still the newer B-snapshot. No stale
  // overwrite: the anchor still stamps hashB and OldTopic did not revive.
  const afterOldReplay = await graphState();
  expect(afterOldReplay.contentHash).toBe(hashB);
  expect(afterOldReplay.derivationHash).toBe(newer.derivationHash);
  expect(afterOldReplay.liveTopics).toEqual(["NewTopic"]);
}

async function handlerGuardSerializesCompetingRegistryUpdate(): Promise<void> {
  // Finally, prove the serialization comes from the HANDLER'S OWN guard, not a
  // hand-taken lock: while a real handler derivation is mid-transaction (its
  // FOR UPDATE guard holding the source row), a competing registry UPDATE on
  // that same row must BLOCK until the handler commits. Pre-fix — no
  // transaction, no FOR UPDATE — the competing UPDATE would proceed
  // immediately and advance the snapshot out from under the in-flight job.
  //
  // We slow the handler's transaction from the inside by delaying its first
  // derivation write (the anchor upsert), which runs AFTER the FOR UPDATE
  // guard has locked the row and BEFORE COMMIT. That widens the window during
  // which the row lock is held so the race is observable deterministically.
  const src2 = await insertSource(pool, ns, {
    external_id: "lock-serialize-src",
    title: "lock serialization source",
  });
  let updateResolved = false;
  const slowPool = {
    connect: async () => {
      const client = await pool.connect();
      const realQuery = client.query.bind(client);
      const realRelease = client.release.bind(client);
      let delayed = false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).query = (async (...args: unknown[]) => {
        // Delay once, on the first anchor upsert — inside the transaction,
        // after the guard's FOR UPDATE has taken the row lock.
        if (!delayed && String(args[0]).includes("INSERT INTO ob_entities")) {
          delayed = true;
          await new Promise((r) => setTimeout(r, 300));
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (realQuery as any)(...args);
      }) as never;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).release = ((...a: unknown[]) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (client as any).query = realQuery;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (client as any).release = realRelease;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (realRelease as any)(...a);
      }) as never;
      return client;
    },
  };
  const slowHandler = makeGraphDerivationHandler({
    pool: slowPool as unknown as Pool,
    auth,
  });
  const derivation = slowHandler(
    jobFor(
      {
        source_id: src2.id,
        source_kind: "git",
        external_id: src2.external_id,
        content_hash: hashA,
        revision: src2.revision,
        metadata: { topics: ["LockTopic"], people: [] },
      },
      ns,
    ),
  );
  // Let the handler reach its in-transaction delay (guard row lock held).
  await new Promise((r) => setTimeout(r, 100));
  // A competing registry update on the locked row must BLOCK, not proceed.
  const competing = pool
    .query(
      `UPDATE ob_sources SET content_hash = $1, revision = revision + 1
        WHERE id = $2 AND namespace = $3`,
      [hashB, src2.id, ns],
    )
    .then(() => {
      updateResolved = true;
    });
  // Still inside the handler's transaction: the competing UPDATE is blocked.
  await new Promise((r) => setTimeout(r, 100));
  expect(updateResolved).toBe(false);
  // Handler commits and releases the lock; the competing update now completes.
  await derivation;
  await competing;
  expect(updateResolved).toBe(true);
}

/**
 * The interleave scenario runs as two sequential halves under one `it`, purely
 * to keep each function under the code-line standard. Order and assertions are
 * unchanged from the single body they were hoisted out of.
 */
async function serializedInterleave(): Promise<void> {
  await serializedInterleaveTerminalStopsOnDrift();
  await handlerGuardSerializesCompetingRegistryUpdate();
}

describe("graph derivation handler isolation and atomicity (live Postgres)", () => {
  beforeEach(async () => {
    await cleanup(pool);
  });
  afterAll(async () => {
    await cleanup(pool);
    await pool.end();
  });

  it("no derived edge crosses the namespace boundary", noDerivedEdgeCrossesNamespace);
  it(
    "rollback atomicity: a failure after the hash stamp leaves no partial graph, and retry converges",
    rollbackAtomicityLeavesNoPartialGraph,
  );
  it(
    "serialized interleave: an old job cannot overwrite a newer committed graph and terminal-stops on drift",
    serializedInterleave,
  );
});
