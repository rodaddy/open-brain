import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type pg from "pg";
import type { Logger } from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { createPool } from "../../scripts/settings.ts";
import { parseMaintenanceConfig } from "../config/maintenance.ts";
import {
  startMaintenanceQueue,
  MAINTENANCE_GRAPH_AUTH,
} from "./maintenance-bootstrap.ts";
import { createMaintenanceRuntime } from "./index.ts";
import {
  DEFAULT_LIGHT_BATCH_SIZE,
  readLightQueueDepth,
  runLightSweep,
} from "./dream-light.ts";
import { MaintenanceQueue } from "./maintenance-queue.ts";
import { runMaintenanceSweep } from "./maintenance-sweep.ts";

// Per-test allowance for the Light 500-plus-residue test (issue 1518). The
// self-hosted CI runner ran it past vitest's 5000 ms default on 2026-09-25:
// 15010 ms (PR 1531 run 7058) and 5252 ms (PR 1533 run 7079, job 17185); a
// sibling PR 1531 job passed at 4766 ms. Locally it takes 228, 213 and 222 ms.
// 30000 is several times the observed runner tail.
const LIGHT_RESIDUE_ALLOWANCE_MS = 30_000;

type Fixture = {
  schema: string;
  namespaces: string[];
  content: string;
  backlog: Array<{
    namespace: string;
    count: number;
    session_ref: string;
    turn_uuid: string;
    occurred_at: string;
  }>;
  candidate_type: string;
  candidate_model: string;
  expected_light_job: string;
  expected_light_idempotency_key: string;
  expected_light_payload: Record<string, unknown>;
  expected_rem_job: string;
  expected_job_version: number;
};

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/dream-light-producer-v1.json", import.meta.url),
    "utf8",
  ),
) as Fixture;

type TestLogger = {
  info: (message: string, fields: Record<string, string | number>) => void;
  warn: (message: string, fields: Record<string, string | number>) => void;
  error: (message: string, fields: Record<string, string | number>) => void;
};

type LogEvent = {
  level: "info" | "warn" | "error";
  message: string;
  fields: Record<string, string | number>;
};

const logEvents: LogEvent[] = [];
const logger: TestLogger = {
  info: (message, fields) => logEvents.push({ level: "info", message, fields }),
  warn: (message, fields) => logEvents.push({ level: "warn", message, fields }),
  error: (message, fields) => logEvents.push({ level: "error", message, fields }),
};

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

let pool: ReturnType<typeof createPool>;

type DreamJobRow = {
  id: string;
  job_kind: string;
  job_version: number;
  state: string;
  idempotency_key: string;
  namespace: string | null;
  payload: Record<string, unknown>;
};

type TurnProgress = {
  namespace: string;
  total: number;
  swept: number;
};

type OccurrenceRow = {
  namespace: string;
  content_hash: string;
  occurrence_count: number;
  session_count: number;
};

async function readDreamJobs(): Promise<DreamJobRow[]> {
  const result = await pool.query<DreamJobRow>(
    [
      "SELECT id, job_kind, job_version, state, idempotency_key, namespace, payload",
      "FROM maintenance_jobs",
      "WHERE job_kind = ANY($1::text[])",
      "ORDER BY created_at, id",
    ].join("\n"),
    [[fixture.expected_light_job, fixture.expected_rem_job]],
  );
  return result.rows;
}

async function readTurnProgress(): Promise<TurnProgress[]> {
  const result = await pool.query<TurnProgress>(
    [
      "SELECT namespace, count(*)::int AS total,",
      "       count(*) FILTER (WHERE light_swept_at IS NOT NULL)::int AS swept",
      "FROM ob_raw_turns",
      "WHERE namespace = ANY($1::text[])",
      "GROUP BY namespace",
      "ORDER BY namespace",
    ].join("\n"),
    [fixture.namespaces],
  );
  return result.rows;
}

async function readOccurrences(): Promise<OccurrenceRow[]> {
  const result = await pool.query<OccurrenceRow>(
    [
      "SELECT namespace, content_hash, occurrence_count, session_count",
      "FROM content_occurrences",
      "WHERE namespace = ANY($1::text[]) AND content_hash = $2",
      "ORDER BY namespace",
    ].join("\n"),
    [fixture.namespaces, hash(fixture.content)],
  );
  return result.rows;
}

async function clearFixture(): Promise<void> {
  await pool.query("DELETE FROM maintenance_jobs WHERE job_kind = ANY($1::text[])", [
    [fixture.expected_light_job, fixture.expected_rem_job, "graph.derive"],
  ]);
  await pool.query(
    "DELETE FROM content_occurrences WHERE namespace = ANY($1::text[])",
    [fixture.namespaces],
  );
  await pool.query("DELETE FROM candidate_memory WHERE namespace = ANY($1::text[])", [
    fixture.namespaces,
  ]);
  await pool.query("DELETE FROM ob_raw_turns WHERE namespace = ANY($1::text[])", [
    fixture.namespaces,
  ]);
}

