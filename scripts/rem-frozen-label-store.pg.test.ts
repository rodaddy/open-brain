import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { Pool } from "pg";

import { requireTestDatabaseUrl } from "./test-support/require-test-database.ts";
import { FROZEN_COHORT_SIZE, freezeCohort } from "./rem-ethereal-cohort.ts";
import { submitFrozenHumanLabels } from "./rem-frozen-label-store.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const namespace = `frozen-label-store-${process.pid}`;
const sourceTurn = randomUUID();
const candidateIds = Array.from({ length: FROZEN_COHORT_SIZE }, () => randomUUID());
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
let frozenSchema = "";
let frozenSnapshotSha256 = "";
let publicRowsBefore: unknown[] = [];

interface FrozenLabelCandidate {
  candidate_id: string;
  content_hash: string;
}

beforeAll(async () => {
  for (const [index, id] of candidateIds.entries()) {
    const content = `human label fixture ${index}`;
    await pool.query(
      `INSERT INTO public.candidate_memory
         (id, namespace, candidate_type, content, content_hash, source_turn_ids,
          model, unit_kind, uncertain, uncertainty_reason)
       VALUES ($1,$2,'fact',$3,$4,$5::uuid[],'fixture-model','exchange',false,NULL)`,
      [id, namespace, content, sha256(content), [sourceTurn]],
    );
  }
  const frozen = await freezeCohort(pool, namespace);
  frozenSchema = frozen.schema;
  frozenSnapshotSha256 = frozen.fullSnapshotSha256;
  publicRowsBefore = (
    await pool.query(
      "SELECT * FROM public.candidate_memory WHERE namespace = $1 ORDER BY id",
      [namespace],
    )
  ).rows;
});

afterAll(async () => {
  if (frozenSchema) {
    await pool.query(`DROP SCHEMA IF EXISTS ${frozenSchema} CASCADE`);
  }
  await pool.query("DELETE FROM public.candidate_memory WHERE namespace = $1", [
    namespace,
  ]);
  await pool.end();
});

test("rejects missing caller scope and reviewer before database I/O", async () => {
  const connect = vi.fn();
  const database = { connect } as unknown as Pool;
  const label = { candidate_id: randomUUID(), grade: "promoted" };

  await expect(
    submitFrozenHumanLabels(database, {
      schema: "dream_run_001",
      namespace: "",
      gradedBy: "rico",
      expectedSnapshotSha256: "0".repeat(64),
      labels: [label],
    }),
  ).rejects.toThrow();
  await expect(
    submitFrozenHumanLabels(database, {
      schema: "dream_run_001",
      namespace,
      gradedBy: "",
      expectedSnapshotSha256: "0".repeat(64),
      labels: [label],
    }),
  ).rejects.toThrow();
  expect(connect).not.toHaveBeenCalled();
});

test("stores explicit human labels with frozen provenance and rejects a foreign id atomically", async () => {
  const frozen = await pool.query<FrozenLabelCandidate>(
    `SELECT candidate_id, content_hash
       FROM ${frozenSchema}.cohort
      ORDER BY ordinal
      LIMIT 2`,
  );
  const first = frozen.rows[0];
  const second = frozen.rows[1];
  if (!first || !second) throw new Error("frozen fixture is incomplete");

  await expectSnapshotMismatchLeavesNoTable(first.candidate_id);
  await saveInitialLabel(first.candidate_id);
  await expectPersistedLabel(first);
  await correctPersistedLabel(first.candidate_id);
  await expectMidBatchRollback(first.candidate_id, second.candidate_id);
  await expectForeignBatchRollback(first.candidate_id, second.candidate_id);
});

async function expectSnapshotMismatchLeavesNoTable(candidateId: string): Promise<void> {
  await expect(
    submitFrozenHumanLabels(pool, {
      schema: frozenSchema,
      namespace,
      gradedBy: "rico",
      expectedSnapshotSha256: "0".repeat(64),
      labels: [{ candidate_id: candidateId, grade: "rejected" }],
    }),
  ).rejects.toThrow(/snapshot/i);
  const tableAfterMismatch = await pool.query<{ table_name: string | null }>(
    "SELECT to_regclass($1) AS table_name",
    [`${frozenSchema}.human_label`],
  );
  expect(tableAfterMismatch.rows).toEqual([{ table_name: null }]);
}

async function saveInitialLabel(candidateId: string): Promise<void> {
  await expect(
    submitFrozenHumanLabels(pool, {
      schema: frozenSchema,
      namespace,
      gradedBy: "rico",
      expectedSnapshotSha256: frozenSnapshotSha256,
      labels: [
        {
          candidate_id: candidateId,
          grade: "promoted",
          note: "explicit correction",
        },
      ],
    }),
  ).resolves.toEqual({ savedCount: 1 });
}

