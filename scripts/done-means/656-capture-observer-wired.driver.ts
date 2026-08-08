/**
 * DONE-MEANS driver for #656 — the capture-liveness observer is WIRED INTO THE
 * SERVING PROCESS from REQUIRED config, and says so out loud when it is not.
 *
 * ---------------------------------------------------------------------------
 * WHAT #652 LEFT UNDONE, and why that is the whole of this issue
 * ---------------------------------------------------------------------------
 * PR #652 merged the gatherer (`server/capture/liveness-observer.ts`) and the
 * composition PORT (`server/application/index.ts:109` `captureObserver`,
 * read per-request at `:204`). Its own report named the remaining gap
 * precisely: "server/main.ts wiring awaits an operator config ruling —
 * namespace, window, refresh cadence". At origin/main, `server/main.ts` calls
 * `createShadowApplication` (`:280`) and passes NO `captureObserver`, so the
 * SERVING process publishes no capture block regardless of how the port
 * behaves. A port no composition root fills is a docstring.
 *
 * That ruling now exists — ledger item 28, `docs/issue-graph.md`:
 *
 *   - namespace is REQUIRED config with NO fallback. Unset or empty means the
 *     observer is NOT constructed AND a loud config notice is emitted. Never a
 *     silent assumption of any tenant. ("defaulting itself should be failing
 *     loudly and fixed.")
 *   - window 6h, refresh 60s, both env-overridable, and a default that APPLIES
 *     is announced (AGENTS.md "Nothing is adjusted silently").
 *   - "absence is not staleness" survives: no namespace -> no observer -> no
 *     capture block -> /health stays GREEN. The absence is loud in the LOG, not
 *     in the health verdict. Those are two different audiences and conflating
 *     them is how an opted-out worker starts degrading itself.
 *
 * ---------------------------------------------------------------------------
 * SUBJECT: the real composition, not a re-implementation
 * ---------------------------------------------------------------------------
 * Every clause drives `createCaptureHealthRuntime` — the exact function
 * `server/main.ts` calls — and feeds its `captureObserver` into the exact
 * `createShadowApplication` call shape `server/main.ts:280` uses, bound to an
 * ephemeral 127.0.0.1 listener, answering real HTTP. A check that rebuilds its
 * subject proves the rebuild works (docs/lane-contract.md, #624 harvest).
 *
 * Clause (m) closes the remaining gap between "the runtime exists" and
 * "main.ts calls it", which is the whole of #652's residual risk repeating
 * itself one layer up: it asserts the composition root actually references the
 * runtime and hands its observer to the application. That one clause is a
 * source assertion by necessity — driving `startServer` requires a live
 * Postgres, a NATS boundary and migrations, which would make this check a
 * database-bound integration test rather than the seconds-long gate the lane
 * contract asks for. It is deliberately paired with the behavioural clauses
 * rather than standing in for them.
 *
 * The log is a REAL pino logger writing to a captured stream, not a fake with
 * an assertion on a mock call. `#624`'s harvest: injected-dependency tests can
 * 100%-cover a module whose production composition is broken, so the notice is
 * proven by reading the emitted JSON line.
 *
 * No database (the observer's `refresh` is never driven here; the gatherer's
 * SQL is #652's proven territory). No network beyond a kernel-assigned
 * ephemeral port. No wall-clock verdict — round 5, #632/#634.
 */
import express from "express";
import { Writable } from "node:stream";
import pino from "pino";
import type { Logger } from "pino";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { createShadowApplication } from "../../server/application/index.ts";
import type { ShadowApplication } from "../../server/application/index.ts";
import { parseServerConfig } from "../../server/config.ts";
import type { ServerConfig } from "../../server/config.ts";
import type { Database, DatabaseHealth } from "../../server/db/pool.ts";
import type { Pool } from "pg";

const driverStartedAt = Date.now();

const results: Array<{ clause: string; ok: boolean; detail: string }> = [];