async function clearGraphSource(): Promise<void> {
  await pool.query("DELETE FROM ob_sources WHERE namespace = $1 AND external_id = $2", [
    "dream-light-1425-graph",
    "dream-light-1425-graph-source",
  ]);
}

async function seedFixture(counts?: Map<string, number>): Promise<void> {
  const contentHash = hash(fixture.content);

  for (const plan of fixture.backlog) {
    const count = counts?.get(plan.namespace) ?? plan.count;
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const id = randomUUID();
      ids.push(id);
      const occurredAt = new Date(
        Date.parse(plan.occurred_at) + index * 1_000,
      ).toISOString();
      await pool.query(
        [
          "INSERT INTO ob_raw_turns",
          "  (id, namespace, turn_uuid, session_ref, turn_index, role,",
          "   is_human_prompt, content, metadata, content_hash, runtime,",
          "   redaction_applied, distilled_at, created_by, occurred_at,",
          "   retention_tier)",
          "VALUES ($1, $2, $3, $4, $5, 'user', true, $6, '{}'::jsonb, $7,",
          "        'dream-light-fixture', '[]'::jsonb, now(), 'dream-light', $8, 'live')",
        ].join("\n"),
        [
          id,
          plan.namespace,
          `${plan.turn_uuid}-${index}`,
          `${plan.session_ref}-${index}`,
          index,
          fixture.content,
          contentHash,
          occurredAt,
        ],
      );
    }

    if (ids.length === 0) continue;
    await pool.query(
      [
        "INSERT INTO candidate_memory",
        "  (id, namespace, candidate_type, content, content_hash, source_turn_ids,",
        "   model, authority_tier)",
        "VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7, 'observed')",
      ].join("\n"),
      [
        randomUUID(),
        plan.namespace,
        fixture.candidate_type,
        fixture.content,
        contentHash,
        ids,
        fixture.candidate_model,
      ],
    );
  }
}

async function seedGraphSource(): Promise<void> {
  await pool.query(
    [
      "INSERT INTO ob_sources",
      "  (namespace, source_kind, external_id, title, approval_state,",
      "   approved_by, approved_at, lifecycle_state, content_hash, created_by)",
      "VALUES ($1, 'drop', $2, 'dream light graph progress fixture',",
      "        'approved', 'dream-light-checker', now(), 'active', $3, 'dream-light-checker')",
    ].join("\n"),
    ["dream-light-1425-graph", "dream-light-1425-graph-source", "a".repeat(64)],
  );
}

async function seedUndatedTurn(): Promise<string> {
  const id = randomUUID();
  const content = "An undated statement needs source time before corroboration.";
  await pool.query(
    `INSERT INTO ob_raw_turns
       (id, namespace, turn_uuid, session_ref, turn_index, role,
        is_human_prompt, content, metadata, content_hash, runtime,
        redaction_applied, distilled_at, created_by, occurred_at, retention_tier)
     VALUES ($1, $2, $3, $4, 0, 'user', true, $5, '{}'::jsonb, $6,
             'dream-light-fixture', '[]'::jsonb, now(), 'dream-light', NULL, 'live')`,
    [id, fixture.namespaces[0], `${id}-turn`, `${id}-session`, content, hash(content)],
  );
  return id;
}

async function runProducer(
  producerPool: Pick<pg.Pool, "query"> = pool,
): Promise<Awaited<ReturnType<typeof runMaintenanceSweep>>> {
  return runMaintenanceSweep({
    pool: producerPool,
    queue: new MaintenanceQueue(pool),
    logger,
    distillBatchSize: 20,
    maxDistillBatchesPerTick: 1,
    graphDerivationLimit: 1,
  });
}

async function runRegisteredLightQueue(): Promise<void> {
  const runtime = startMaintenanceQueue({
    pool,
    logger,
    autoStart: false,
    embedFn: async () => ({ embedding: null }),
    graphAuth: MAINTENANCE_GRAPH_AUTH,
  });
  await runtime.runner.runOnce();
  await runtime.stop();
}

function onePerNamespace(): Map<string, number> {
  return new Map(fixture.namespaces.map((namespace) => [namespace, 1]));
}

