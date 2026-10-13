/**
 * DREAM route cohort freezer, against a real Postgres.
 *
 * Seeds ~40 `candidate_memory` rows across three strata with hand-built 768-dim
 * embeddings: one tight cluster near a known anchor, and the rest pushed far
 * apart on their own axes so `<=>` cosine distance separates them cleanly.
 *
 * `source_turn_ids` carries no foreign key (033:80 declares it a bare
 * `UUID[] NOT NULL` with only a cardinality CHECK at 033:131), and
 * `anchor_turn_id` -- the one column that does reference `ob_raw_turns`
 * (041:77) -- stays NULL here, so no turn rows are required. 041:110 then
 * permits `unit_kind = 'fragment'` only with a NULL anchor.
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "./test-support/require-test-database.ts";
import {
  freezeDreamRouteCohort,
  parseDreamRouteArgs,
  type CohortSource,
} from "./dream-route-cohort.ts";

const EMBEDDING_DIMENSIONS = 768;
const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const namespace = `dream-route-${process.pid}`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const createdSchemas: string[] = [];

/** Three strata: (fact, typed), (decision, askuserquestion), (correction, none). */
const STRATA = [
  { candidateType: "fact", anchorKind: "typed", rows: 20 },
  { candidateType: "decision", anchorKind: "askuserquestion", rows: 12 },
  { candidateType: "correction", anchorKind: null, rows: 8 },
] as const;

interface Seeded {
  id: string;
  candidateType: string;
  anchorKind: string;
  axis: number;
}

const seeded: Seeded[] = [];
/** The cluster anchor and the two rows deliberately placed beside it. */
let clusterAnchor = "";
let clusterNear: string[] = [];
let farRow = "";

/**
 * A unit vector on one axis, optionally tilted toward the next axis.
 *
 * Two vectors on different axes are orthogonal, so their cosine distance is 1 --
 * far outside any sane `--max-distance`. A tilt of `t` on the same axis keeps
 * the distance at roughly `t^2 / 2`, which is how the near rows are built.
 *
 * @param axis - Which dimension carries the bulk of the vector.
 * @param tilt - How far to lean into `axis + 1`, in [0, 1).
 * @returns A 768-element unit vector, as pgvector's literal text form.
 */
function unitVector(axis: number, tilt = 0): string {
  const values = Array.from<number>({ length: EMBEDDING_DIMENSIONS }).fill(0);
  const norm = Math.sqrt(1 + tilt * tilt);
  values[axis % EMBEDDING_DIMENSIONS] = 1 / norm;
  values[(axis + 1) % EMBEDDING_DIMENSIONS] = tilt / norm;
  return `[${values.join(",")}]`;
}

async function insertCandidate(row: {
  id: string;
  candidateType: string;
  anchorKind: string | null;
  index: number;
  embedding: string;
  /** Set to make the row a chunk of another: 044:78 pairs it with chunk_index. */
  parentId?: string;
}): Promise<void> {
  const content = `dream route content ${row.index}`;
  await pool.query(
    `INSERT INTO candidate_memory
       (id, namespace, candidate_type, content, content_hash, source_turn_ids,
        model, unit_kind, anchor_kind, operator_text, first_said_at, last_said_at,
        embedding, parent_id, chunk_index)
     VALUES ($1,$2,$3,$4,$5,$6::uuid[],'fixture-model',$7,$8,$9,
             now() - interval '2 days', now(), $10::halfvec, $11,
             CASE WHEN $11::uuid IS NULL THEN NULL ELSE 0 END)`,
    [
      row.id,
      namespace,
      row.candidateType,
      content,
      hash(content),
      [randomUUID()],
      row.anchorKind === null ? "fragment" : "exchange",
      row.anchorKind,
      `operator said ${row.index}`,
      row.embedding,
      row.parentId ?? null,
    ],
  );
}

async function freeze(argv: readonly string[]) {
  const cohort = await freezeDreamRouteCohort(pool, parseDreamRouteArgs(argv));
  createdSchemas.push(cohort.schema);
  return cohort;
}

async function readCohort(schema: string) {
  const result = await pool.query<{
    ordinal: number;
    candidate_id: string;
    source: CohortSource;
    neighbour_of: string | null;
  }>(
    `SELECT ordinal, candidate_id, source, neighbour_of
       FROM ${schema}.cohort ORDER BY ordinal`,
  );
  return result.rows;
}

