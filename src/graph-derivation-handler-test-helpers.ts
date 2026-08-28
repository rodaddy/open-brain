/**
 * Shared fixtures for the two live graph-derivation suites.
 *
 * The #878 split put selection/convergence and isolation/atomicity in separate
 * files. Both need the same namespaces, the same source-row writer, and the
 * same maintenance-job shape, so those live here.
 *
 * This module holds no test and creates no pool: each database function takes
 * the caller's `pool` first, so each suite owns exactly one connection pool and
 * ends it in its own afterAll. A helper that made its own pool would give one
 * half of the split an afterAll that closes a connection the other half is
 * still using.
 */
import { Pool } from "pg";
import {
  GRAPH_DERIVATION_JOB_KIND,
  type GraphDerivationPayload,
} from "./graph-derivation-handler.ts";
import { type MaintenanceJob } from "./maintenance-queue.ts";
import type { AuthInfo } from "./types.ts";

export const ns = "test-graph-derivation-maint";
export const otherNs = "test-graph-derivation-maint-other";

export const auth: AuthInfo = {
  role: "admin",
  clientId: "test-graph-derivation-maint",
  namespaceSource: "token",
};

export const hashA = "a".repeat(64);
export const hashB = "b".repeat(64);

/**
 * Narrows a possibly-absent value, throwing with a caller-supplied label.
 *
 * Replaces the `x!` non-null assertions the oxlint standard forbids: the
 * assertion's runtime meaning (throw when absent) is kept, and the label says
 * which expectation went missing instead of a bare TypeError.
 *
 * @throws {Error} when `value` is null or undefined.
 */
export function expectDefined<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
}

export async function cleanup(pool: Pool): Promise<void> {
  for (const namespace of [ns, otherNs]) {
    await pool.query("DELETE FROM ob_links WHERE namespace = $1", [namespace]);
    await pool.query("DELETE FROM ob_entities WHERE namespace = $1", [namespace]);
    await pool.query("DELETE FROM ob_sources WHERE namespace = $1", [namespace]);
  }
}

export async function insertSource(
  pool: Pool,
  namespace: string,
  over: Partial<{
    approval_state: string;
    lifecycle_state: string;
    content_hash: string | null;
    title: string | null;
    external_id: string;
  }> = {},
): Promise<{ id: string; revision: number; external_id: string }> {
  const externalId = over.external_id ?? `ext-${namespace}`;
  const { rows } = await pool.query(
    `INSERT INTO ob_sources
       (namespace, source_kind, external_id, title,
        approval_state, lifecycle_state, content_hash, created_by)
     VALUES ($1, 'git', $2, $3, $4, $5, $6, 'tester')
     RETURNING id, revision, external_id`,
    [
      namespace,
      externalId,
      over.title ?? "release plan",
      over.approval_state ?? "approved",
      over.lifecycle_state ?? "active",
      over.content_hash === undefined ? hashA : over.content_hash,
    ],
  );
  return {
    id: rows[0].id as string,
    revision: rows[0].revision as number,
    external_id: rows[0].external_id as string,
  };
}

export function jobFor(
  payload: GraphDerivationPayload,
  namespace: string,
): MaintenanceJob {
  return {
    id: "job-live",
    kind: GRAPH_DERIVATION_JOB_KIND,
    version: 1,
    payload: payload as unknown as Record<string, unknown>,
    idempotencyKey: "k",
    state: "running",
    runAfter: new Date("2026-07-22T12:00:00.000Z"),
    leaseToken: "00000000-0000-4000-8000-000000000009",
    leaseUntil: new Date("2026-07-22T12:00:30.000Z"),
    attempts: 1,
    maxAttempts: 3,
    backoffBaseMs: 1_000,
    backoffMaxMs: 4_000,
    lastErrorCategory: null,
    terminalAt: null,
    deadLetteredAt: null,
    namespace,
    provenance: null,
    createdAt: new Date("2026-07-22T12:00:00.000Z"),
    updatedAt: new Date("2026-07-22T12:00:00.000Z"),
  };
}