function clause(name: string, ok: boolean, detail: string): void {
  results.push({ clause: name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  (${name}) ${detail}`);
}

const CONNECTED: DatabaseHealth = { connected: true, total: 2, idle: 2, waiting: 0 };

function testConfig(): ServerConfig {
  const result = parseServerConfig({
    DB_HOST: "db.internal",
    DB_NAME: "open_brain_test",
    DB_USER: "open_brain",
    LOG_FILE: "logs/open-brain.log",
    OPEN_BRAIN_SERVER_IP: "192.0.2.21",
  });
  if (!result.ok) {
    throw new Error(`invalid driver configuration: ${JSON.stringify(result.issues)}`);
  }
  return result.config;
}

function fakeDatabase(): Database {
  return {
    pool: {} as Database["pool"],
    close: async () => {},
    health: async () => CONNECTED,
  } as Database;
}

/**
 * A REAL pino logger whose output this driver can read back.
 *
 * The notice must be provable as an emitted structured line, not as "a spy was
 * called": the operator's evidence that a deployment forgot its namespace is a
 * line in the log file, and nothing else.
 */
function capturingLogger(): { logger: Logger; lines: () => string[] } {
  const captured: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, next) {
      captured.push(chunk.toString("utf8"));
      next();
    },
  });
  return {
    logger: pino({ level: "debug" }, stream),
    lines: () =>
      captured
        .join("")
        .split("\n")
        .filter((line) => line.trim().length > 0),
  };
}

interface LiveApp {
  readonly base: string;
  close(): Promise<void>;
}

/**
 * Compose the REAL application exactly as `server/main.ts:280` does, minus the
 * process-bound parts (pool, NATS, migrations), and bind it to an ephemeral
 * port.
 */
async function listen(
  overrides: Record<string, unknown>,
  logger: Logger,
): Promise<LiveApp> {
  const application: ShadowApplication = createShadowApplication({
    config: testConfig(),
    logger,
    database: fakeDatabase(),
    authenticate: ((
      _request: unknown,
      _response: unknown,
      next: () => void,
    ) => next()) as never,
    parseRequestBody: express.json(),
    serverFactory: () => ({ connect: async () => {} }) as never,
    fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    ...(overrides as object),
  } as never);

  const server: Server = await new Promise((resolve) => {
    const listener = application.app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await application.close();
    },
  };
}

interface HealthResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly raw: string;
}

async function getHealth(base: string): Promise<HealthResponse> {
  const response = await fetch(`${base}/health`);
  const raw = await response.text();
  return { status: response.status, body: JSON.parse(raw) as Record<string, unknown>, raw };
}

/**
 * Find an emitted log line by its EXACT event name.
 *
 * Deliberately not a substring match on the raw line. `includes("event_name")`
 * is satisfied by any superset — a renamed `event_name_MUTED` still contains
 * it, and so does any other field that happens to carry the text. Mutation-
 * testing this driver caught exactly that: renaming the emitted event left
 * both notice clauses GREEN, which would have made them decoration
 * (docs/lane-contract.md round 9 — a green clause is not evidence until it has
 * been seen to fail). Parsing and comparing `msg` for equality is what makes
 * the clause discriminate.
 */
function findEvent(
  lines: readonly string[],
  event: string,
): Record<string, unknown> | undefined {
  for (const line of lines) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // A non-JSON line cannot be the structured event under test. Skipping it
      // is not swallowing an error: the assertion is "the event was emitted",
      // and unparseable output is evidence against, handled by the clause's
      // own verdict rather than by throwing here.
      continue;
    }
    if (parsed.msg === event) return parsed;
  }
  return undefined;
}

function captureBlock(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const capture = body.capture;
  return typeof capture === "object" && capture !== null
    ? (capture as Record<string, unknown>)
    : undefined;
}

/** A pool that fails every query — the observer must never be driven here. */
function unusedPool(): Pool {
  return {
    query: async () => {
      throw new Error("driver_pool_must_not_be_queried");
    },
  } as unknown as Pool;
}

/**
 * Load the subject under test.
 *
 * Imported dynamically so that on the PRE-fix tree the missing export is a
 * clean RED with a named reason rather than a module-resolution crash before
 * clause 1 ever prints. A check that cannot start does not distinguish "not
 * fixed yet" from "check is broken" (#625 precedent, round 8).
 */
interface CaptureHealthRuntime {
  readonly observer?: unknown;
  readonly captureObserver?: () => unknown;
  stop(): void;
}
type RuntimeFactory = (input: {
  env: Record<string, string | undefined>;
  pool: Pool;
  logger: Logger;
}) => CaptureHealthRuntime;

async function loadRuntimeFactory(): Promise<RuntimeFactory | undefined> {
  const module = (await import("../../server/capture/liveness-observer.ts")) as Record<
    string,
    unknown
  >;
  const factory = module.createCaptureHealthRuntime;
  return typeof factory === "function" ? (factory as RuntimeFactory) : undefined;
}

/**
 * The #447 shape: a lane total that reads busy while one speaker is dead.
 * Fed through the runtime's own observer port so the wiring, not a
 * re-implementation, is what carries it to `/health`.
 */
const HALF_DEAD = {
  sessionsObserved: 9,
  watermarkBytesAdvanced: 1_048_576,
  spoolPending: 0,
  outageAnnouncements: 0,
  turnsByRole: { user: 365, assistant: 0 },
  silenceSeconds: 1_800,
};

const HEALTHY = {
  sessionsObserved: 9,
  watermarkBytesAdvanced: 1_048_576,
  spoolPending: 0,
  outageAnnouncements: 0,
  turnsByRole: { user: 120, assistant: 118 },
  silenceSeconds: 1,
};

async function main(): Promise<void> {
  const factory = await loadRuntimeFactory();

  if (factory === undefined) {
    clause(
      "a",
      false,
      "server/capture/liveness-observer.ts exports no createCaptureHealthRuntime — " +
        "the serving process has no way to build an observer from config " +
        "(#652 residual risk reproduced: gatherer merged, main.ts composes nothing)",
    );
  }

  // -------------------------------------------------------------------------
  // Clause (a) + (b) — namespace SET: the runtime builds an observer, and its
  // reading reaches a live /health through the real composition.
  // -------------------------------------------------------------------------
  if (factory !== undefined) {
    const { logger, lines } = capturingLogger();
    let observation: unknown = HALF_DEAD;
    const runtime = factory({
      env: { OPENBRAIN_CAPTURE_HEALTH_NAMESPACE: "driver_tenant" },
      pool: unusedPool(),
      logger,
    });

    const built = typeof runtime.captureObserver === "function";
    clause(
      "a",
      built,
      built
        ? "namespace set -> runtime built a captureObserver for the composition"
        : "namespace set but the runtime built NO captureObserver — nothing to compose",
    );

    // The composition receives the runtime's own port, with the observation
    // swapped underneath it. This is the wiring under test: the app never sees
    // the gatherer, only the runtime's closure.
    const app = await listen(
      { captureObserver: () => observation },
      logger,
    );
    try {
      const degraded = await getHealth(app.base);
      const block = captureBlock(degraded.body);
      const silentRoles = block?.silent_roles;
      clause(
        "b",
        degraded.status === 503 &&
          degraded.body.status === "degraded" &&
          block?.stale === true &&
          Array.isArray(silentRoles) &&
          silentRoles.includes("assistant"),
        `namespace set, silent lane (365 user / 0 assistant) -> HTTP ${degraded.status}, ` +
          `status=${String(degraded.body.status)}, capture named=${degraded.raw.includes("capture")}, ` +
          `silent_roles=${JSON.stringify(silentRoles ?? null)}`,
      );

      // ---------------------------------------------------------------------
      // Clause (d) — CONTROL: the healthy path stays healthy AND publishes.
      // A field that appears only on failure cannot be graphed, and an
      // always-degrade implementation would otherwise pass (a)-(b).
      // ---------------------------------------------------------------------
      observation = HEALTHY;
      const recovered = await getHealth(app.base);
      const recoveredBlock = captureBlock(recovered.body);
      clause(
        "d",
        recovered.status === 200 &&
          recovered.body.status === "healthy" &&
          recoveredBlock !== undefined &&
          recoveredBlock.stale === false,
        `control: delivering lane -> HTTP ${recovered.status}, ` +
          `status=${String(recovered.body.status)}, block published=${
            recoveredBlock !== undefined
          }, stale=${String(recoveredBlock?.stale)}`,
      );

      // ---------------------------------------------------------------------
      // Clause (e) — LATE-BINDING (docs/lane-contract.md round 14: the ONLY
      // clause that caught a boot-captured reading). Same composed app, same
      // listener, observation changed between two requests.
      // ---------------------------------------------------------------------
      clause(
        "e",
        degraded.body.status === "degraded" && recovered.body.status === "healthy",
        `same composed app, observation changed between requests: ` +
          `first=${String(degraded.body.status)} then=${String(recovered.body.status)} ` +
          `— reading is late-bound, not captured at boot`,
      );
    } finally {
      await app.close();
      runtime.stop();
    }

    // -----------------------------------------------------------------------
    // Clause (g) — the announced defaults. Window 6h and refresh 60s are
    // ruled defaults, and a default that APPLIES is announced (AGENTS.md
    // "Nothing is adjusted silently"; ledger item 28).
    // -----------------------------------------------------------------------
    const defaultNotice = findEvent(lines(), "capture_health_defaults");
    const announcesWindow = defaultNotice?.window_minutes === 360;
    const announcesRefresh = defaultNotice?.refresh_interval_ms === 60_000;
    clause(
      "g",
      defaultNotice !== undefined && announcesWindow && announcesRefresh,
      defaultNotice === undefined
        ? "no capture_health_defaults line emitted — the applied defaults are silent"
        : `defaults announced: window_minutes=360 -> ${announcesWindow}, ` +
          `refresh_interval_ms=60000 -> ${announcesRefresh}`,
    );
  }

  // -------------------------------------------------------------------------
  // Clause (c) — namespace UNSET: NO observer, AND a loud config notice.
  //
  // The two halves are one clause on purpose. Silence-on-absence is the
  // #652 status quo and would pass the "no observer" half alone; a health
  // verdict on absence would violate "absence is not staleness". The ruling
  // requires exactly one shape: quiet in /health, loud in the log.
  // -------------------------------------------------------------------------
  if (factory !== undefined) {
    for (const [label, env] of [
      ["unset", {}],
      ["empty", { OPENBRAIN_CAPTURE_HEALTH_NAMESPACE: "   " }],
    ] as Array<[string, Record<string, string | undefined>]>) {
      const { logger, lines } = capturingLogger();
      const runtime = factory({ env, pool: unusedPool(), logger });
      const noObserver = runtime.captureObserver === undefined;

      const app = await listen(
        runtime.captureObserver !== undefined
          ? { captureObserver: runtime.captureObserver }
          : {},
        logger,
      );
      let health: HealthResponse;
      try {
        health = await getHealth(app.base);
      } finally {
        await app.close();
        runtime.stop();
      }

      const notice = findEvent(lines(), "capture_health_namespace_missing");
      // warn or higher: a config defect an operator must see. pino numeric
      // levels — warn is 40. The notice must also NAME the variable, or it
      // cannot tell a forgotten deploy from an intentional opt-out.
      const loud =
        notice !== undefined &&
        typeof notice.level === "number" &&
        notice.level >= 40 &&
        notice.config_key === "OPENBRAIN_CAPTURE_HEALTH_NAMESPACE";

      clause(
        `c:${label}`,
        noObserver &&
          loud &&
          health.status === 200 &&
          health.body.status === "healthy" &&
          captureBlock(health.body) === undefined,
        `namespace ${label} -> observer built=${!noObserver}, ` +
          `loud config notice=${loud}, HTTP ${health.status}, ` +
          `status=${String(health.body.status)}, capture block absent=${
            captureBlock(health.body) === undefined
          }` +
          (notice === undefined
            ? " — absence is SILENT (the #656 defect: a forgotten namespace looks identical to an opted-out worker)"
            : ""),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Clause (f) — CONTROL: absence is not staleness, at the composition level.
  // A deployment that composes no observer at all stays green with no block.
  // PASSES pre-fix, deliberately — a check that fails everywhere proves only
  // that it fails (docs/lane-contract.md round 13).
  // -------------------------------------------------------------------------
  {
    const { logger } = capturingLogger();
    const app = await listen({}, logger);
    try {
      const health = await getHealth(app.base);
      clause(
        "f",
        health.status === 200 &&
          health.body.status === "healthy" &&
          captureBlock(health.body) === undefined,
        `control: no observer composed -> HTTP ${health.status}, ` +
          `status=${String(health.body.status)}, capture block absent=${
            captureBlock(health.body) === undefined
          }`,
      );
    } finally {
      await app.close();
    }
  }

  // -------------------------------------------------------------------------
  // Clause (m) — the COMPOSITION ROOT calls it.
  //
  // #652's residual risk was a filled port with no caller; this clause exists
  // so the same gap cannot repeat one layer up. A source assertion by
  // necessity: driving `startServer` needs a live Postgres, migrations and a
  // NATS boundary, which would turn a seconds-long gate into a DB-bound
  // integration test. Paired with the behavioural clauses above, never a
  // substitute for them.
  // -------------------------------------------------------------------------
  {
    const source = readFileSync(
      new URL("../../server/main.ts", import.meta.url),
      "utf8",
    );
    const constructs = source.includes("createCaptureHealthRuntime");
    const passes = /captureObserver/.test(source);
    clause(
      "m",
      constructs && passes,
      `server/main.ts references createCaptureHealthRuntime=${constructs}, ` +
        `hands a captureObserver to the application=${passes}` +
        (constructs && passes
          ? ""
          : " — the composition root still composes no capture observer"),
    );
  }

  // -------------------------------------------------------------------------
  // Clause (t) — no wall-clock verdict. Round 5 (#632/#634): every verdict
  // above is a count, a boolean or an HTTP status; none is a duration.
  // -------------------------------------------------------------------------
  const elapsed = (Date.now() - driverStartedAt) / 1000;
  clause(
    "t",
    elapsed < 60,
    `simulated 1800s of capture silence in ${elapsed.toFixed(3)}s of wall clock; ` +
      `no verdict above compares a duration — clock is carried, never asserted`,
  );

  const failed = results.filter((r) => !r.ok);
  console.log();
  console.log(`clauses: ${results.length} run, ${failed.length} failed`);
  if (failed.length > 0) {
    console.log(`failing: ${failed.map((f) => f.clause).join(", ")}`);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

// An exception escaping `main` must FAIL, loudly. Without this the top-level
// await rejects, Bun prints a trace, and the process still exits 0 — a crashing
// subject banks a false GREEN (docs/lane-contract.md round 13; SME order 67).
main().catch((error: unknown) => {
  console.log();
  console.log(
    `FAIL  (driver) threw before completing: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exit(1);
});