async function expectMidBatchRollback(
  firstCandidateId: string,
  secondCandidateId: string,
): Promise<void> {
  await pool.query(
    `ALTER TABLE ${frozenSchema}.human_label
       ADD CONSTRAINT reject_second_valid_candidate
       CHECK (candidate_id <> '${secondCandidateId}'::uuid)`,
  );
  await expect(
    submitFrozenHumanLabels(pool, {
      schema: frozenSchema,
      namespace,
      gradedBy: "rico-mid-batch",
      expectedSnapshotSha256: frozenSnapshotSha256,
      labels: [
        { candidate_id: firstCandidateId, grade: "rejected" },
        { candidate_id: secondCandidateId, grade: "promoted" },
      ],
    }),
  ).rejects.toThrow(/reject_second_valid_candidate/i);
  const labelsAfterMidBatchFailure = await pool.query(
    `SELECT candidate_id, grade, note, graded_by
       FROM ${frozenSchema}.human_label
      ORDER BY candidate_id`,
  );
  expect(labelsAfterMidBatchFailure.rows).toEqual([
    {
      candidate_id: firstCandidateId,
      grade: "duplicate",
      note: "explicit replacement",
      graded_by: "rico-corrected",
    },
  ]);
}

async function expectForeignBatchRollback(
  firstCandidateId: string,
  secondCandidateId: string,
): Promise<void> {
  await expect(
    submitFrozenHumanLabels(pool, {
      schema: frozenSchema,
      namespace,
      gradedBy: "rico",
      expectedSnapshotSha256: frozenSnapshotSha256,
      labels: [
        { candidate_id: secondCandidateId, grade: "rejected" },
        { candidate_id: randomUUID(), grade: "inconclusive" },
      ],
    }),
  ).rejects.toThrow(/frozen cohort/i);

  const labelsAfterRejectedBatch = await pool.query(
    `SELECT candidate_id FROM ${frozenSchema}.human_label ORDER BY candidate_id`,
  );
  expect(labelsAfterRejectedBatch.rows).toEqual([{ candidate_id: firstCandidateId }]);
  const corrected = await pool.query(
    `SELECT grade, note, graded_by FROM ${frozenSchema}.human_label`,
  );
  expect(corrected.rows).toEqual([
    {
      grade: "duplicate",
      note: "explicit replacement",
      graded_by: "rico-corrected",
    },
  ]);
  const publicRowsAfter = (
    await pool.query(
      "SELECT * FROM public.candidate_memory WHERE namespace = $1 ORDER BY id",
      [namespace],
    )
  ).rows;
  expect(publicRowsAfter).toEqual(publicRowsBefore);
}

async function expectPersistedLabel(first: {
  candidate_id: string;
  content_hash: string;
}): Promise<void> {
  const manifest = await pool.query<{
    cohort_digest: string;
    full_snapshot_sha256: string;
  }>(
    `SELECT cohort_digest, full_snapshot_sha256
       FROM ${frozenSchema}.manifest
      WHERE run_id = $1`,
    [frozenSchema],
  );
  const saved = await pool.query<{
    run_id: string;
    candidate_id: string;
    namespace: string;
    cohort_digest: string;
    full_snapshot_sha256: string;
    content_hash: string;
    grade: string;
    note: string | null;
    graded_by: string;
    graded_at: Date;
  }>(`SELECT * FROM ${frozenSchema}.human_label`);
  expect(saved.rows).toEqual([
    {
      run_id: frozenSchema,
      candidate_id: first.candidate_id,
      namespace,
      cohort_digest: manifest.rows[0]?.cohort_digest,
      full_snapshot_sha256: manifest.rows[0]?.full_snapshot_sha256,
      content_hash: first.content_hash,
      grade: "promoted",
      note: "explicit correction",
      graded_by: "rico",
      graded_at: expect.any(Date),
    },
  ]);
}

async function correctPersistedLabel(candidateId: string): Promise<void> {
  await expect(
    submitFrozenHumanLabels(pool, {
      schema: frozenSchema,
      namespace,
      gradedBy: "rico-corrected",
      expectedSnapshotSha256: frozenSnapshotSha256,
      labels: [
        {
          candidate_id: candidateId,
          grade: "duplicate",
          note: "explicit replacement",
        },
      ],
    }),
  ).resolves.toEqual({ savedCount: 1 });
}