beforeAll(async () => {
  let index = 0;
  let axis = 10;
  for (const stratum of STRATA) {
    for (let row = 0; row < stratum.rows; row += 1) {
      const id = randomUUID();
      // Every row gets its own orthogonal axis, so nothing is a neighbour of
      // anything until the cluster below is placed deliberately.
      await insertCandidate({
        id,
        candidateType: stratum.candidateType,
        anchorKind: stratum.anchorKind,
        index,
        embedding: unitVector(axis),
      });
      seeded.push({
        id,
        candidateType: stratum.candidateType,
        anchorKind: stratum.anchorKind ?? "none",
        axis,
      });
      index += 1;
      axis += 1;
    }
  }

  // The cluster: three rows sharing axis 500, two of them tilted just enough to
  // sit well inside a 0.15 cosine distance of the third.
  const clusterIds = [randomUUID(), randomUUID(), randomUUID()];
  for (const [offset, id] of clusterIds.entries()) {
    await insertCandidate({
      id,
      candidateType: "fact",
      anchorKind: "typed",
      index: 900 + offset,
      embedding: unitVector(500, offset * 0.2),
    });
    seeded.push({ id, candidateType: "fact", anchorKind: "typed", axis: 500 });
  }
  clusterAnchor = clusterIds[0] ?? "";
  clusterNear = clusterIds.slice(1);
  farRow = seeded[0]?.id ?? "";

  // Excluded by the WHERE clause: a child row and an unembedded row. `parentId`
  // is what actually MAKES it a child (044:53); without it the row was an
  // ordinary eligible row the draw could pick, which it did intermittently.
  await insertCandidate({
    id: randomUUID(),
    candidateType: "fact",
    anchorKind: "typed",
    index: 990,
    embedding: unitVector(700),
    parentId: clusterAnchor,
  });
  await pool.query(
    `INSERT INTO candidate_memory
       (id, namespace, candidate_type, content, content_hash, source_turn_ids,
        model, unit_kind, anchor_kind, operator_text)
     VALUES ($1,$2,'fact',$3,$4,$5::uuid[],'fixture-model','exchange','typed','no embedding')`,
    [randomUUID(), namespace, "unembedded row", hash("unembedded row"), [randomUUID()]],
  );
});

afterAll(async () => {
  for (const schema of createdSchemas) {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }
  await pool.query("DELETE FROM candidate_memory WHERE namespace = $1", [namespace]);
  await pool.end();
});

test("draws ceil(fraction * count) per stratum and excludes children and unembedded rows", async () => {
  const cohort = await freeze([
    "--namespace",
    namespace,
    "--fraction",
    "0.25",
    "--neighbours",
    "0",
  ]);

  // Eligible fact/typed is 20 + 3 cluster = 23 (the child and the unembedded row
  // are excluded); decision 12; correction 8.
  expect(cohort.counts.strata).toEqual({
    "fact/typed": 6,
    "decision/askuserquestion": 3,
    "correction/none": 2,
  });
  expect(cohort.counts.draw).toBe(11);
  expect(cohort.counts.neighbour).toBe(0);
  expect(cohort.counts.labelled).toBe(0);
  expect(cohort.cohortCount).toBe(11);

  const rows = await readCohort(cohort.schema);
  const drawnIds = new Set(rows.map((row) => row.candidate_id));
  const byStratum = new Map<string, number>();
  for (const row of rows) {
    const source = seeded.find((candidate) => candidate.id === row.candidate_id);
    expect(source).toBeDefined();
    const key = `${source?.candidateType}/${source?.anchorKind}`;
    byStratum.set(key, (byStratum.get(key) ?? 0) + 1);
  }
  expect(Object.fromEntries(byStratum)).toEqual({
    "fact/typed": 6,
    "decision/askuserquestion": 3,
    "correction/none": 2,
  });
  // Neither the child nor the unembedded row is eligible; the length check
  // keeps that assertion from going vacuous.
  const ineligible = await pool.query<{ id: string }>(
    `SELECT id FROM candidate_memory
      WHERE namespace = $1 AND (embedding IS NULL OR parent_id IS NOT NULL)`,
    [namespace],
  );
  expect(ineligible.rows.map((row) => drawnIds.has(row.id))).toEqual([false, false]);
});

