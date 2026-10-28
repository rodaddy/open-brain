#!/usr/bin/env node
/** REM ethereal runs: disposable output with optional frozen cohort replay. */
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { createPool, logger } from "./settings.ts";
import {
  assertDreamRunSchema,
  freezeCohort,
  loadFrozenCohort,
  nextSchema,
  type FrozenCohort,
} from "./rem-ethereal-cohort.ts";
import type { RemCandidate } from "../server/maintenance/dream-rem.ts";
import {
  BackgroundTraceRecorder,
  type BackgroundTraceEmitter,
} from "../server/observability/background-tracing.ts";
import { createTracingRuntime } from "../server/observability/langfuse-tracing.ts";
import { readMcpTracingConfig } from "../server/observability/trace-config.ts";
import { tracingLoggerFrom } from "../server/observability/trace-logger-adapter.ts";

export interface CliOptions {
  mode: "run" | "list" | "drop" | "freeze" | "replay";
  namespace?: string;
  replaySchema?: string;
  dropSchema?: string;
  limit: number;
  batchSize: number;
  note: string;
  model: "gpt-5.6-luna" | "gpt-5.6-terra";
  effort: "max" | "low";
}

const DEFAULT_ROUTE = { model: "gpt-5.6-terra", effort: "low" } as const;
type EvaluationRoute = Pick<CliOptions, "model" | "effort">;
const EVALUATION_ROUTES = new Map<string, EvaluationRoute>([
  ["gpt-5.6-terra\0low", DEFAULT_ROUTE],
  ["gpt-5.6-luna\0max", { model: "gpt-5.6-luna", effort: "max" } as const],
]);

function parseEvaluationRoute(
  argv: readonly string[],
): Pick<CliOptions, "model" | "effort"> {
  const model = valueArg(argv, "model");
  const effort = valueArg(argv, "effort");
  if ((model === undefined) !== (effort === undefined)) {
    throw new Error("--model and --effort must be supplied together");
  }
  if (model === undefined || effort === undefined) return DEFAULT_ROUTE;
  const route = EVALUATION_ROUTES.get(`${model}\0${effort}`);
  if (route === undefined) {
    throw new Error(
      "unsupported evaluation pair; use gpt-5.6-terra/low or gpt-5.6-luna/max",
    );
  }
  return route;
}

function selectMode(args: {
  list: boolean;
  freeze: boolean;
  drop?: string;
  replay?: string;
}): CliOptions["mode"] {
  if (
    [args.list, args.freeze, args.drop !== undefined, args.replay !== undefined].filter(
      Boolean,
    ).length > 1
  ) {
    throw new Error(
      "--list, --drop, --freeze-only, and --replay are mutually exclusive",
    );
  }
  if (args.list) return "list";
  if (args.drop !== undefined) return "drop";
  if (args.freeze) return "freeze";
  if (args.replay !== undefined) return "replay";
  return "run";
}

function validateScopedMode(mode: CliOptions["mode"], namespace?: string): void {
  if ((mode === "freeze" || mode === "replay") && namespace === undefined) {
    throw new Error("--freeze-only and --replay require --namespace");
  }
  if (
    namespace !== undefined &&
    (namespace.length === 0 || namespace.trim() !== namespace)
  ) {
    throw new Error("--namespace must be non-empty and have no surrounding whitespace");
  }
  if (namespace !== undefined && mode !== "freeze" && mode !== "replay") {
    throw new Error(`--namespace is not valid with ${mode} mode`);
  }
}

function valueArg(argv: readonly string[], name: string): string | undefined {
  const indexes = argv.flatMap((value, index) =>
    value === `--${name}` ? [index] : [],
  );
  if (indexes.length > 1) throw new Error(`--${name} may be supplied only once`);
  if (indexes.length === 0) return undefined;
  const index = indexes[0];
  if (index === undefined) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--"))
    throw new Error(`--${name} requires a value`);
  return value;
}

