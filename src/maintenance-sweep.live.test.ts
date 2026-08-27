/**
 * Live-Postgres idempotency tests for the maintenance sweep.
 *
 * The sweep enqueues one distill job per unchanged window and must return the
 * existing job on the UNIQUE(job_kind, idempotency_key) conflict path rather
 * than inserting an overlapping duplicate. That conflict lives in Postgres, so
 * only a real database exercises it.
 *
 * REQUIRES `OPENBRAIN_TEST_DATABASE_URL`, and fails hard without it (operator
 * ruling 2026-08-27, issue #878). It must point at an isolated test/playground
 * database, never the dogfood database. `bun run test:isolated` sets it.
 *
 * The fixture helpers sit at module scope rather than inside the describe so
 * the suite body stays readable; each takes the pool it works against, which is
 * also what keeps them honest about their one dependency.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import type { Pool } from "pg";
import { requireTestDatabaseUrl } from "../scripts/test-support/require-test-database.ts";
import {
  MEMORY_DISTILL_JOB_KIND,
  runDistillSweep,
} from "./distill-handler.ts";
import {
  MaintenanceQueue,
  type MaintenanceQueueLogger,
} from "./maintenance-queue.ts";
import { runMaintenanceSweep } from "./maintenance-sweep.ts";

const DB_URL = requireTestDatabaseUrl();
const namespace = "test-maintenance-sweep-live";

const logger: MaintenanceQueueLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface JobRow {
  id: string;
  idempotency_key: string;
}

/**
 * Reads an element the query is expected to have returned.
 *
 * A missing row is a fixture defect, not a nullable value, so this throws with
 * the index named instead of handing the assertion an `undefined`.
 */
function at<T>(rows: T[], index: number): T {
  const row = rows[index];
  if (row === undefined) {
    throw new Error(`expected a row at index ${index}, got ${rows.length}`);
  }
  return row;
}

async function cleanup(pool: Pool): Promise<void> {
  await pool.query("DELETE FROM maintenance_jobs WHERE namespace = $1", [
    namespace,
  ]);
  await pool.query("DELETE FROM ob_raw_turns WHERE namespace = $1", [
    namespace,
  ]);
  await pool.query("DELETE FROM ob_session_lanes WHERE namespace = $1", [
    namespace,
  ]);
}

async function insertLane(pool: Pool): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO ob_session_lanes
       (session_key, namespace, agent, created_by)
     VALUES ($1, $2, 'test', 'test')
     RETURNING id`,
    ["maintenance-sweep-live", namespace],
  );
  return at(rows, 0).id;
}

async function insertTurn(
  pool: Pool,
  input: {
    laneId: string;
    sessionRef: string;
    occurredAt: string;
    createdAt: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO ob_raw_turns
       (namespace, turn_uuid, lane_id, session_ref, role, content,
        content_hash, turn_index, occurred_at, created_at, created_by)
     VALUES ($1, $2, $3, $4, 'tool', 'test tool context',
             $2, 0, $5, $6, 'test')`,
    [
      namespace,
      crypto.randomUUID(),
      input.laneId,
      input.sessionRef,
      input.occurredAt,
      input.createdAt,
    ],
  );
}

async function jobRows(pool: Pool): Promise<JobRow[]> {
  const { rows } = await pool.query<JobRow>(
    `SELECT id, idempotency_key
       FROM maintenance_jobs
      WHERE namespace = $1 AND job_kind = $2
      ORDER BY created_at, id`,
    [namespace, MEMORY_DISTILL_JOB_KIND],
  );
  return rows;
}

/**
 * The graph-derivation read is stubbed to empty so the sweep under test is the
 * distill path only; every other statement goes to the real database.
 */
function sweepPool(pool: Pool): Pick<Pool, "query"> {
  const query = (async (sql: string, params?: unknown[]) => {
    if (sql.includes("LEFT JOIN ob_entities anchor")) {
      return { rows: [], rowCount: 0 };
    }
    return pool.query(sql, params);
  }) as Pool["query"];
  return { query };
}

async function sweep(pool: Pool): Promise<void> {
  await runMaintenanceSweep({
    pool: sweepPool(pool),
    queue: new MaintenanceQueue(pool),
    logger,
    distillBatchSize: 100,
    maxDistillBatchesPerTick: 1,
    graphDerivationLimit: 1,
  });
}

describe("maintenance sweep idempotency (live Postgres)", () => {
  let pool: Pool;
  let laneId: string;

  beforeAll(async () => {
    const pg = await import("pg");
    pool = new pg.Pool({ connectionString: DB_URL });
  });

  beforeEach(async () => {
    await cleanup(pool);
    laneId = await insertLane(pool);
  });

  afterAll(async () => {
    await cleanup(pool);
    await pool.end();
  });

  it("dedupes an unchanged window and enqueues again after the consumed window advances", async () => {
    // created_at deliberately disagrees with occurred_at: the old producer chose
    // session-5 as its key anchor, while the real handler consumes sessions 1-4.
    await insertTurn(pool, {
      laneId,
      sessionRef: "session-5",
      occurredAt: "2026-01-05T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    for (let session = 1; session <= 4; session++) {
      await insertTurn(pool, {
        laneId,
        sessionRef: `session-${session}`,
        occurredAt: `2026-01-0${session}T00:00:00.000Z`,
        createdAt: `2026-01-0${session + 1}T00:00:00.000Z`,
      });
    }

    await sweep(pool);
    const firstTick = await jobRows(pool);
    expect(firstTick).toHaveLength(1);

    // The actual UNIQUE(job_kind, idempotency_key) conflict path must return the
    // existing job, not insert an overlapping duplicate for an unchanged window.
    await sweep(pool);
    expect(await jobRows(pool)).toEqual(firstTick);

    const consumed = await runDistillSweep({
      pool,
      logger,
      namespace,
      laneId,
      maxSessions: 4,
      maxTurns: 100,
      skipEmbeddings: true,
    });
    expect(consumed.turns_stamped).toBe(4);

    await insertTurn(pool, {
      laneId,
      sessionRef: "session-6",
      occurredAt: "2026-01-06T00:00:00.000Z",
      createdAt: "2026-01-06T00:00:00.000Z",
    });
    await sweep(pool);

    const advanced = await jobRows(pool);
    expect(advanced).toHaveLength(2);
    expect(at(advanced, 1).idempotency_key).not.toBe(
      at(advanced, 0).idempotency_key,
    );
  });
});