async function assertFirstRegisteredBatch(): Promise<void> {
  await seedFixture();
  await runProducer();
  await runProducer();

  const beforeRun = (await readDreamJobs()).filter(
    (row) => row.job_kind === fixture.expected_light_job,
  );
  expect(beforeRun).toHaveLength(1);
  const firstJob = beforeRun[0];
  if (!firstJob) throw new Error("bounded Light job was not enqueued");

  // The registered production handler is driven by the maintained queue
  // runner. The global job can claim no more than DEFAULT_LIGHT_BATCH_SIZE.
  await runRegisteredLightQueue();
  const afterFirst = (await readDreamJobs()).find((row) => row.id === firstJob.id);
  expect(afterFirst?.state).toBe("succeeded");
  expect(
    (await readTurnProgress()).sort((a, b) => a.namespace.localeCompare(b.namespace)),
  ).toEqual([
    { namespace: fixture.namespaces[0], total: 500, swept: 500 },
    { namespace: fixture.namespaces[1], total: 1, swept: 0 },
  ]);
  expect(DEFAULT_LIGHT_BATCH_SIZE).toBe(500);
}

async function assertResidueAndReplay(): Promise<void> {
  // Completion releases the stable key for the next recurring tick, so the
  // later residue gets a fresh global job with the same contract.
  await runProducer();
  const secondQueued = (await readDreamJobs()).filter(
    (row) => row.job_kind === fixture.expected_light_job && row.state === "queued",
  );
  expect(secondQueued).toHaveLength(1);
  expect(secondQueued[0]?.idempotency_key).toBe(fixture.expected_light_idempotency_key);
  await runRegisteredLightQueue();

  expect(
    (await readTurnProgress()).sort((a, b) => a.namespace.localeCompare(b.namespace)),
  ).toEqual([
    { namespace: fixture.namespaces[0], total: 500, swept: 500 },
    { namespace: fixture.namespaces[1], total: 1, swept: 1 },
  ]);

  // Re-delivering the same logical Light payload after completion must be
  // harmless: rows are already stamped and no occurrence row is duplicated.
  const queue = new MaintenanceQueue(pool);
  await queue.enqueue({
    kind: fixture.expected_light_job,
    version: fixture.expected_job_version,
    payload: fixture.expected_light_payload,
    idempotencyKey: fixture.expected_light_idempotency_key,
  });
  await runRegisteredLightQueue();
  expect(await readOccurrences()).toEqual([
    {
      namespace: fixture.namespaces[0],
      content_hash: hash(fixture.content),
      occurrence_count: 500,
      session_count: 500,
    },
    {
      namespace: fixture.namespaces[1],
      content_hash: hash(fixture.content),
      occurrence_count: 1,
      session_count: 1,
    },
  ]);
}

beforeAll(() => {
  pool = createPool({ max: 4 });
});

beforeEach(async () => {
  logEvents.length = 0;
  await clearFixture();
  await clearGraphSource();
});

afterEach(async () => {
  await clearFixture();
  await clearGraphSource();
});

afterAll(async () => {
  await pool.end();
});

test("producer schedules one global bounded Light job and leaves REM unqueued", async () => {
  await seedFixture(onePerNamespace());
  await runProducer();

  const first = await readDreamJobs();
  const firstLight = first.filter((row) => row.job_kind === fixture.expected_light_job);
  const firstRem = first.filter((row) => row.job_kind === fixture.expected_rem_job);

  // The existing consumer is intentionally global. One producer tick gets
  // one bounded global job with no invented namespace scope; two namespace
  // fixtures below prove write isolation at the handler boundary instead.
  expect(firstLight).toHaveLength(1);
  const job = firstLight[0];
  if (!job) throw new Error("global Light job was not enqueued");
  expect(job.namespace).toBeNull();
  expect(job.idempotency_key).toBe(fixture.expected_light_idempotency_key);
  expect(job.payload).toEqual(fixture.expected_light_payload);
  expect(job.job_version).toBe(fixture.expected_job_version);
  expect(job.state).toBe("queued");
  expect(firstRem).toHaveLength(0);

  // A second producer tick over the same live job is a queue-level replay,
  // not a second occurrence of work.
  await runProducer();
  const replayed = (await readDreamJobs()).filter(
    (row) => row.job_kind === fixture.expected_light_job && row.state === "queued",
  );
  expect(replayed).toHaveLength(1);
  expect(replayed[0]?.id).toBe(job.id);
});

test(
  "registered Light handler consumes 500 plus residue with namespace-safe occurrences",
  async () => {
    await assertFirstRegisteredBatch();
    await assertResidueAndReplay();
  },
  LIGHT_RESIDUE_ALLOWANCE_MS,
);