function positiveInteger(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  const parsed = Number(raw ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

export function parseRemEtherealArgs(argv: readonly string[]): CliOptions {
  const known = new Set([
    "--list",
    "--drop",
    "--freeze-only",
    "--replay",
    "--namespace",
    "--limit",
    "--batch",
    "--note",
    "--model",
    "--effort",
  ]);
  for (const token of argv) {
    if (token.startsWith("--") && !known.has(token))
      throw new Error(`unknown option: ${token}`);
  }
  const list = argv.includes("--list");
  const freeze = argv.includes("--freeze-only");
  const dropSchema = valueArg(argv, "drop");
  const replaySchema = valueArg(argv, "replay");
  const mode = selectMode({ list, freeze, drop: dropSchema, replay: replaySchema });
  const route = parseEvaluationRoute(argv);
  const namespace = valueArg(argv, "namespace");
  validateScopedMode(mode, namespace);
  const limit = valueArg(argv, "limit");
  if (limit !== undefined && (mode === "freeze" || mode === "replay")) {
    throw new Error(
      `--limit is not valid with ${mode} mode; frozen cohorts are exactly 50`,
    );
  }
  if (replaySchema !== undefined) assertDreamRunSchema(replaySchema);
  if (dropSchema !== undefined) assertDreamRunSchema(dropSchema);
  return {
    mode,
    namespace,
    replaySchema,
    dropSchema,
    limit: positiveInteger(limit, 50, "limit"),
    batchSize: positiveInteger(valueArg(argv, "batch"), 25, "batch"),
    note: valueArg(argv, "note") ?? "",
    ...route,
  };
}

export async function allocateGradingSchema(pool: Pool): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // The name is only safe while this transaction holds nextSchema's lock.
    const schema = await nextSchema(client);
    await createGradingTables(client, schema);
    await client.query("COMMIT");
    return schema;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function selectMutableCandidates(
  pool: Pool,
  limit: number,
): Promise<RemCandidate[]> {
  const rows = await pool.query<{
    id: string;
    namespace: string;
    candidate_type: string;
    content: string;
    content_hash: string;
    uncertain: boolean;
    uncertainty_reason: string | null;
    model: string | null;
    session_count: string | null;
    occurrence_count: string | null;
    reinforcement_count: string;
  }>(
    `SELECT c.id, c.namespace, c.candidate_type, c.content, c.content_hash,
            c.uncertain, c.uncertainty_reason, c.model, o.session_count, o.occurrence_count,
            (SELECT count(*) FROM candidate_reinforcement r WHERE r.candidate_id = c.id)::text AS reinforcement_count
       FROM candidate_memory c
       LEFT JOIN content_occurrences o ON o.namespace = c.namespace AND o.content_hash = c.content_hash
      WHERE c.unit_kind = 'exchange' AND c.reviewed_at IS NULL AND c.parent_id IS NULL
      ORDER BY md5(c.id::text), c.id LIMIT $1`,
    [limit],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    namespace: row.namespace,
    candidate_type: row.candidate_type,
    content: row.content,
    content_hash: row.content_hash,
    uncertain: row.uncertain,
    uncertainty_reason: row.uncertainty_reason,
    model: row.model,
    session_count: Number(row.session_count ?? 0),
    occurrence_count: Number(row.occurrence_count ?? 0),
    reinforcement_count: Number(row.reinforcement_count),
  }));
}

async function createGradingTables(client: PoolClient, schema: string): Promise<void> {
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`CREATE TABLE ${schema}.manifest (
    run_id TEXT PRIMARY KEY, model TEXT NOT NULL, effort TEXT NOT NULL,
    prompt_sha256 TEXT NOT NULL, batch_size INTEGER NOT NULL, requested INTEGER NOT NULL,
    examined INTEGER NOT NULL, judged INTEGER NOT NULL, fell_back INTEGER NOT NULL,
    started_at TIMESTAMPTZ NOT NULL, ended_at TIMESTAMPTZ, note TEXT,
    errors JSONB NOT NULL DEFAULT '[]'::jsonb, frozen_source_schema TEXT,
    frozen_cohort_digest TEXT, frozen_full_snapshot_sha256 TEXT, frozen_namespace TEXT)`);
  await client.query(`CREATE TABLE ${schema}.judgement (
    run_id TEXT NOT NULL, candidate_id UUID NOT NULL, machine_score INTEGER,
    machine_grade TEXT, label TEXT, quote TEXT, synopsis TEXT, agent_behavior TEXT,
    reasons JSONB, turn_count INTEGER, operator_chars INTEGER, agent_chars INTEGER,
    from_terra BOOLEAN NOT NULL, decision_source TEXT, PRIMARY KEY (run_id, candidate_id))`);
}

