/**
 * DONE-MEANS driver (server half) for #680 — a quarantined unit raises a LOUD
 * fault in `/health`, and can never be reported as a healthy empty spool.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT, at this boundary
 * ---------------------------------------------------------------------------
 * `server/capture/liveness-observer.ts:264-265` hardcodes `spoolPending: 0,
 * outageAnnouncements: 0`, and `TransportCaptureHealth`
 * (`server/transport/health.ts:54-78`) has no quarantine field at all. So on
 * 2026-07-30, with 15 real turns abandoned in a sidecar, the live `/health`
 * read `spool_pending:0, reason:"capture lane delivering"` — a green verdict
 * published over a permanent data loss.
 *
 * The module's own docstring argues, correctly for `spool_pending`, that a
 * SERVER cannot enumerate client-side spool files. That argument does NOT
 * extend to quarantine: a quarantine count is not something the server must
 * discover by enumeration, it is something a client REPORTS, exactly as the
 * capture lane already reports its other counts into this observation. The
 * delta is therefore a reported input, not an invented server-side reader.
 *
 * ---------------------------------------------------------------------------
 * SUBJECT: the real judge and the real composition
 * ---------------------------------------------------------------------------
 * Clauses drive `readCaptureLiveness` — the single judge of record, the same
 * function `server/application/index.ts:204` calls — and the verdict clauses
 * bind it to a live HTTP `/health` through the real `createShadowApplication`
 * composition on an ephemeral 127.0.0.1 port. A check that rebuilds its
 * subject proves the rebuild (#624 harvest).
 *
 * Imports of the NEW field/reader are DYNAMIC. A static import of something
 * that does not exist at the pre-fix tree dies at module resolution before any
 * clause prints — a false RED indistinguishable in shape from a real one, and
 * reached by the ordinary act of writing a check for a capability that does
 * not exist yet (docs/lane-contract.md round 18).
 *
 * No database. No network beyond a kernel-assigned ephemeral port. No
 * wall-clock verdict (round 5, #632/#634).
 */
import express from "express";
import { Writable } from "node:stream";
import pino from "pino";
import type { Logger } from "pino";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createShadowApplication } from "../../server/application/index.ts";
import type { ShadowApplication } from "../../server/application/index.ts";
import { parseServerConfig } from "../../server/config.ts";
import type { ServerConfig } from "../../server/config.ts";
import type { Database, DatabaseHealth } from "../../server/db/pool.ts";

const results: Array<{ clause: string; ok: boolean }> = [];

