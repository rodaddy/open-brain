// Live Postgres half of the search_brain relational retrieval eval. This file
// requires the test database and fails loudly when it is absent, instead of
// skipping itself and reporting a false green.

import { afterAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../../scripts/test-support/require-test-database.ts";
import { registerSearchBrain } from "../search-brain.ts";
import type { AuthInfo } from "../../types.ts";
import { createMockEmbed, parseToolResult, setupMcpClient } from "./test-helpers.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const ns = "test-relational-retrieval-eval";
const privateNs = `${ns}-private`;

async function cleanupDbFixture(): Promise<void> {
  await pool.query(
    `DELETE FROM entry_access_log
     WHERE entry_id = ANY($1::uuid[])`,
    [
      [
        "10000000-0000-4000-8000-000000000001",
        "10000000-0000-4000-8000-000000000002",
        "10000000-0000-4000-8000-000000000003",
        "10000000-0000-4000-8000-000000000004",
        "11000000-0000-4000-8000-000000000001",
        "12000000-0000-4000-8000-000000000001",
        "13000000-0000-4000-8000-000000000001",
      ],
    ],
  );
  await pool.query("DELETE FROM ob_links WHERE namespace = ANY($1::text[])", [
    [ns, privateNs],
  ]);
  await pool.query("DELETE FROM ob_entities WHERE namespace = ANY($1::text[])", [
    [ns, privateNs],
  ]);
  await pool.query("DELETE FROM decisions WHERE namespace = ANY($1::text[])", [
    [ns, privateNs],
  ]);
  await pool.query("DELETE FROM projects WHERE namespace = ANY($1::text[])", [
    [ns, privateNs],
  ]);
  await pool.query("DELETE FROM sessions WHERE namespace = ANY($1::text[])", [
    [ns, privateNs],
  ]);
  await pool.query("DELETE FROM thoughts WHERE namespace = ANY($1::text[])", [
    [ns, privateNs],
  ]);
}

async function seedDbFixture(): Promise<void> {
  await cleanupDbFixture();
  await pool.query(
    `INSERT INTO thoughts (id, content, namespace, created_by, content_hash)
     VALUES
       ('10000000-0000-4000-8000-000000000001', 'DB relational target visible only through active graph link', $1, 'test', 'rr-db-visible'),
       ('10000000-0000-4000-8000-000000000002', 'DB private target must not leak', $2, 'test', 'rr-db-private'),
       ('10000000-0000-4000-8000-000000000003', 'DB archived link target must not hydrate', $1, 'test', 'rr-db-archived-link'),
       ('10000000-0000-4000-8000-000000000004', 'DB archived entity target must not hydrate', $1, 'test', 'rr-db-archived-entity')`,
    [ns, privateNs],
  );
  await pool.query(
    `INSERT INTO decisions (id, title, rationale, namespace, created_by, content_hash)
     VALUES ('11000000-0000-4000-8000-000000000001', 'DB decision target', 'Hydrated by graph relation only', $1, 'test', 'rr-db-decision')`,
    [ns],
  );
  await pool.query(
    `INSERT INTO projects (id, name, description, namespace, created_by, content_hash)
     VALUES ('12000000-0000-4000-8000-000000000001', 'DB project target', 'Hydrated by graph relation only', $1, 'test', 'rr-db-project')`,
    [ns],
  );
  await pool.query(
    `INSERT INTO sessions (id, project, summary, namespace, created_by, content_hash)
     VALUES ('13000000-0000-4000-8000-000000000001', 'DB session target', 'Hydrated by graph relation only', $1, 'test', 'rr-db-session')`,
    [ns],
  );
  await pool.query(
    `INSERT INTO ob_entities (id, entity_type, name, namespace, created_by, archived_at)
     VALUES
       ('20000000-0000-4000-8000-000000000001', 'issue', 'VisibleSeed', $1, 'test', NULL),
       ('20000000-0000-4000-8000-000000000002', 'issue', 'PrivateSeed', $2, 'test', NULL),
       ('20000000-0000-4000-8000-000000000003', 'issue', 'ArchivedSeed', $1, 'test', '2026-07-01T00:00:00Z'::timestamptz)`,
    [ns, privateNs],
  );
  await pool.query(
    `INSERT INTO ob_links
       (id, from_type, from_id, to_type, to_id, relation, namespace, created_by, archived_at)
     VALUES
       ('30000000-0000-4000-8000-000000000001', 'thought', '10000000-0000-4000-8000-000000000001', 'entity', '20000000-0000-4000-8000-000000000001', 'depends_on', $1, 'test', NULL),
       ('30000000-0000-4000-8000-000000000002', 'thought', '10000000-0000-4000-8000-000000000002', 'entity', '20000000-0000-4000-8000-000000000002', 'depends_on', $2, 'test', NULL),
       ('30000000-0000-4000-8000-000000000003', 'thought', '10000000-0000-4000-8000-000000000003', 'entity', '20000000-0000-4000-8000-000000000001', 'mentions', $1, 'test', '2026-07-01T00:00:00Z'::timestamptz),
       ('30000000-0000-4000-8000-000000000004', 'thought', '10000000-0000-4000-8000-000000000004', 'entity', '20000000-0000-4000-8000-000000000003', 'mentions', $1, 'test', NULL),
       ('30000000-0000-4000-8000-000000000005', 'decision', '11000000-0000-4000-8000-000000000001', 'entity', '20000000-0000-4000-8000-000000000001', 'decided_by', $1, 'test', NULL),
       ('30000000-0000-4000-8000-000000000006', 'project', '12000000-0000-4000-8000-000000000001', 'entity', '20000000-0000-4000-8000-000000000001', 'implemented_by', $1, 'test', NULL),
       ('30000000-0000-4000-8000-000000000007', 'session', '13000000-0000-4000-8000-000000000001', 'entity', '20000000-0000-4000-8000-000000000001', 'blocked_by', $1, 'test', NULL),
       ('30000000-0000-4000-8000-000000000008', 'entity', '20000000-0000-4000-8000-000000000001', 'decision', '11000000-0000-4000-8000-000000000001', 'depends_on', $1, 'test', NULL)`,
    [ns, privateNs],
  );
}

function relationalJoins(direction: "incoming" | "outgoing") {
  const side = (kind: string, alias: string) =>
    direction === "incoming"
      ? `l.from_type = '${kind}'\n        AND ${alias}.id = l.from_id`
      : `l.to_type = '${kind}'\n        AND ${alias}.id = l.to_id`;
  return {
    linkJoin:
      direction === "incoming"
        ? `l.to_type = 'entity'\n        AND l.to_id = s.id`
        : `l.from_type = 'entity'\n        AND l.from_id = s.id`,
    thoughtJoin: side("thought", "t"),
    decisionJoin: side("decision", "d"),
    projectJoin: side("project", "p"),
    sessionJoin: side("session", "se"),
  };
}

async function relationalDbCandidates(
  seedName: string,
  relation: string,
  readableNamespaces: string[],
  direction: "incoming" | "outgoing" = "incoming",
): Promise<Array<{ source_type: string; id: string }>> {
  const { linkJoin, thoughtJoin, decisionJoin, projectJoin, sessionJoin } =
    relationalJoins(direction);
  const { rows } = await pool.query<{ source_type: string; id: string }>(
    `WITH seed AS (
       SELECT id, namespace
       FROM ob_entities
       WHERE lower(name) = lower($1)
         AND namespace = ANY($3::text[])
         AND archived_at IS NULL
     )
     SELECT source_type, id
     FROM (
       SELECT 'thought' AS source_type, t.id::text AS id
       FROM seed s
       JOIN ob_links l
         ON ${linkJoin}
        AND l.namespace = s.namespace
        AND l.relation = $2
        AND l.archived_at IS NULL
       JOIN thoughts t
         ON ${thoughtJoin}
        AND t.namespace = l.namespace
        AND t.archived_at IS NULL
       WHERE l.namespace = ANY($3::text[])
       UNION ALL
       SELECT 'decision' AS source_type, d.id::text AS id
       FROM seed s
       JOIN ob_links l
         ON ${linkJoin}
        AND l.namespace = s.namespace
        AND l.relation = $2
        AND l.archived_at IS NULL
       JOIN decisions d
         ON ${decisionJoin}
        AND d.namespace = l.namespace
        AND d.archived_at IS NULL
       WHERE l.namespace = ANY($3::text[])
       UNION ALL
       SELECT 'project' AS source_type, p.id::text AS id
       FROM seed s
       JOIN ob_links l
         ON ${linkJoin}
        AND l.namespace = s.namespace
        AND l.relation = $2
        AND l.archived_at IS NULL
       JOIN projects p
         ON ${projectJoin}
        AND p.namespace = l.namespace
        AND p.archived_at IS NULL
       WHERE l.namespace = ANY($3::text[])
       UNION ALL
       SELECT 'session' AS source_type, se.id::text AS id
       FROM seed s
       JOIN ob_links l
         ON ${linkJoin}
        AND l.namespace = s.namespace
        AND l.relation = $2
        AND l.archived_at IS NULL
       JOIN sessions se
         ON ${sessionJoin}
        AND se.namespace = l.namespace
        AND se.archived_at IS NULL
       WHERE l.namespace = ANY($3::text[])
     ) hydrated
     ORDER BY source_type, id`,
    [seedName, relation, readableNamespaces],
  );
  return rows;
}

async function provesRealGraphPredicates(): Promise<void> {
  await seedDbFixture();
  try {
    await expect(
      relationalDbCandidates("VisibleSeed", "depends_on", [ns]),
    ).resolves.toEqual([
      { source_type: "thought", id: "10000000-0000-4000-8000-000000000001" },
    ]);
    await expect(
      relationalDbCandidates("PrivateSeed", "depends_on", [ns]),
    ).resolves.toEqual([]);
    await expect(
      relationalDbCandidates("PrivateSeed", "depends_on", [privateNs]),
    ).resolves.toEqual([
      { source_type: "thought", id: "10000000-0000-4000-8000-000000000002" },
    ]);
    await expect(
      relationalDbCandidates("VisibleSeed", "mentions", [ns]),
    ).resolves.toEqual([]);
    await expect(
      relationalDbCandidates("ArchivedSeed", "mentions", [ns]),
    ).resolves.toEqual([]);
    await expect(
      relationalDbCandidates("VisibleSeed", "decided_by", [ns]),
    ).resolves.toEqual([
      { source_type: "decision", id: "11000000-0000-4000-8000-000000000001" },
    ]);
    await expect(
      relationalDbCandidates("VisibleSeed", "implemented_by", [ns]),
    ).resolves.toEqual([
      { source_type: "project", id: "12000000-0000-4000-8000-000000000001" },
    ]);
    await expect(
      relationalDbCandidates("VisibleSeed", "blocked_by", [ns]),
    ).resolves.toEqual([
      { source_type: "session", id: "13000000-0000-4000-8000-000000000001" },
    ]);
    await expect(
      relationalDbCandidates("VisibleSeed", "depends_on", [ns], "outgoing"),
    ).resolves.toEqual([
      { source_type: "decision", id: "11000000-0000-4000-8000-000000000001" },
    ]);
  } finally {
    await cleanupDbFixture();
  }
}

async function returnsGraphHydratedAnswers(): Promise<void> {
  await seedDbFixture();
  const auth: AuthInfo = { role: "admin", clientId: "admin-client" };
  const { client, cleanup } = await setupMcpClient(
    registerSearchBrain,
    pool,
    createMockEmbed(),
    auth,
  );
  try {
    const result = await client.callTool({
      name: "search_brain",
      arguments: {
        query: "What depends on VisibleSeed?",
        namespace: ns,
        limit: 10,
      },
    });
    expect(result.isError).toBeFalsy();
    expect(
      parseToolResult(result).map(
        (entry: { source_type: string; id: string }) =>
          `${entry.source_type}:${entry.id}`,
      ),
    ).toContain("thought:10000000-0000-4000-8000-000000000001");
  } finally {
    await cleanup();
    await cleanupDbFixture();
  }
}

afterAll(async () => {
  await cleanupDbFixture();
  await pool.end();
});

describe("search_brain relational retrieval eval fixture (live Postgres)", () => {
  it(
    "proves real graph predicates enforce namespace and archived lifecycle",
    provesRealGraphPredicates,
  );
  it(
    "returns graph-hydrated answers through the real search_brain tool",
    returnsGraphHydratedAnswers,
  );
});
