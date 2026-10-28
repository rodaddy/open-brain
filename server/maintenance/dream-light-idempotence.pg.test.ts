/**
 * DREAM Light idempotence (issue 1469, gap G2).
 *
 * Light stamps `ob_raw_turns.light_swept_at` so a turn is never counted twice.
 * This proves the stamp actually holds: a second sweep over the same turns
 * claims nothing, creates no `content_occurrences` row, and moves no existing
 * count or timestamp. Live Postgres, no mocks — the claim predicate and the
 * upsert are exactly what is under test.
 */

import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../scripts/test-support/require-test-database.ts";
import type { MaintenanceQueueLogger } from "./maintenance-queue-runner.ts";
import { runLightSweep } from "./dream-light.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const namespace = `dream-light-idem-${process.pid}`;
const content = "Idempotence means the second sweep changes nothing at all.";
const turnIds = [randomUUID(), randomUUID()];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const logger: MaintenanceQueueLogger = {
  info() {},
  warn() {},
  error() {},
};

async function insertTurn(input: { id: string; session: string; sequence: number }) {
  await pool.query(
    `INSERT INTO ob_raw_turns
       (id, namespace, turn_uuid, session_ref, turn_index, session_seq, role,
        is_human_prompt, content, metadata, content_hash, runtime,
        redaction_applied, distilled_at, created_by, occurred_at, retention_tier, repo)
     VALUES ($1, $2, $6, $3, $4, $4, 'user', true, $5, '{}'::jsonb, $7,
             'dream-light-idem-fixture', '[]'::jsonb, now(), 'dream-light-idem-fixture',
             now() + make_interval(secs => $4::integer), 'live', 'rodaddy/open-brain')`,
    [
      input.id,
      namespace,
      input.session,
      input.sequence,
      content,
      `${input.id}-turn`,
      hash(content),
    ],
  );
}

interface OccurrenceState {
  rows: { content_hash: string; occurrence_count: string; session_count: string }[];
  swept: { id: string; light_swept_at: Date | null }[];
}

async function readState(): Promise<OccurrenceState> {
  const occurrences = await pool.query<OccurrenceState["rows"][number]>(
    `SELECT content_hash, occurrence_count::text, session_count::text
       FROM content_occurrences WHERE namespace = $1 ORDER BY content_hash`,
    [namespace],
  );
  const turns = await pool.query<OccurrenceState["swept"][number]>(
    `SELECT id, light_swept_at FROM ob_raw_turns WHERE namespace = $1 ORDER BY id`,
    [namespace],
  );
  return { rows: occurrences.rows, swept: turns.rows };
}

beforeAll(async () => {
  await insertTurn({
    id: turnIds[0] as string,
    session: `${namespace}-a`,
    sequence: 1,
  });
  await insertTurn({
    id: turnIds[1] as string,
    session: `${namespace}-b`,
    sequence: 2,
  });
});

afterAll(async () => {
  await pool.query("DELETE FROM content_occurrences WHERE namespace = $1", [namespace]);
  await pool.query("DELETE FROM ob_raw_turns WHERE namespace = $1", [namespace]);
  await pool.end();
});

test("a second Light sweep over the same turns sweeps nothing and changes nothing", async () => {
  // The sweep is global, and the shared suite database can hold unswept turns
  // other files left behind, so drain the queue rather than trust one batch.
  let scanned = 0;
  for (;;) {
    const pass = await runLightSweep({ pool, logger, batchSize: 10 });
    if (pass.scanned === 0) break;
    scanned += pass.scanned;
  }
  expect(scanned).toBeGreaterThanOrEqual(turnIds.length);

  const before = await readState();
  expect(before.rows).toHaveLength(1);
  expect(before.swept.every((turn) => turn.light_swept_at !== null)).toBe(true);

  const second = await runLightSweep({ pool, logger, batchSize: 10 });
  expect(second).toEqual({
    scanned: 0,
    skipped_noise: 0,
    created: 0,
    updated: 0,
    corroborated: 0,
  });

  const after = await readState();
  expect(after.rows).toEqual(before.rows);
  expect(after.swept).toEqual(before.swept);
});
