/**
 * The run-schema signal and flag tables the DREAM apply step reads and writes.
 *
 * DETECTION IS NOT BUILT HERE, and that is the decided design (operator ruling
 * 2026-09-21 on issue 1469, `_plans/1469-dream-route.md:76-78`,
 * `docs/code-brain-design.md:146-148`). A canon contradiction and an operator
 * reversal are the two signals the apply step must ROUTE differently, but
 * working out which candidate carries one is a separate job with its own
 * evidence. So the signals arrive as ROWS: a proof plants them with
 * `plantSignal`, and a later detection stage fills the same table from real
 * evidence without the apply step changing at all.
 *
 * `route_signals` is the input side and `apply_flags` the output side: one row
 * per (run, candidate, signal) in, one row per (run, candidate, kind) out
 * recording what the apply step did about it and whether an operator still has
 * to look. The primary keys are what make a second apply write nothing new.
 *
 * Nothing here writes to `public`; every statement is issued against a schema
 * name `assertDreamRunSchema` has already accepted, and every other value is a
 * bind parameter.
 */

import type { Pool, PoolClient } from "pg";
import { assertDreamRunSchema } from "./rem-ethereal-cohort.ts";

/** The two signals the apply step routes on. */
export const ROUTE_SIGNALS = ["contradicts_canon", "reverses_rule"] as const;

/** One of the two signal names. */
export type RouteSignal = (typeof ROUTE_SIGNALS)[number];

/** The two flag kinds the apply step emits, one per signal it acted on. */
export const APPLY_FLAG_KINDS = ["canon_contradiction", "rule_reversal"] as const;

/** One of the two flag kinds. */
export type ApplyFlagKind = (typeof APPLY_FLAG_KINDS)[number];

/** What `ensureSignalTables` is pointed at. */
export interface EnsureSignalTablesInput {
  /** A pool, or a client already inside the caller's transaction. */
  readonly client: Pool | PoolClient;
  /** A `dream_run_NNN` schema name. */
  readonly schema: string;
}

/**
 * Creates `route_signals` and `apply_flags` inside one run schema, if absent.
 *
 * `target_scope_key` is nullable at the column level and required only for
 * `reverses_rule`, which is what the CHECK expresses: a contradiction names no
 * target, and a reversal without the scope key of the rule it reverses could
 * not be acted on at all.
 *
 * Idempotent by construction -- every statement is `IF NOT EXISTS`.
 *
 * @param input - The client or pool to issue against, and the run schema.
 * @returns The table names created, in creation order.
 * @throws {Error} When the schema is not a `dream_run_NNN` name.
 */
export async function ensureSignalTables(
  input: EnsureSignalTablesInput,
): Promise<readonly string[]> {
  const { client, schema } = input;
  assertDreamRunSchema(schema);
  await client.query(`CREATE TABLE IF NOT EXISTS ${schema}.route_signals (
    run_id UUID NOT NULL,
    candidate_id UUID NOT NULL,
    signal TEXT NOT NULL
      CHECK (signal IN ('contradicts_canon', 'reverses_rule')),
    target_scope_key TEXT,
    planted BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (signal <> 'reverses_rule' OR target_scope_key IS NOT NULL),
    PRIMARY KEY (run_id, candidate_id, signal))`);
  await client.query(`CREATE TABLE IF NOT EXISTS ${schema}.apply_flags (
    run_id UUID NOT NULL,
    candidate_id UUID NOT NULL,
    kind TEXT NOT NULL
      CHECK (kind IN ('canon_contradiction', 'rule_reversal')),
    target_scope_key TEXT,
    needs_operator_approval BOOLEAN NOT NULL,
    applied BOOLEAN NOT NULL,
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, candidate_id, kind))`);
  return ["route_signals", "apply_flags"];
}

/** What `plantSignal` is pointed at. */
export interface PlantSignalInput {
  /** A pool, or a client already inside the caller's transaction. */
  readonly client: Pool | PoolClient;
  /** A `dream_run_NNN` schema name. */
  readonly schema: string;
  /** The routing run the signal belongs to. */
  readonly runId: string;
  /** The candidate the signal is about. */
  readonly candidateId: string;
  /** Which of the two signals. */
  readonly signal: RouteSignal;
  /** The scope key of the rule being reversed; required for `reverses_rule`. */
  readonly targetScopeKey?: string;
}

/**
 * Plants ONE signal row, the way a proof supplies what detection will later.
 *
 * `planted` is written `true` precisely so a row a proof put there is never
 * mistaken for detected evidence once detection exists; the apply step reads
 * both the same way, which is the point of the column being data rather than a
 * separate table.
 *
 * @param input - The client, run schema, run, candidate, and signal.
 * @throws {Error} When the schema is not a `dream_run_NNN` name, or a
 *   `reverses_rule` signal arrives without a target scope key.
 */
export async function plantSignal(input: PlantSignalInput): Promise<void> {
  const { client, schema, runId, candidateId, signal, targetScopeKey } = input;
  assertDreamRunSchema(schema);
  if (signal === "reverses_rule" && targetScopeKey === undefined) {
    throw new Error("a reverses_rule signal needs a target_scope_key");
  }
  await client.query(
    `INSERT INTO ${schema}.route_signals
       (run_id, candidate_id, signal, target_scope_key, planted)
     VALUES ($1, $2, $3, $4, true)
     ON CONFLICT (run_id, candidate_id, signal) DO NOTHING`,
    [runId, candidateId, signal, targetScopeKey ?? null],
  );
}
