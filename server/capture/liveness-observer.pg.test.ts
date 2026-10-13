/**
 * Live-Postgres tests for the capture observer's namespace check (issue 682).
 *
 * A namespace that never existed (a typo in OPENBRAIN_CAPTURE_HEALTH_NAMESPACE)
 * used to read exactly like a quiet night: an empty window published nothing
 * and `/health` stayed green forever. These tests drive the real gather query
 * against real `ob_raw_turns` rows, because the property under test is the
 * "has this namespace ever had a row" lookup, which a fake pool cannot prove.
 *
 * REQUIRES the test database, and fails hard without it (issue 878).
 * `npm run test:isolated` supplies it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../db/migrate.ts";
import { silentLogger } from "../transport/testing/silent-logger.ts";
import { requireTestDatabaseUrl } from "../../scripts/test-support/require-test-database.ts";
import {
  CAPTURE_HEALTH_NAMESPACE_ENV,
  createCaptureLivenessObserver,
  readCaptureLiveness,
} from "./liveness-observer.ts";

// Per-process namespace so concurrent runs on a shared database cannot collide.
const KNOWN_NS = `ns-liveness-682-${process.pid}`;
const TYPO_NS = `ns-livenes-682-typo-${process.pid}`;

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

beforeAll(async () => {
  await runMigrations(pool);
  // One row, two days old: the namespace is KNOWN, but the window is empty.
  await pool.query(
    `INSERT INTO ob_raw_turns
       (namespace, turn_uuid, session_ref, turn_index, role, content,
        content_hash, created_by, created_at)
     VALUES ($1, $2, 'sess-682', 0, 'user', 'hello', 'hash-682',
             'liveness-682-test', now() - interval '2 days')`,
    [KNOWN_NS, `turn-682-${process.pid}`],
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM ob_raw_turns WHERE namespace = $1`, [KNOWN_NS]);
  await pool.end();
});

function observerFor(namespace: string) {
  return createCaptureLivenessObserver(
    { pool, logger: silentLogger(), window: { windowMinutes: 60, namespace } },
    { autoStart: false },
  );
}

describe("capture liveness namespace check (live Postgres)", () => {
  it("reports a misspelled namespace as degraded and names the value", async () => {
    const subject = observerFor(TYPO_NS);
    await subject.refresh();
    const reading = readCaptureLiveness(subject.observation());
    expect(reading?.stale).toBe(true);
    expect(reading?.reason).toContain(TYPO_NS);
    expect(reading?.reason).toContain(CAPTURE_HEALTH_NAMESPACE_ENV);
  });

  it("still publishes nothing for a known namespace with a quiet window", async () => {
    const subject = observerFor(KNOWN_NS);
    await subject.refresh();
    expect(subject.observation()).toBeUndefined();
    expect(subject.reading()).toBeUndefined();
  });
});
