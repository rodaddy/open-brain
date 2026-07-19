import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Pool } from "pg";

const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;
const migrationUrl = new URL("025_normalize_legacy_development_lanes.sql", import.meta.url);

dbDescribe("025 normalize legacy Development lanes (live Postgres)", () => {
  const pool = new Pool({ connectionString: DB_URL });
  const namespaces = [
    "test-migration-025-local",
    "test-migration-025-foreign",
  ];

  async function cleanup(): Promise<void> {
    await pool.query(
      `DELETE FROM ob_session_events WHERE lane_id IN
         (SELECT id FROM ob_session_lanes WHERE namespace = ANY($1::text[]))`,
      [namespaces],
    );
    await pool.query(
      "DELETE FROM ob_session_lanes WHERE namespace = ANY($1::text[])",
      [namespaces],
    );
  }

  async function seedLane(
    slug: string,
    overrides: Record<string, unknown> = {},
    namespace = namespaces[0]!,
  ): Promise<string> {
    const lane = {
      agent: "shared-session-finalizer",
      source: "local-runtime",
      project: slug,
      channel_id: null,
      thread_id: null,
      metadata: {},
      ...overrides,
    };
    const { rows } = await pool.query(
      `INSERT INTO ob_session_lanes
         (session_key, namespace, status, agent, source, project, channel_id,
          thread_id, metadata, created_by)
       VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8, $2)
       RETURNING id`,
      [
        `dev:${slug}`,
        namespace,
        lane.agent,
        lane.source,
        lane.project,
        lane.channel_id,
        lane.thread_id,
        JSON.stringify(lane.metadata),
      ],
    );
    return rows[0].id as string;
  }

  async function runMigration(): Promise<void> {
    await pool.query(await Bun.file(migrationUrl).text());
  }

  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("normalizes only recognized legacy and partial shapes while preserving identity and history", async () => {
    const accepted = [
      { slug: "legacy", overrides: {} },
      {
        slug: "partial",
        overrides: {
          agent: "shared",
          channel_id: "partial",
          metadata: { server_id: "local", retained: true },
        },
      },
      { slug: "null-project", overrides: { project: null } },
      { slug: "json-null", overrides: { metadata: null } },
      { slug: "CaseProject", overrides: { project: "caseproject" } },
      {
        slug: "foreign",
        overrides: { source: null },
        namespace: namespaces[1]!,
      },
    ];
    const acceptedIds = new Map<string, string>();
    for (const item of accepted) {
      acceptedIds.set(
        `${item.namespace ?? namespaces[0]}:${item.slug}`,
        await seedLane(item.slug, item.overrides, item.namespace),
      );
    }
    const historyLaneId = acceptedIds.get(`${namespaces[0]}:legacy`)!;
    await pool.query(
      `INSERT INTO ob_session_events
         (lane_id, event_type, content, created_by)
       VALUES ($1, 'decision', 'preserved history', $2)`,
      [historyLaneId, namespaces[0]],
    );

    await runMigration();
    await runMigration();

    for (const item of accepted) {
      const namespace = item.namespace ?? namespaces[0]!;
      const { rows } = await pool.query(
        `SELECT id, agent, source, project, channel_id, thread_id, metadata
           FROM ob_session_lanes
          WHERE namespace = $1 AND session_key = $2`,
        [namespace, `dev:${item.slug}`],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: acceptedIds.get(`${namespace}:${item.slug}`),
        agent: "shared",
        source: "development",
        project: item.slug,
        channel_id: item.slug,
        thread_id: null,
      });
      expect(rows[0].metadata.server_id).toBe("local");
    }

    const { rows: partialRows } = await pool.query(
      `SELECT metadata FROM ob_session_lanes
        WHERE namespace = $1 AND session_key = 'dev:partial'`,
      [namespaces[0]],
    );
    expect(partialRows[0].metadata).toEqual({
      retained: true,
      server_id: "local",
    });
    const { rows: eventRows } = await pool.query(
      "SELECT id FROM ob_session_events WHERE lane_id = $1",
      [historyLaneId],
    );
    expect(eventRows).toHaveLength(1);
  });

  it("leaves unknown or conflicting lane shapes byte-for-byte unchanged", async () => {
    const rejected = [
      { slug: "bad-agent", overrides: { agent: "unknown-finalizer" } },
      { slug: "bad-source", overrides: { source: "unknown-runtime" } },
      { slug: "bad-server", overrides: { metadata: { server_id: "other" } } },
      { slug: "bad-channel", overrides: { channel_id: "other" } },
      { slug: "bad-thread", overrides: { thread_id: "thread" } },
      { slug: "bad-project", overrides: { project: "other" } },
      { slug: "bad-metadata", overrides: { metadata: "scalar" } },
    ];
    const before = new Map<string, Record<string, unknown>>();
    for (const item of rejected) {
      await seedLane(item.slug, item.overrides);
      const { rows } = await pool.query(
        `SELECT id, agent, source, project, channel_id, thread_id, metadata
           FROM ob_session_lanes
          WHERE namespace = $1 AND session_key = $2`,
        [namespaces[0], `dev:${item.slug}`],
      );
      before.set(item.slug, rows[0]);
    }

    await runMigration();

    for (const item of rejected) {
      const { rows } = await pool.query(
        `SELECT id, agent, source, project, channel_id, thread_id, metadata
           FROM ob_session_lanes
          WHERE namespace = $1 AND session_key = $2`,
        [namespaces[0], `dev:${item.slug}`],
      );
      expect(rows).toEqual([before.get(item.slug)]);
    }
  });
});
