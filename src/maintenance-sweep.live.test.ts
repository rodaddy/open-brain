import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import type { Pool } from "pg";
import {
  MEMORY_DISTILL_JOB_KIND,
  runDistillSweep,
} from "./distill-handler.ts";
import { MaintenanceQueue, type MaintenanceQueueLogger } from "./maintenance-queue.ts";
import { runMaintenanceSweep } from "./maintenance-sweep.ts";

const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;
const namespace = "test-maintenance-sweep-live";

const logger: MaintenanceQueueLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

dbDescribe("maintenance sweep idempotency (live Postgres)", () => {
  let pool: Pool;
  let laneId: string;

  async function cleanup(): Promise<void> {
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

  async function insertLane(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO ob_session_lanes
         (session_key, namespace, agent, created_by)
       VALUES ($1, $2, 'test', 'test')
       RETURNING id`,
      ["maintenance-sweep-live", namespace],
    );
    return rows[0]!.id;
  }

  async function insertTurn(input: {
    sessionRef: string;
    occurredAt: string;
    createdAt: string;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO ob_raw_turns
         (namespace, turn_uuid, lane_id, session_ref, role, content,
          content_hash, turn_index, occurred_at, created_at, created_by)
       VALUES ($1, $2, $3, $4, 'tool', 'test tool context',
               $2, 0, $5, $6, 'test')`,
      [
        namespace,
        crypto.randomUUID(),
        laneId,
        input.sessionRef,
        input.occurredAt,
        input.createdAt,
      ],
    );
  }

  async function jobRows(): Promise<
    Array<{ id: string; idempotency_key: string }>
  > {
    const { rows } = await pool.query<{
      id: string;
      idempotency_key: string;
    }>(
      `SELECT id, idempotency_key
         FROM maintenance_jobs
        WHERE namespace = $1 AND job_kind = $2
        ORDER BY created_at, id`,
      [namespace, MEMORY_DISTILL_JOB_KIND],
    );
    return rows;
  }

  function sweepPool(): Pick<Pool, "query"> {
    const query = (async (sql: string, params?: unknown[]) => {
      if (sql.includes("LEFT JOIN ob_entities anchor")) {
        return { rows: [], rowCount: 0 };
      }
      return pool.query(sql, params);
    }) as Pool["query"];
    return { query };
  }

  async function sweep(): Promise<void> {
    await runMaintenanceSweep({
      pool: sweepPool(),
      queue: new MaintenanceQueue(pool),
      logger,
      distillBatchSize: 100,
      maxDistillBatchesPerTick: 1,
      graphDerivationLimit: 1,
    });
  }

  beforeAll(async () => {
    const pg = await import("pg");
    pool = new pg.Pool({ connectionString: DB_URL });
  });

  beforeEach(async () => {
    await cleanup();
    laneId = await insertLane();
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("dedupes an unchanged window and enqueues again after the consumed window advances", async () => {
    // created_at deliberately disagrees with occurred_at: the old producer chose
    // session-5 as its key anchor, while the real handler consumes sessions 1-4.
    await insertTurn({
      sessionRef: "session-5",
      occurredAt: "2026-01-05T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    for (let session = 1; session <= 4; session++) {
      await insertTurn({
        sessionRef: `session-${session}`,
        occurredAt: `2026-01-0${session}T00:00:00.000Z`,
        createdAt: `2026-01-0${session + 1}T00:00:00.000Z`,
      });
    }

    await sweep();
    const firstTick = await jobRows();
    expect(firstTick).toHaveLength(1);

    // The actual UNIQUE(job_kind, idempotency_key) conflict path must return the
    // existing job, not insert an overlapping duplicate for an unchanged window.
    await sweep();
    expect(await jobRows()).toEqual(firstTick);

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

    await insertTurn({
      sessionRef: "session-6",
      occurredAt: "2026-01-06T00:00:00.000Z",
      createdAt: "2026-01-06T00:00:00.000Z",
    });
    await sweep();

    const advanced = await jobRows();
    expect(advanced).toHaveLength(2);
    expect(advanced[1]!.idempotency_key).not.toBe(
      advanced[0]!.idempotency_key,
    );
  });
});