test("Light processes dated turns and visibly defers an undated turn without requeueing it", async () => {
  await seedFixture(onePerNamespace());
  const undatedId = await seedUndatedTurn();
  await runLightSweep({ pool, logger, batchSize: 500 });
  expect(await readTurnProgress()).toEqual([
    { namespace: fixture.namespaces[0], total: 2, swept: 1 },
    { namespace: fixture.namespaces[1], total: 1, swept: 1 },
  ]);
  const undated = await pool.query<{
    occurred_at: Date | null;
    light_swept_at: Date | null;
  }>("SELECT occurred_at, light_swept_at FROM ob_raw_turns WHERE id = $1", [undatedId]);
  expect(undated.rows[0]).toEqual({ occurred_at: null, light_swept_at: null });
  expect(await readOccurrences()).toEqual([
    {
      namespace: fixture.namespaces[0],
      content_hash: hash(fixture.content),
      occurrence_count: 1,
      session_count: 1,
    },
    {
      namespace: fixture.namespaces[1],
      content_hash: hash(fixture.content),
      occurrence_count: 1,
      session_count: 1,
    },
  ]);
  const sourceTime = await pool.query<{ first_seen_at: Date; last_seen_at: Date }>(
    `SELECT first_seen_at, last_seen_at FROM content_occurrences
      WHERE namespace = $1 AND content_hash = $2`,
    [fixture.namespaces[0], hash(fixture.content)],
  );
  const firstPlan = fixture.backlog[0];
  if (!firstPlan) throw new Error("missing first Light fixture plan");
  expect(sourceTime.rows[0]).toEqual({
    first_seen_at: new Date(firstPlan.occurred_at),
    last_seen_at: new Date(firstPlan.occurred_at),
  });

  const depth = await readLightQueueDepth(pool, fixture.namespaces[0]);
  expect(depth.unswept).toBe(1);
  expect(depth.deferred_missing_timestamp).toBe(1);
  await runProducer();
  await runProducer();
  expect(
    (await readDreamJobs()).filter(
      (row) => row.job_kind === fixture.expected_light_job,
    ),
  ).toHaveLength(0);
  expect(
    logEvents.some(
      (event) =>
        event.level === "warn" &&
        event.message === "maintenance_sweep_light_deferred_missing_timestamp" &&
        event.fields.deferred_missing_timestamp === 1,
    ),
  ).toBe(true);
});

test("Light discovery failure is observable while graph progress and next-tick retry continue", async () => {
  await seedFixture(onePerNamespace());
  await seedGraphSource();

  let failLightDiscovery = true;
  const originalQuery = pool.query.bind(pool);
  const faultingPool: Pick<pg.Pool, "query"> = {
    query: (async (sql: string, values?: unknown[]) => {
      if (
        failLightDiscovery &&
        sql.includes("FROM ob_raw_turns") &&
        sql.includes("light_swept_at")
      ) {
        failLightDiscovery = false;
        throw new Error("fixture Light discovery failure");
      }
      return originalQuery(sql, values);
    }) as unknown as pg.Pool["query"],
  };

  const first = await runProducer(faultingPool);
  expect(first.graphJobsEnqueued).toBe(1);
  expect(
    logEvents.some(
      (event) =>
        event.level === "warn" && event.message === "maintenance_sweep_light_failed",
    ),
  ).toBe(true);
  const graphJobs = await pool.query<{ count: number }>(
    [
      "SELECT count(*)::int AS count FROM maintenance_jobs",
      "WHERE job_kind = 'graph.derive' AND idempotency_key LIKE $1",
    ].join("\n"),
    ["graph.derive:%"],
  );
  expect(graphJobs.rows[0]?.count).toBe(1);

  // The next producer tick retries Light after the injected discovery fault
  // is gone; graph's already-live idempotency key remains a single job.
  const second = await runProducer(faultingPool);
  expect(second.graphJobsEnqueued).toBe(0);
  const retriedLight = (await readDreamJobs()).filter(
    (row) => row.job_kind === fixture.expected_light_job,
  );
  expect(retriedLight).toHaveLength(1);
  expect(retriedLight[0]?.state).toBe("queued");
});

test("maintenance enablement and manual composition controls remain load-bearing", async () => {
  expect(parseMaintenanceConfig({}).enabled).toBe(true);
  const disabled = createMaintenanceRuntime({
    config: parseMaintenanceConfig({ OPEN_BRAIN_MAINTENANCE_ENABLED: "0" }),
    logger: logger as unknown as Logger,
    pool,
    handlers: new Map(),
  });
  expect(disabled).toBeUndefined();

  const manual = createMaintenanceRuntime({
    config: parseMaintenanceConfig({}),
    logger: logger as unknown as Logger,
    pool,
    handlers: new Map([["dream-light-checker.noop", async () => undefined]]),
    autoStart: false,
  });
  expect(manual?.producerLiveness()).toBeUndefined();
  await manual?.stop();
});
