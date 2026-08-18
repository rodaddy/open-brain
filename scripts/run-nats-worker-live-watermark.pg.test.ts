/**
 * RED-FIRST done-means check for issue #724 item 3, SECOND HALF — the observer
 * the DEPLOYED worker actually composes.
 *
 * ## What #728 landed, and the hole it left
 *
 * PR #728 built the whole embed-watermark health surface on this worker:
 * an `EmbedWatermarkHealth` block, a configurable threshold
 * (`readEmbedWatermarkThresholdSeconds`), degraded/503 composition in
 * `startHealthServer`, and a runbook section. Its test —
 * `scripts/run-nats-worker-embed-watermark.test.ts` — proves every one of those
 * behaviors by INJECTING an `embedWatermarkHealth` option and asserting the
 * payload composed from it.
 *
 * That is exactly the right test for the composition, and it is silent about
 * the one thing that decides whether the outage gets caught: WHO CONSTRUCTS
 * THE OBSERVER IN PRODUCTION. `startNatsWorkerProcess` only forwards
 * `options.embedWatermarkHealth` (`scripts/run-nats-worker.ts:333-335`) and
 * the live entrypoint calls it with `{ env: process.env }` and nothing else
 * (`scripts/run-nats-worker.ts` `import.meta.main` block). No code path
 * anywhere builds a real observer against the pool. So the deployed worker
 * logs `embed_watermark_observed: false` (`:345`), publishes no
 * `embed_watermark` block, and CAN NEVER ALARM — the surface exists in the
 * tree and is absent from the serving process.
 *
 * This is the #674 class, and the repo has now paid for it twice: #656
 * ("capture observer wired") exists because the capture liveness observer
 * landed with the identical shape — composed if injected, injected by nobody.
 * `scripts/done-means/656-capture-observer-wired.sh` is the precedent for
 * asserting the DEFAULT composition rather than the injected one, and this
 * file is that assertion for the embed lane.
 *
 * ## Why this test needs a real database, when #728's did not
 *
 * #728's test correctly uses no database: an injected fixture block is the
 * whole input to the composition under test, and a wall-clock-free fixture is
 * the right instrument for it (`docs/lane-contract.md`, Tightenings round 5).
 *
 * The claim HERE is different in kind. "The default composition produces a
 * real observer" is only true if the observer can read the corpus, and the
 * failure mode being guarded is precisely one where a plausible-looking
 * observer returns numbers that do not come from rows. A fake pool would let
 * a fix pass by returning a hard-coded block, which is the bug wearing the
 * fix's clothes. So the ages here are computed by Postgres from rows this file
 * seeds, and the test asserts the numbers the SEEDED DATA implies.
 *
 * Ages are still never taken from a wall clock in an assertion: every row is
 * inserted at an offset expressed relative to `now()`, and assertions are
 * range-based around those offsets with a generous tolerance, so a slow runner
 * cannot flake them.
 *
 * ## The schema the observer must read
 *
 * `src/embedding-targets.ts` is the single source of truth for every
 * embedding-bearing table (`EMBEDDING_TARGETS`, `:179`). Its first entry is
 * `thoughts` (`:181`) and it declares `FULL_PROVENANCE` (`:191`), meaning
 * `content_hash`, `embedded_at`, and `embedding_model` all physically exist —
 * `src/db/migrations/001_init.sql:7-19`. That gives the watermark both halves
 * it needs from ONE table, with no invention:
 *
 *   - RAW arrival     -> `thoughts.created_at`  (row exists, embedding pending)
 *   - EMBEDDED mark   -> `thoughts.embedded_at` (embed lane has processed it)
 *
 * `embedded_at IS NULL` is therefore the queue depth, and
 * `max(created_at) - max(embedded_at)` is the lag the block reports as
 * `lag_seconds`. The registry, not this test, is the contract: an
 * implementation that reads the registry rather than hard-coding `thoughts`
 * will satisfy every assertion below and will also pick up
 * `decisions`/`sessions`/`ob_session_events`, all of which carry the same two
 * columns under `FULL_PROVENANCE`.
 *
 * ## STATUS: RED as written
 *
 * On this branch `startNatsWorkerProcess` constructs no observer, so the
 * default-composition case logs `embed_watermark_observed: false` and serves a
 * payload with no `embed_watermark` key. Every case below asserts the desired
 * behavior and is expected to FAIL until an observer is built by default. This
 * file does not implement it.
 *
 * Gated on OPENBRAIN_TEST_DATABASE_URL (repo dbDescribe convention). Run it the
 * trustworthy way, per AGENTS.md:
 *
 *   bun run test:isolated scripts/run-nats-worker-live-watermark.pg.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "../src/db/migrate.ts";
import { createNatsBridgeHealth } from "../src/nats-bridge.ts";
import {
  readNatsWorkerBoundary,
  type NatsWorkerRuntime,
} from "../src/nats-worker.ts";
import { startNatsWorkerProcess } from "./run-nats-worker.ts";

const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;

/** Namespace/author marker so this file's rows are identifiable and removable. */
const CREATED_BY = "wm-live-observer-pg-test";
const NAMESPACE = "wm-live-observer-ns";

