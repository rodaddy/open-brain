import { createHash, randomUUID } from "node:crypto";
import { env } from "node:process";
import { afterAll, beforeAll, expect, test } from "vitest";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../scripts/test-support/require-test-database.ts";
import { createDreamDeepRepository } from "../db/dream-deep-repository.ts";
import { createDreamRemGradingRepository } from "../db/dream-rem-grading-repository.ts";
import type { DreamRemGradingRepository } from "../db/dream-rem-grading-repository.ts";
import { createDreamRemRepository } from "../db/dream-rem-repository.ts";
import type { MaintenanceQueueLogger } from "./maintenance-queue-runner.ts";
import { buildReviewBundles } from "./dream-deep.ts";
import { runLightSweep } from "./dream-light.ts";
import { runRemPass, type NamedRemGrader } from "./dream-rem.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const owner = `dream-chain-${process.pid}`;
const foreign = `${owner}-foreign`;
const ownerContent = "Use exact source attribution for durable DREAM bundles.";
const foreignContent = "Foreign namespace content must remain private.";
const ids = {
  ownerA: randomUUID(),
  ownerB: randomUUID(),
  foreign: randomUUID(),
  foreignContext: randomUUID(),
};
const candidates = { owner: randomUUID(), foreign: randomUUID() };
const hash = (content: string) => createHash("sha256").update(content).digest("hex");
const logger: MaintenanceQueueLogger = {
  info() {},
  warn() {},
  error() {},
};
const grader: NamedRemGrader = {
  name: "dream-chain-fixture-v1",
  grade: () => ({
    grade: "promoted",
    reason: "deterministic acceptance fixture",
    graderName: "jev-served/rem-label-score-v2",
    decision: {
      label: "DECISION",
      score: 9,
      decisionSource: "jev-served/rem-label-score-v2",
      rubricVersion: "rem-label-score-v2",
    },
  }),
};

async function insertTurn(input: {
  id: string;
  namespace: string;
  session: string;
  sequence: number;
  content: string;
}) {
  await pool.query(
    `INSERT INTO ob_raw_turns
       (id, namespace, turn_uuid, session_ref, turn_index, session_seq, role,
        is_human_prompt, content, metadata, content_hash, runtime,
        redaction_applied, distilled_at, created_by, occurred_at, retention_tier, repo)
     VALUES ($1, $2, $7, $3, $4, $4, 'user', true, $5, '{}'::jsonb, $6,
             'dream-chain-fixture', '[]'::jsonb, now(), 'dream-chain-fixture',
             now() + make_interval(secs => $4::integer), 'live', 'rodaddy/open-brain')`,
    [
      input.id,
      input.namespace,
      input.session,
      input.sequence,
      input.content,
      hash(input.content),
      `${input.id}-turn`,
    ],
  );
}

beforeAll(async () => {
  await insertTurn({
    id: ids.ownerA,
    namespace: owner,
    session: `${owner}-a`,
    sequence: 1,
    content: ownerContent,
  });
  await insertTurn({
    id: ids.ownerB,
    namespace: owner,
    session: `${owner}-b`,
    sequence: 1,
    content: ownerContent,
  });
  await insertTurn({
    id: ids.foreign,
    namespace: foreign,
    session: `${owner}-a`,
    sequence: 2,
    content: foreignContent,
  });
  await insertTurn({
    id: ids.foreignContext,
    namespace: foreign,
    session: `${owner}-a`,
    sequence: 3,
    content: foreignContent,
  });
  await pool.query(
    `INSERT INTO candidate_memory
       (id, namespace, candidate_type, content, content_hash, source_turn_ids, model, authority_tier)
     VALUES ($1, $2, 'fact', $3, $4, $5::uuid[], 'dream-chain-fixture', 'observed'),
            ($6, $7, 'fact', $8, $9, $10::uuid[], 'dream-chain-fixture', 'observed')`,
    [
      candidates.owner,
      owner,
      ownerContent,
      hash(ownerContent),
      [ids.ownerA, ids.foreign],
      candidates.foreign,
      foreign,
      foreignContent,
      hash(foreignContent),
      [ids.foreign],
    ],
  );
});

afterAll(async () => {
  await pool.query("DELETE FROM candidate_memory WHERE namespace = ANY($1::text[])", [
    [owner, foreign],
  ]);
  await pool.query(
    "DELETE FROM content_occurrences WHERE namespace = ANY($1::text[])",
    [[owner, foreign]],
  );
  await pool.query("DELETE FROM ob_raw_turns WHERE namespace = ANY($1::text[])", [
    [owner, foreign],
  ]);
  await pool.end();
});