interface GradeDisposableArgs {
  pool: Pool;
  candidates: RemCandidate[];
  batchSize: number;
  requested: number;
  note: string;
  frozen?: FrozenCohort;
  model: CliOptions["model"];
  effort: CliOptions["effort"];
  tracing?: BackgroundTraceEmitter;
}

function remRunTrace(
  args: GradeDisposableArgs,
  schema: string,
  promptSha: string,
): BackgroundTraceRecorder {
  return new BackgroundTraceRecorder(args.tracing, {
    name: "dream.rem.ethereal",
    tags: ["background-job", "dream", "rem", "ethereal"],
    sessionId: schema,
    input: { candidate_ids: args.candidates.map(({ id }) => id) },
    metadata: {
      run_id: schema,
      model: args.model,
      effort: args.effort,
      batch_size: args.batchSize,
      requested: args.requested,
      examined: args.candidates.length,
      base_prompt_sha256: promptSha,
      ...(args.frozen === undefined
        ? {}
        : {
            frozen_namespace: args.frozen.namespace,
            frozen_source_schema: args.frozen.schema,
            frozen_snapshot_sha256: args.frozen.fullSnapshotSha256,
          }),
    },
  });
}

export async function gradeDisposable(args: GradeDisposableArgs): Promise<void> {
  const schema = await allocateGradingSchema(args.pool);
  console.log(`=== ${schema} ===`);

  const [terra, transport, prompt, config] = await Promise.all([
    import("../server/maintenance/rem-terra-grader.ts"),
    import("../server/maintenance/rem-terra-transport.ts"),
    import("../server/maintenance/rem-prompt.ts"),
    import("../server/config.ts"),
  ]);
  const errors: unknown[] = [];
  const startedAt = new Date();
  const promptSha = createHash("sha256")
    .update(prompt.REM_GRADING_PROMPT)
    .digest("hex")
    .slice(0, 16);
  const trace = remRunTrace(args, schema, promptSha);
  try {
    const grader = terra.createTerraGrader({
      transport: transport.runTerraBatch,
      model: args.model,
      effort: args.effort,
      batchSize: args.batchSize,
      logger: {
        warn: (event, data) => {
          console.warn(`WARN ${event}`, data ?? "");
          errors.push({ event, data });
        },
      },
      jev: { config: config.loadServerConfig().search.jevRem },
      trace,
    });
    await grader.prime(args.candidates);
    let judged = 0;
    let fellBack = 0;
    for (const candidate of args.candidates) {
      const judgement = grader.judgementFor(candidate.id);
      const verdict = await grader.grade(candidate);
      const shape = terra.interactionShape(candidate.content);
      if (judgement) judged++;
      else fellBack++;
      const stored = storedJudgement(judgement, verdict.grade, grader.name);
      await args.pool.query(
        `INSERT INTO ${schema}.judgement
       (run_id,candidate_id,machine_score,machine_grade,label,quote,synopsis,agent_behavior,
        reasons,turn_count,operator_chars,agent_chars,from_terra,decision_source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          schema,
          candidate.id,
          ...stored.slice(0, 7),
          shape.turn_count,
          shape.operator_chars,
          shape.agent_chars,
          stored[7],
          stored[8],
        ],
      );
    }
    const frozen = frozenManifestValues(args.frozen);
    await args.pool.query(
      `INSERT INTO ${schema}.manifest
     (run_id,model,effort,prompt_sha256,batch_size,requested,examined,judged,fell_back,
      started_at,ended_at,note,errors,frozen_source_schema,frozen_cohort_digest,
      frozen_full_snapshot_sha256,frozen_namespace)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11,$12,$13,$14,$15,$16)`,
      [
        schema,
        args.model,
        args.effort,
        promptSha,
        args.batchSize,
        args.requested,
        args.candidates.length,
        judged,
        fellBack,
        startedAt,
        args.note,
        JSON.stringify(errors),
        ...frozen,
      ],
    );
    console.log(`\n=== ${schema} complete ===`);
    console.log(`requested route : ${args.model}/${args.effort}`);
    console.log(`judged by model : ${judged}`);
    console.log(`fell back       : ${fellBack}`);
    console.log(`errors          : ${errors.length}`);
    console.log(
      `\nteardown: node --env-file=.env scripts/rem-ethereal-run.ts --drop ${schema}`,
    );
    trace.finish({ judged, fell_back: fellBack, errors: errors.length });
  } catch (error: unknown) {
    trace.fail(error);
    throw error;
  }
}

function storedJudgement(
  judgement:
    | {
        score: number;
        label: string;
        quote: string;
        synopsis: string;
        agent_behavior: string;
        reasons: string[];
        decision_source?: string;
      }
    | undefined,
  grade: string,
  graderName: string,
): unknown[] {
  if (judgement === undefined) {
    return [null, grade, null, null, null, null, null, false, "rem-heuristic-v1"];
  }
  return [
    judgement.score,
    grade,
    judgement.label,
    judgement.quote,
    judgement.synopsis,
    judgement.agent_behavior,
    JSON.stringify(judgement.reasons),
    true,
    judgement.decision_source ?? graderName,
  ];
}

function frozenManifestValues(frozen?: FrozenCohort): Array<string | null> {
  if (frozen === undefined) return [null, null, null, null];
  return [frozen.schema, frozen.digest, frozen.fullSnapshotSha256, frozen.namespace];
}

export async function runRemEthereal(
  options: CliOptions,
  pool: Pool,
  tracing?: BackgroundTraceEmitter,
): Promise<void> {
  if (options.mode === "list") {
    const runs = await pool.query(
      `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'dream\\_run\\_%' ORDER BY nspname`,
    );
    for (const row of runs.rows) console.log(row.nspname);
    return;
  }
  if (options.mode === "drop") {
    if (options.dropSchema === undefined)
      throw new Error("drop schema missing after validation");
    await pool.query(`DROP SCHEMA IF EXISTS ${options.dropSchema} CASCADE`);
    console.log(`dropped ${options.dropSchema}`);
    return;
  }
  if (options.mode === "freeze") {
    if (options.namespace === undefined)
      throw new Error("freeze namespace missing after validation");
    const frozen = await freezeCohort(pool, options.namespace);
    console.log(`frozen ${frozen.candidates.length} candidates in ${frozen.schema}`);
    console.log(`namespace       : ${frozen.namespace}`);
    console.log(`cohort digest   : ${frozen.digest}`);
    console.log(`snapshot sha256 : ${frozen.fullSnapshotSha256}`);
    return;
  }
  if (options.mode === "replay") {
    // This validates count, order, IDs, namespace, source identity, and both
    // digests before gradeDisposable imports or constructs a grader.
    if (options.replaySchema === undefined || options.namespace === undefined) {
      throw new Error("replay scope missing after validation");
    }
    const frozen = await loadFrozenCohort(
      pool,
      options.replaySchema,
      options.namespace,
    );
    await gradeDisposable({
      pool,
      candidates: frozen.candidates,
      batchSize: options.batchSize,
      requested: frozen.candidates.length,
      note: options.note,
      frozen,
      model: options.model,
      effort: options.effort,
      tracing,
    });
    return;
  }
  const candidates = await selectMutableCandidates(pool, options.limit);
  console.log(`${candidates.length} candidates, batch ${options.batchSize}`);
  await gradeDisposable({
    pool,
    candidates,
    batchSize: options.batchSize,
    requested: options.limit,
    note: options.note,
    model: options.model,
    effort: options.effort,
    tracing,
  });
}

export interface MainDeps {
  createPool: () => Pool;
  createTracingRuntime?: typeof createTracingRuntime;
  env?: NodeJS.ProcessEnv;
}

export function createRemTracingRuntime(
  env: NodeJS.ProcessEnv,
  createTracing: typeof createTracingRuntime = createTracingRuntime,
) {
  const tracingLogger = tracingLoggerFrom(logger);
  return createTracing({
    config: readMcpTracingConfig(env, tracingLogger),
    logger: tracingLogger,
  });
}

async function closeCli(pool: Pool | undefined, shutdown: () => Promise<void>) {
  try {
    if (pool) await pool.end();
  } finally {
    await shutdown();
  }
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  deps: MainDeps = { createPool },
): Promise<void> {
  // Validate every CLI combination before constructing a pool or grader.
  const options = parseRemEtherealArgs(argv);
  const runtime = createRemTracingRuntime(
    deps.env ?? process.env,
    deps.createTracingRuntime,
  );
  let pool: Pool | undefined;
  try {
    pool = deps.createPool();
    await runRemEthereal(options, pool, runtime.background);
  } finally {
    await closeCli(pool, () => runtime.shutdown());
  }
}

if (import.meta.main) await main();