/** The threshold every case below runs against, in seconds. */
const THRESHOLD_SECONDS = 3600;

let pool: Pool;

/**
 * The health payload shape this lane's fix must make the DEFAULT composition
 * produce. Declared here rather than imported so a missing export is a red
 * assertion instead of a typecheck failure.
 */
interface EmbedWatermarkBlock {
  readonly stale: boolean;
  readonly newest_raw_age_seconds: number;
  readonly newest_embedded_age_seconds: number;
  readonly lag_seconds: number;
  readonly lag_threshold_seconds: number;
  readonly raw_rows_recent: number;
  readonly reason: string;
}

/**
 * Seed one `thoughts` row at explicit ages.
 *
 * `createdAgoSeconds` is the raw arrival; `embeddedAgoSeconds` null means the
 * row is still sitting in the embed queue — which is what a stalled lane looks
 * like in the corpus. Columns are exactly those in
 * `src/db/migrations/001_init.sql:7-19`; `embedding` is left NULL because the
 * watermark is a TIMESTAMP comparison and never reads the halfvec.
 */
async function seedThought(input: {
  content: string;
  createdAgoSeconds: number;
  embeddedAgoSeconds: number | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO thoughts
       (content, namespace, created_by, created_at, updated_at, embedded_at, embedding_model)
     VALUES
       ($1, $2, $3,
        now() - make_interval(secs => $4::double precision),
        now() - make_interval(secs => $4::double precision),
        CASE WHEN $5::double precision IS NULL THEN NULL
             ELSE now() - make_interval(secs => $5::double precision) END,
        CASE WHEN $5::double precision IS NULL THEN NULL ELSE 'test-model' END)`,
    [
      input.content,
      NAMESPACE,
      CREATED_BY,
      input.createdAgoSeconds,
      input.embeddedAgoSeconds,
    ],
  );
}

/**
 * Start the worker THE WAY THE DEPLOYED PROCESS DOES — no `embedWatermarkHealth`
 * option — and return both the startup summary the worker logged and its
 * `/health` payload.
 *
 * `serve` is captured rather than bound (no port is opened) and `log.info` is
 * recorded, so the same call yields both halves of the claim: the summary field
 * `embed_watermark_observed`, and the payload block computed from seeded rows.
 * The REAL pool is passed through `createDbPool`, which is the only injection
 * here and is the standard test seam for the database — the observer itself is
 * deliberately NOT injected, because whether one gets built is the thing under
 * test.
 */
async function startDefaultWorker(): Promise<{
  summary: Record<string, unknown>;
  status: number;
  body: Record<string, unknown>;
}> {
  const env: NodeJS.ProcessEnv = {
    OPENBRAIN_NATS_URL: "nats://127.0.0.1:4222",
    OPEN_BRAIN_NATS_WORKER_HEALTH_PORT: "3110",
    OPENBRAIN_EMBED_WATERMARK_LAG_THRESHOLD_SECONDS: String(THRESHOLD_SECONDS),
  };

  let handler: ((request: Request) => Response | Promise<Response>) | null =
    null;
  let summary: Record<string, unknown> = {};

  const runtime: NatsWorkerRuntime = {
    boundary: readNatsWorkerBoundary(env),
    // AVAILABLE in every case: a healthy bridge must not be able to hold this
    // endpoint green while the embed lane is stalled. That combination is the
    // exact shape of the three-day outage.
    health: createNatsBridgeHealth("available"),
    subject: "dev.ob.memory.context_pack",
    close: async () => undefined,
  };

  const processRuntime = await startNatsWorkerProcess({
    env,
    log: {
      info: (_msg: string, fields?: Record<string, unknown>) => {
        if (fields && "embed_watermark_observed" in fields) summary = fields;
      },
      error: () => undefined,
    } as never,
    buildTokens: () =>
      new Map([["secret-token", { role: "admin", clientId: "rico" }]]) as never,
    // The real pool, behind a shim whose ONLY difference is that `end()` is a
    // no-op. `startNatsWorkerProcess.shutdown()` legitimately closes the pool
    // it was handed (`closePool`, scripts/run-nats-worker.ts), and this suite
    // owns the pool across all four cases — letting the first worker end it
    // kills every later case with "Cannot use a pool after calling end on the
    // pool", which is a HARNESS failure masquerading as a red result. The
    // shim keeps teardown honest without giving the worker a different
    // database: every query method is the real pool's, so a fix that reads no
    // rows still cannot pass.
    createDbPool: (() =>
      new Proxy(pool, {
        get(target, prop, receiver) {
          if (prop === "end") return async () => undefined;
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      })) as never,
    startWorker: (async () => runtime) as never,
    serve: ((options: {
      fetch: (request: Request) => Response | Promise<Response>;
    }) => {
      handler = options.fetch;
      return { stop: () => undefined };
    }) as never,
  });

  try {
    if (!handler) throw new Error("worker health server was never composed");
    const response = await (
      handler as (request: Request) => Response | Promise<Response>
    )(new Request("http://127.0.0.1:3110/health"));
    return {
      summary,
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  } finally {
    // The real shutdown path runs, including `closePool` — which lands on the
    // no-op `end()` shim above so the suite's pool survives to the next case.
    await processRuntime.shutdown();
  }
}

/** Read the block, failing loudly (not silently passing) when it is absent. */
function requireBlock(body: Record<string, unknown>): EmbedWatermarkBlock {
  const block = body.embed_watermark as EmbedWatermarkBlock | undefined;
  expect(
    block,
    "the DEFAULT worker composition published no embed_watermark block — nothing constructs an observer, so the deployed worker can never alarm (#724 item 3)",
  ).toBeDefined();
  return block as EmbedWatermarkBlock;
}

dbDescribe(
  "nats worker composes a LIVE embed watermark observer by default (#724 item 3)",
  () => {
    beforeAll(async () => {
      pool = new Pool({ connectionString: DB_URL });
      await runMigrations(pool);
    });

    afterEach(async () => {
      await pool.query(`DELETE FROM thoughts WHERE created_by = $1`, [
        CREATED_BY,
      ]);
    });

    afterAll(async () => {
      await pool.end();
    });

    it("the startup summary reports an observer WAS composed with no option passed", async () => {
      // This is the whole gap in one assertion. `embed_watermark_observed` is
      // computed as `Boolean(options.embedWatermarkHealth)`
      // (`scripts/run-nats-worker.ts:345`), and the live entrypoint passes no
      // such option — so today the deployed worker announces `false` and that
      // is the visible signature of the missing wiring.
      await seedThought({
        content: "raw arrival, not yet embedded",
        createdAgoSeconds: 30,
        embeddedAgoSeconds: null,
      });

      const { summary } = await startDefaultWorker();

      expect(
        summary.embed_watermark_observed,
        "startNatsWorkerProcess must construct a real observer when the caller supplies none; the live entrypoint supplies none",
      ).toBe(true);
      expect(summary.embed_watermark_lag_threshold_seconds).toBe(
        THRESHOLD_SECONDS,
      );
    });

    it("STALE — raw newer than embedded past the threshold degrades the worker", async () => {
      // The three-day outage, in rows: raw thoughts keep arriving while the
      // newest embedded row is over three days old. `embedded_at IS NULL` on
      // the recent arrivals is what a drained-by-nobody queue looks like.
      await seedThought({
        content: "old row, embedded three days ago",
        createdAgoSeconds: 259_260,
        embeddedAgoSeconds: 259_200,
      });
      await seedThought({
        content: "fresh raw row, queue never drained",
        createdAgoSeconds: 60,
        embeddedAgoSeconds: null,
      });
      await seedThought({
        content: "another fresh raw row",
        createdAgoSeconds: 20,
        embeddedAgoSeconds: null,
      });

      const { status, body } = await startDefaultWorker();
      const block = requireBlock(body);

      expect(block.stale).toBe(true);
      expect(body.status).toBe("degraded");
      expect(status).toBe(503);

      // Numbers must come from the SEEDED ROWS, not from a constant. The newest
      // raw row was inserted 20s ago and the newest embedded mark 259_200s ago;
      // tolerances absorb runner latency without letting a hard-coded block pass.
      expect(block.newest_raw_age_seconds).toBeGreaterThanOrEqual(19);
      expect(block.newest_raw_age_seconds).toBeLessThan(120);
      expect(block.newest_embedded_age_seconds).toBeGreaterThan(259_000);
      expect(block.lag_seconds).toBeGreaterThan(block.lag_threshold_seconds);
      expect(block.lag_threshold_seconds).toBe(THRESHOLD_SECONDS);
      expect(block.raw_rows_recent).toBeGreaterThan(0);
      expect(block.reason).toBeTruthy();
    });

    it("HEALTHY — an embed lane keeping up within the threshold stays green", async () => {
      // CONTROL. Without it the stale case proves nothing: a surface that
      // reported `degraded` unconditionally would pass that test.
      await seedThought({
        content: "raw row promptly embedded",
        createdAgoSeconds: 120,
        embeddedAgoSeconds: 100,
      });
      await seedThought({
        content: "newer raw row, also embedded",
        createdAgoSeconds: 40,
        embeddedAgoSeconds: 30,
      });

      const { status, body } = await startDefaultWorker();
      const block = requireBlock(body);

      expect(block.stale).toBe(false);
      expect(body.status).toBe("healthy");
      expect(status).toBe(200);
      expect(block.lag_seconds).toBeLessThan(block.lag_threshold_seconds);
      expect(block.newest_embedded_age_seconds).toBeGreaterThanOrEqual(29);
      expect(block.newest_embedded_age_seconds).toBeLessThan(150);
      expect(block.raw_rows_recent).toBeGreaterThan(0);
    });

    it("IDLE CORPUS — no recent raw rows is healthy, with real numbers, not an alarm", async () => {
      // A quiet week produces an old embedded row too, and alarming on that is
      // how a check stops being read (`server/capture/liveness-observer.ts`
      // MIN_SESSIONS_FOR_SILENCE carries the same argument for capture, and
      // #728's `raw_rows_recent` field exists to carry it here). Both rows are
      // ancient and the lag is small — nothing is stalled, nothing is arriving.
      await seedThought({
        content: "ancient row, embedded shortly after it arrived",
        createdAgoSeconds: 604_800,
        embeddedAgoSeconds: 604_740,
      });

      const { status, body } = await startDefaultWorker();
      const block = requireBlock(body);

      expect(block.stale).toBe(false);
      expect(body.status).toBe("healthy");
      expect(status).toBe(200);
      // "Healthy with numbers", not healthy by absence: the block is still
      // published and still reports what it measured.
      expect(block.newest_raw_age_seconds).toBeGreaterThan(600_000);
      expect(block.newest_embedded_age_seconds).toBeGreaterThan(600_000);
      expect(block.raw_rows_recent).toBe(0);
      expect(block.reason).toBeTruthy();
    });
  },
);