async function expectMachineGradeGuards(
  grading: DreamRemGradingRepository,
): Promise<void> {
  const decision = {
    candidateId: candidates.foreign,
    namespace: owner,
    grade: "promoted",
    graderName: "jev-served/rem-label-score-v2",
    reason: null,
    decision: {
      label: "DECISION",
      score: 10,
      decisionSource: "jev-served/rem-label-score-v2",
      rubricVersion: "rem-label-score-v2",
    },
  };
  await grading.storeMachineGrade(decision);
  let guarded = await pool.query(
    "SELECT machine_grade, machine_score FROM candidate_memory WHERE id = $1",
    [candidates.foreign],
  );
  expect(guarded.rows[0]).toEqual({ machine_grade: null, machine_score: null });
  await pool.query(
    "UPDATE candidate_memory SET review_action = 'promoted', reviewed_at = now(), graded_by = 'fixture-operator' WHERE id = $1",
    [candidates.foreign],
  );
  await grading.storeMachineGrade({ ...decision, namespace: foreign });
  guarded = await pool.query(
    "SELECT machine_grade, machine_score FROM candidate_memory WHERE id = $1",
    [candidates.foreign],
  );
  expect(guarded.rows[0]).toEqual({ machine_grade: null, machine_score: null });
}

test("Light to REM to Deep persists attribution, converges, and isolates namespaces", async () => {
  await runLightSweep({ pool, logger, batchSize: 10 });
  const remDeps = {
    pool,
    rem: createDreamRemRepository(pool),
    grading: createDreamRemGradingRepository(pool),
    logger,
    grader,
    namespace: owner,
    skipDedupe: true,
    skipRewarm: true,
  };
  const firstRem =
    env.DREAM_CHAIN_SKIP_REM === "1"
      ? { grading: { examined: 0, graded: 0, corroborated: 0 } }
      : await runRemPass(remDeps);
  const secondRem =
    env.DREAM_CHAIN_SKIP_REM === "1"
      ? { grading: { examined: 0, graded: 0 } }
      : await runRemPass(remDeps);
  expect(firstRem.grading).toMatchObject({ examined: 1, graded: 1, corroborated: 1 });
  expect(secondRem.grading).toMatchObject({ examined: 0, graded: 0 });

  const persisted = await pool.query(
    "SELECT machine_grade, machine_grade_model, machine_score, machine_graded_at, machine_judgement FROM candidate_memory WHERE id = $1",
    [candidates.owner],
  );
  expect(persisted.rows[0]).toEqual({
    machine_grade: "promoted",
    machine_grade_model: "jev-served/rem-label-score-v2",
    machine_score: 9,
    machine_graded_at: expect.any(Date),
    machine_judgement: {
      kind: "classification_only",
      label: "DECISION",
      decision_source: "jev-served/rem-label-score-v2",
      rubric_version: "rem-label-score-v2",
    },
  });

  const ownerDeep = await buildReviewBundles({
    pool,
    deep: createDreamDeepRepository(pool),
    logger,
    namespace: owner,
    limit: 10,
    contextTurns: 3,
  });
  expect(ownerDeep.bundles).toHaveLength(1);
  expect(ownerDeep.bundles[0]?.machine).toEqual({
    grade: "promoted",
    model: "jev-served/rem-label-score-v2",
  });
  expect(ownerDeep.bundles[0]?.corroboration).toMatchObject({
    session_count: 2,
    occurrence_count: 2,
  });
  expect(ownerDeep.bundles[0]?.turns.map((turn) => turn.id)).toContain(ids.ownerA);
  expect(ownerDeep.bundles[0]?.turns.map((turn) => turn.id)).not.toContain(ids.foreign);
  expect(ownerDeep.bundles[0]?.turns.map((turn) => turn.id)).not.toContain(
    ids.foreignContext,
  );

  const foreignDeep = await buildReviewBundles({
    pool,
    deep: createDreamDeepRepository(pool),
    logger,
    namespace: foreign,
    limit: 10,
    contextTurns: 3,
  });
  expect(foreignDeep.bundles).toHaveLength(1);
  expect(foreignDeep.bundles[0]?.candidate.id).toBe(candidates.foreign);
  expect(foreignDeep.bundles[0]?.turns.map((turn) => turn.id)).toContain(ids.foreign);

  await expectMachineGradeGuards(remDeps.grading);
});