function clause(name: string, ok: boolean, detail: string): void {
  results.push({ clause: name, ok });
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

interface HealthBody {
  readonly capture?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

async function getHealth(
  base: string,
): Promise<{ status: number; body: HealthBody }> {
  const response = await fetch(`${base}/health`);
  return {
    status: response.status,
    body: (await response.json()) as HealthBody,
  };
}

/**
 * A healthy delivering observation — the CONTROL baseline every fault clause
 * mutates one field of. Built as a plain object so a missing quarantine field
 * at the pre-fix tree is a value-level absence, never an import failure.
 */
function deliveringObservation(): Record<string, unknown> {
  return {
    sessionsObserved: 4,
    watermarkBytesAdvanced: 120,
    spoolPending: 0,
    outageAnnouncements: 0,
    turnsByRole: { user: 60, assistant: 60 },
    silenceSeconds: 5,
  };
}

async function main(): Promise<number> {
  const observer = await import("../../server/capture/liveness-observer.ts");
  const readCaptureLiveness = observer.readCaptureLiveness as (
    o: Record<string, unknown> | undefined,
  ) => Record<string, unknown> | undefined;

  // --------------------------------------------------------------------
  // (a) THE JUDGE SEES QUARANTINE AT ALL. A quarantined unit reported by
  // the capture lane must make the reading STALE and must be named in the
  // reason. At the pre-fix tree the field does not exist in the shape, so
  // the judge ignores it entirely and returns "capture lane delivering" —
  // the exact live 2026-07-30 verdict published over 15 lost turns.
  // --------------------------------------------------------------------
  const quarantinedReading = readCaptureLiveness({
    ...deliveringObservation(),
    spoolQuarantined: 3,
  });
  const staleOnQuarantine = quarantinedReading?.stale === true;
  const reason = String(quarantinedReading?.reason ?? "");
  clause(
    "a-quarantine-is-stale",
    staleOnQuarantine && /quarantin/i.test(reason),
    `an observation carrying 3 quarantined unit(s) reads stale=${String(
      quarantinedReading?.stale,
    )} reason=${JSON.stringify(reason)}`,
  );

  // --------------------------------------------------------------------
  // (b) THE COUNT IS PUBLISHED, not merely folded into a boolean. An
  // operator deciding replay-vs-accept needs the number; a bare "stale"
  // flag makes them go and read the sidecar to learn the size of the loss.
  // Asserts the exact value survives to the block, so an implementation
  // that clamps or booleans it fails.
  // --------------------------------------------------------------------
  clause(
    "b-count-published",
    quarantinedReading?.quarantined_count === 3,
    `the block publishes quarantined_count=${JSON.stringify(
      quarantinedReading?.quarantined_count,
    )} (expected the reported 3)`,
  );

  // --------------------------------------------------------------------
  // (c) CONTROL — a delivering lane with NOTHING quarantined stays GREEN
  // and still publishes the field as a real zero. Fails any implementation
  // that shouts on every reading, and any that omits the field when it is
  // zero (an absent field is unreadable to a monitor that must alert on
  // it crossing 0 -> 1). PASSES PRE-FIX for the verdict half by design:
  // a check that fails everywhere proves only that it fails (round 13).
  // --------------------------------------------------------------------
  const healthyReading = readCaptureLiveness({
    ...deliveringObservation(),
    spoolQuarantined: 0,
  });
  clause(
    "c-control-healthy-green",
    healthyReading?.stale === false &&
      healthyReading?.quarantined_count === 0 &&
      !/quarantin/i.test(String(healthyReading?.reason ?? "")),
    `a delivering lane with nothing quarantined reads stale=${String(
      healthyReading?.stale,
    )} quarantined_count=${JSON.stringify(
      healthyReading?.quarantined_count,
    )} reason=${JSON.stringify(String(healthyReading?.reason ?? ""))}`,
  );

  // --------------------------------------------------------------------
  // (d) UNOBSERVABLE IS ANNOUNCED, NOT ZEROED. The module already
  // publishes `observableFaults` so a green block is not misread as "all
  // faults checked and clear". A vantage point with no quarantine input
  // must NOT report a confident 0 — that is precisely the shape of the
  // defect (a hardcoded 0 standing in for an unmeasured quantity). Absent
  // input reports the field as absent/undefined, never 0.
  // --------------------------------------------------------------------
  const unreportedReading = readCaptureLiveness(deliveringObservation());
  clause(
    "d-unobserved-is-not-zero",
    unreportedReading?.stale === false &&
      unreportedReading?.quarantined_count === undefined,
    `an observation that reports NO quarantine input publishes quarantined_count=${JSON.stringify(
      unreportedReading?.quarantined_count,
    )} (absent, not a fabricated 0)`,
  );

  // --------------------------------------------------------------------
  // (e) IT REACHES A LIVE /health, DEGRADED. The judge being right is not
  // the promise; the promise is that an operator watching the endpoint
  // sees it. Drives the REAL composition over real HTTP and asserts both
  // the transport status and the published block.
  // --------------------------------------------------------------------
  const { logger } = capturingLogger();
  const app = await listen(
    {
      captureObserver: () => ({
        ...deliveringObservation(),
        spoolQuarantined: 3,
      }),
    },
    logger,
  );
  try {
    const health = await getHealth(app.base);
    const capture = health.body.capture ?? {};
    clause(
      "e-live-health-degraded",
      health.status === 503 &&
        capture.stale === true &&
        capture.quarantined_count === 3 &&
        /quarantin/i.test(String(capture.reason ?? "")),
      `live GET /health -> ${health.status} with capture.stale=${String(
        capture.stale,
      )} capture.quarantined_count=${JSON.stringify(
        capture.quarantined_count,
      )} reason=${JSON.stringify(String(capture.reason ?? ""))}`,
    );
  } finally {
    await app.close();
  }

  // --------------------------------------------------------------------
  // (f) CONTROL — ABSENCE IS NOT STALENESS survives the change. A
  // deployment composing no capture observer publishes no block and stays
  // 200/green. PASSES PRE-FIX by design (rounds 8 and 13): the point is
  // that this fix does not make an opted-out worker degrade itself.
  // --------------------------------------------------------------------
  const { logger: bareLogger } = capturingLogger();
  const bare = await listen({}, bareLogger);
  try {
    const health = await getHealth(bare.base);
    clause(
      "f-control-absence-not-staleness",
      health.status === 200 && health.body.capture === undefined,
      `a deployment composing no observer -> ${health.status} with no capture block`,
    );
  } finally {
    await bare.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log();
  if (failed.length > 0) {
    console.log(
      `SERVER-HALF FAIL — ${failed.length} clause(s): ${failed
        .map((r) => r.clause)
        .join(", ")}`,
    );
    return 1;
  }
  console.log("SERVER-HALF PASS — a quarantined unit is a loud, counted fault in /health.");
  return 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    // A top-level await with no .catch exits 0 when it throws — a crashing
    // subject banking a false GREEN (docs/lane-contract.md round 13).
    console.error(
      `SERVER-HALF ERROR — driver crashed: ${
        error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      }`,
    );
    process.exit(1);
  });