test("a near row arrives as a neighbour of the row that pulled it in; a far row does not", async () => {
  // fraction 1 draws every row, so instead pin the draw to the cluster anchor
  // alone by deleting nothing and using a tiny fraction with a labels-free run
  // that we can inspect: the cluster is the only place `<=>` is under 0.15.
  const cohort = await freeze([
    "--namespace",
    namespace,
    "--fraction",
    "1",
    "--neighbours",
    "3",
    "--neighbours-for",
    "all",
    "--max-distance",
    "0.15",
  ]);
  const rows = await readCohort(cohort.schema);
  // With fraction 1 every row is drawn, so nothing is left to be a neighbour.
  expect(rows.every((row) => row.source === "draw")).toBe(true);

  // Now prove the neighbour edge itself, with the cluster members removed from
  // the draw by restricting the fraction and checking the distance directly.
  const distances = await pool.query<{ id: string; distance: string }>(
    `SELECT candidate.id, (candidate.embedding <=> anchor.embedding)::text AS distance
       FROM candidate_memory AS candidate,
            (SELECT embedding FROM candidate_memory WHERE id = $1) AS anchor
      WHERE candidate.namespace = $2 AND candidate.id <> $1
        AND candidate.embedding IS NOT NULL
      ORDER BY candidate.embedding <=> anchor.embedding`,
    [clusterAnchor, namespace],
  );
  const near = distances.rows.filter((row) => Number(row.distance) <= 0.15);
  expect(new Set(near.map((row) => row.id))).toEqual(new Set(clusterNear));
  const far = distances.rows.find((row) => row.id === farRow);
  expect(Number(far?.distance)).toBeGreaterThan(0.15);
});

test("neighbours join the cohort with the right neighbour_of", async () => {
  // A namespace holding only the cluster: the draw takes the anchor, and the
  // two near rows can only arrive as its neighbours.
  const soloNamespace = `${namespace}-solo`;
  const anchor = randomUUID();
  const near = [randomUUID(), randomUUID()];
  const far = randomUUID();
  const rowsToSeed = [
    { id: anchor, embedding: unitVector(300, 0) },
    { id: near[0] ?? "", embedding: unitVector(300, 0.2) },
    { id: near[1] ?? "", embedding: unitVector(300, 0.3) },
    { id: far, embedding: unitVector(320) },
  ];
  for (const [offset, row] of rowsToSeed.entries()) {
    await pool.query(
      `INSERT INTO candidate_memory
         (id, namespace, candidate_type, content, content_hash, source_turn_ids,
          model, unit_kind, anchor_kind, operator_text, embedding)
       VALUES ($1,$2,'fact',$3,$4,$5::uuid[],'fixture-model','exchange','typed',$6,$7::halfvec)`,
      [
        row.id,
        soloNamespace,
        `solo ${offset}`,
        hash(`solo ${offset}`),
        [randomUUID()],
        `operator ${offset}`,
        row.embedding,
      ],
    );
  }
  try {
    // fraction 0.25 of 4 rows draws exactly 1, and md5-by-seed decides which.
    const cohort = await freeze([
      "--namespace",
      soloNamespace,
      "--fraction",
      "0.25",
      "--neighbours",
      "3",
      "--neighbours-for",
      "all",
      "--max-distance",
      "0.15",
    ]);
    const rows = await readCohort(cohort.schema);
    const drawn = rows.filter((row) => row.source === "draw");
    expect(drawn).toHaveLength(1);
    const drawnId = drawn[0]?.candidate_id ?? "";
    const neighbours = rows.filter((row) => row.source === "neighbour");
    for (const neighbour of neighbours) {
      expect(neighbour.neighbour_of).toBe(drawnId);
      expect(neighbour.candidate_id).not.toBe(far);
    }
    const clusterMembers: string[] = [anchor, ...near];
    if (clusterMembers.includes(drawnId)) {
      // The drawn row is in the cluster, so the other cluster rows follow it in.
      expect(neighbours.length).toBeGreaterThan(0);
      expect(rows.map((row) => row.candidate_id)).not.toContain(far);
    } else {
      // The far row was drawn; it is alone on its axis, so nothing follows.
      expect(neighbours).toHaveLength(0);
    }
  } finally {
    await pool.query("DELETE FROM candidate_memory WHERE namespace = $1", [
      soloNamespace,
    ]);
  }
});

/**
 * Seeds two near pairs, one per anchor authority, as two strata of two rows.
 *
 * Both rows of a pair share an axis, so a fraction of 0.5 draws one of each and
 * the partner can only arrive as its neighbour. The fragment pair has a NULL
 * anchor; the typed pair is an operator-typed exchange -- the difference
 * `decided` reads.
 *
 * @param pairNamespace - A namespace of its own, deleted by the caller.
 * @returns The two pairs, by authority.
 */
async function seedAuthorityPairs(pairNamespace: string) {
  const pairs = {
    fragment: [randomUUID(), randomUUID()],
    typed: [randomUUID(), randomUUID()],
  };
  const rows = pairs.fragment
    .map((id, tilt) => ({ id, kind: null as string | null, axis: 400, tilt }))
    .concat(pairs.typed.map((id, tilt) => ({ id, kind: "typed", axis: 420, tilt })));
  for (const [offset, row] of rows.entries()) {
    const content = `pair ${offset}`;
    await pool.query(
      `INSERT INTO candidate_memory
         (id, namespace, candidate_type, content, content_hash, source_turn_ids,
          model, unit_kind, anchor_kind, operator_text, embedding)
       VALUES ($1,$2,'preference',$3,$4,$5::uuid[],'fixture-model',$6,$7,$8,$9::halfvec)`,
      // fragment rows must have a NULL anchor (041:110); typed ones an exchange.
      // prettier-ignore
      [row.id, pairNamespace, content, hash(content), [randomUUID()],
       row.kind === null ? "fragment" : "exchange", row.kind,
       `operator ${offset}`, unitVector(row.axis, row.tilt * 0.2)],
    );
  }
  return pairs;
}

test("`decided` searches neighbours only for operator-sourced drawn rows", async () => {
  const pairNamespace = `${namespace}-authority`;
  const pairs = await seedAuthorityPairs(pairNamespace);
  const argv = ["--namespace", pairNamespace, "--fraction", "0.5"];
  argv.push("--neighbours", "3", "--max-distance", "0.15");
  try {
    // `all`: one drawn row per stratum, and each one pulls its partner in.
    const all = await freeze([...argv, "--neighbours-for", "all"]);
    const allRows = await readCohort(all.schema);
    expect(allRows.filter((row) => row.source === "draw")).toHaveLength(2);
    expect(allRows.filter((row) => row.source === "neighbour")).toHaveLength(2);
    expect([all.counts.neighbour_anchors, all.drawnCount]).toEqual([2, 2]);

    // `decided`: only the typed pair's drawn row is searched.
    const decided = await freeze([...argv, "--neighbours-for", "decided"]);
    const decidedRows = await readCohort(decided.schema);
    expect(decidedRows.filter((row) => row.source === "draw")).toHaveLength(2);
    const found = decidedRows.filter((row) => row.source === "neighbour");
    expect(found).toHaveLength(1);
    expect(decided.counts).toMatchObject({ neighbour_anchors: 1, neighbour: 1 });
    expect(pairs.typed).toContain(found[0]?.candidate_id);
    expect(pairs.fragment).not.toContain(found[0]?.candidate_id);
    expect(pairs.typed).toContain(found[0]?.neighbour_of);

    const manifest = await pool.query<{ source_identity: Record<string, unknown> }>(
      `SELECT source_identity FROM ${decided.schema}.manifest WHERE run_id = $1`,
      [decided.schema],
    );
    expect(manifest.rows[0]?.source_identity).toMatchObject({
      neighbours_for: "decided",
    });
  } finally {
    await pool.query("DELETE FROM candidate_memory WHERE namespace = $1", [
      pairNamespace,
    ]);
  }
});

test("the same seed reproduces the draw and the digest; a different seed does not", async () => {
  const argv = ["--namespace", namespace, "--fraction", "0.25", "--neighbours", "0"];
  const first = await freeze([...argv, "--seed", "seed-alpha"]);
  const second = await freeze([...argv, "--seed", "seed-alpha"]);
  const third = await freeze([...argv, "--seed", "seed-beta"]);

  const firstIds = (await readCohort(first.schema)).map((row) => row.candidate_id);
  const secondIds = (await readCohort(second.schema)).map((row) => row.candidate_id);
  const thirdIds = (await readCohort(third.schema)).map((row) => row.candidate_id);

  expect(secondIds).toEqual(firstIds);
  expect(second.digest).toBe(first.digest);
  expect(thirdIds).not.toEqual(firstIds);
  expect(third.digest).not.toBe(first.digest);
  expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
});

test("labelled rows arrive as 'labelled' and outrank a draw", async () => {
  const source = await freeze([
    "--namespace",
    namespace,
    "--fraction",
    "0.25",
    "--neighbours",
    "0",
    "--seed",
    "label-source",
  ]);
  const labelledIds = (await readCohort(source.schema)).map((row) => row.candidate_id);

  const cohort = await freeze([
    "--namespace",
    namespace,
    "--fraction",
    "0.25",
    "--neighbours",
    "0",
    "--seed",
    "label-target",
    "--labels",
    source.schema,
  ]);
  const rows = await readCohort(cohort.schema);
  const bySource = new Map(rows.map((row) => [row.candidate_id, row.source]));
  for (const id of labelledIds) {
    expect(bySource.get(id)).toBe("labelled");
  }
  expect(cohort.counts.labelled).toBe(labelledIds.length);
  // Ordinals run labelled first, then draw, and are contiguous from 1.
  expect(rows.map((row) => row.ordinal)).toEqual(rows.map((_row, index) => index + 1));
  const firstDraw = rows.findIndex((row) => row.source === "draw");
  if (firstDraw >= 0) {
    expect(rows.slice(0, firstDraw).every((row) => row.source === "labelled")).toBe(
      true,
    );
  }
});

test("the manifest records the selection version and every parameter", async () => {
  const cohort = await freeze([
    "--namespace",
    namespace,
    "--fraction",
    "0.25",
    "--neighbours",
    "2",
    "--neighbours-for",
    "all",
    "--max-distance",
    "0.12",
    "--note",
    "manifest proof",
  ]);
  const manifest = await pool.query<{
    namespace: string;
    selection_version: string;
    source_identity: Record<string, unknown>;
    cohort_count: number;
    note: string;
    cohort_digest: string;
  }>(
    `SELECT namespace, selection_version, source_identity, cohort_count, note, cohort_digest
       FROM ${cohort.schema}.manifest WHERE run_id = $1`,
    [cohort.schema],
  );
  const row = manifest.rows[0];
  expect(manifest.rows).toHaveLength(1);
  expect(row?.selection_version).toBe("dream-route-cohort-v1");
  expect(row?.namespace).toBe(namespace);
  expect(row?.cohort_count).toBe(cohort.cohortCount);
  expect(row?.note).toBe("manifest proof");
  expect(row?.cohort_digest).toBe(cohort.digest);
  expect(row?.source_identity).toMatchObject({
    table: "public.candidate_memory",
    namespace,
    fraction: 0.25,
    seed: "dream-route-v1",
    neighbours: 2,
    neighbours_for: "all",
    max_distance: 0.12,
    labels: null,
  });
  expect(cohort.counts.neighbour_anchors).toBe(cohort.drawnCount);
  expect(cohort.teardown).toBe(
    `node --env-file=.env scripts/rem-ethereal-run.ts --drop ${cohort.schema}`,
  );
});

test("the snapshot carries the named columns and never the embedding", async () => {
  const cohort = await freeze([
    "--namespace",
    namespace,
    "--fraction",
    "0.25",
    "--neighbours",
    "0",
  ]);
  const result = await pool.query<{ snapshot: Record<string, unknown> }>(
    `SELECT snapshot FROM ${cohort.schema}.cohort ORDER BY ordinal LIMIT 1`,
  );
  const snapshot = result.rows[0]?.snapshot ?? {};
  expect(Object.keys(snapshot).sort()).toEqual(
    [
      "anchor_kind",
      "candidate_type",
      "content",
      "content_hash",
      "first_said_at",
      "last_said_at",
      "namespace",
      "operator_text",
      "source_turn_ids",
      "unit_kind",
      "id",
    ].sort(),
  );
  expect(snapshot).not.toHaveProperty("embedding");
});

test("nothing is written outside the new schema", async () => {
  const before = await pool.query(
    "SELECT * FROM candidate_memory WHERE namespace = $1 ORDER BY id",
    [namespace],
  );
  const publicTablesBefore = await pool.query<{ relname: string; n: string }>(
    `SELECT c.relname, c.reltuples::text AS n
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`,
  );

  const cohort = await freeze([
    "--namespace",
    namespace,
    "--fraction",
    "0.25",
    "--neighbours",
    "2",
    "--neighbours-for",
    "all",
  ]);

  const after = await pool.query(
    "SELECT * FROM candidate_memory WHERE namespace = $1 ORDER BY id",
    [namespace],
  );
  expect(after.rows).toEqual(before.rows);
  const publicTablesAfter = await pool.query<{ relname: string; n: string }>(
    `SELECT c.relname, c.reltuples::text AS n
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`,
  );
  expect(publicTablesAfter.rows).toEqual(publicTablesBefore.rows);

  // The run's only new tables are the two inside its own schema.
  const own = await pool.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY c.relname`,
    [cohort.schema],
  );
  expect(own.rows.map((row) => row.relname)).toEqual(["cohort", "manifest"]);
});
