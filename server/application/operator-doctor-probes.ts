/**
 * The individual diagnostic probes the doctor fans out over.
 *
 * Split out of `./operator-doctor.ts` (issue 864) by responsibility: this file
 * asks the questions (database, migrations, audit storage, distillation lag,
 * embedding provider, qmd binary and index), and `./operator-doctor.ts`
 * assembles the answers into the frozen payload. Every probe here is
 * self-contained and takes what it needs as an argument.
 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { embeddingBaseUrl, embeddingApiKey } from "../../src/embedding.ts";
import { readMcpAuditConfig } from "../../src/audit-log.ts";
import { resolveQmdPath } from "../config/qmd-path.ts";
import { logger } from "../../src/logger.ts";
import { describeError } from "../../src/observability/index.ts";
import type { QmdIndexProbeResult } from "../../src/qmd-index-probe-worker.ts";
import {
  classifyDistillationLag,
  OPTIONAL_TIMEOUT_MS,
  QMD_INDEX_STALE_AFTER_HOURS,
  type OperatorDoctorBuildOptions,
  type OperatorDoctorStatus,
} from "./operator-doctor-types.ts";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "db",
  "migrations",
);
const DEFAULT_QMD_INDEX_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".qmd",
  "index.sqlite",
);
const PACKAGE_JSON_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "package.json",
);

let cachedServiceVersion: string | null = null;

/** Test seam: the version is read once per process and memoized. */
export function resetCachedServiceVersion(): void {
  cachedServiceVersion = null;
}

export async function readServiceVersion(fallback: string): Promise<string> {
  if (cachedServiceVersion !== null) return cachedServiceVersion;
  try {
    const pkg = (await Bun.file(PACKAGE_JSON_PATH).json()) as {
      version?: unknown;
    };
    cachedServiceVersion =
      typeof pkg.version === "string" && pkg.version.length > 0
        ? pkg.version
        : fallback;
  } catch (error) {
    // Falling back to the caller's value is fine; reporting "unknown" as if it
    // were the answer is not. A doctor that cannot read its own package.json is
    // telling the operator something about its deployment.
    cachedServiceVersion = fallback;
    logger.warn("doctor_service_version_unreadable", {
      fallback: cachedServiceVersion,
      ...describeError(error),
    });
  }
  return cachedServiceVersion;
}

export async function withTimeout<T>(
  task: Promise<T>,
  fallback: T,
  timeoutMs = OPTIONAL_TIMEOUT_MS,
): Promise<T> {
  // Absorb late rejections: if the timeout wins the race, a subsequent
  // rejection of the abandoned task must not surface as an unhandled
  // rejection. Absorbing it is right; discarding it was not -- a probe that
  // always loses the race and always rejects reported its fallback forever
  // with nothing anywhere saying why.
  task.catch((error: unknown) => {
    logger.debug("doctor_probe_late_rejection", describeError(error));
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Is an HTTP endpoint answering OK? Exported because `/health` in `src/index.ts`
 * asks the same question of the same provider and had its own byte-identical
 * private copy -- including the bare `catch { return false }` this one no longer
 * has. A REST sibling drifting from the module that owns the logic is the exact
 * shape of the PR #277 failure recorded in docs/sme/correctness.md:475, so the
 * two call sites now share one implementation instead of two.
 *
 * Reports only a boolean by design; which of DNS failure, refused connection,
 * or timeout it was goes to the log, because that is the whole diagnosis.
 *
 * `timeoutMs` is a parameter rather than a shared constant because the two
 * callers genuinely differ and neither should silently inherit the other's
 * value: the doctor allows 2s for an optional-dependency probe, `/health`
 * allowed 3s. Sharing the implementation must not quietly change either one.
 */
export async function probeUrl(
  url: string,
  headers: Record<string, string>,
  timeoutMs = OPTIONAL_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const resp = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
      // A reachable endpoint answering 401 or 503 is a different problem from
      // an unreachable one, and `false` says neither.
      logger.debug("doctor_probe_not_ok", {
        status: resp.status,
        timeout_ms: timeoutMs,
      });
    }
    return resp.ok;
  } catch (error) {
    // DNS failure, connection refused, or the timeout firing. The caller gets
    // only a boolean by design; which of the three it was belongs in the log,
    // because that is the whole diagnosis.
    logger.debug("doctor_probe_failed", {
      timeout_ms: timeoutMs,
      ...describeError(error),
    });
    return false;
  }
}

function unknownMigrationStatus(
  expectedCount: number,
  latestExpected: string | null,
): OperatorDoctorStatus["migrations"] {
  return {
    status: "unknown",
    applied_count: null,
    expected_count: expectedCount,
    pending_count: null,
    latest_applied: null,
    latest_expected: latestExpected,
  };
}

export async function readMigrationStatus(
  pool: pg.Pool,
): Promise<OperatorDoctorStatus["migrations"]> {
  let files: string[];
  try {
    files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  } catch (error) {
    // Never let a filesystem error propagate: thrown messages can carry raw
    // paths into MCP tool error text or Express error pages. That rule governs
    // the *response*; the log is where the operator is allowed to learn that
    // the migrations directory is missing from the deployment entirely, which
    // "status: unknown" on its own never said.
    logger.error("doctor_migrations_dir_unreadable", describeError(error));
    return unknownMigrationStatus(0, null);
  }
  const latestExpected = files.at(-1) ?? null;
  try {
    const { rows } = await pool.query(
      "SELECT filename FROM _migrations ORDER BY filename",
    );
    const applied = rows.map((row) => String(row.filename));
    const appliedSet = new Set(applied);
    const pending = files.filter((file) => !appliedSet.has(file));
    return {
      status: pending.length === 0 ? "current" : "pending",
      applied_count: applied.length,
      expected_count: files.length,
      pending_count: pending.length,
      latest_applied: applied.at(-1) ?? null,
      latest_expected: latestExpected,
    };
  } catch (error) {
    // Two very different deployments produce this same "unknown": a database
    // the doctor cannot reach at all, and a reachable database with no
    // `_migrations` table (SQLSTATE 42P01 -- never migrated). The pg fields say
    // which; the payload shape cannot.
    logger.error("doctor_migrations_query_failed", describeError(error));
    return unknownMigrationStatus(files.length, latestExpected);
  }
}

export async function readAuditStorageStatus(
  pool: pg.Pool,
): Promise<OperatorDoctorStatus["log_audit"]["audit_storage"]> {
  if (!readMcpAuditConfig().enabled) return "not_available";

  const query: pg.QueryConfig<[string]> & { query_timeout: number } = {
    text: "SELECT to_regclass($1) AS table_name",
    values: ["mcp_tool_audit_log"],
    query_timeout: OPTIONAL_TIMEOUT_MS,
  };
  const reachable = await withTimeout(
    pool
      .query(query)
      .then(({ rows }) => rows[0]?.table_name != null)
      .catch(() => false),
    false,
  );
  return reachable ? "available" : "not_available";
}

interface DistillationLagRow {
  namespace: string;
  undistilled_depth: string | number;
  oldest_undistilled_age_seconds: string | number;
  ratio: string | number;
}

function distillationLagRow(
  row: DistillationLagRow,
): OperatorDoctorStatus["distillation_lag"][number] {
  const ratio = Number(row.ratio);
  return {
    namespace: row.namespace,
    undistilled_depth: Number(row.undistilled_depth),
    oldest_undistilled_age_seconds: Number(row.oldest_undistilled_age_seconds),
    ratio,
    level: classifyDistillationLag(ratio),
  };
}

export async function readDistillationLag(
  pool: pg.Pool,
  ttlSeconds: number,
): Promise<OperatorDoctorStatus["distillation_lag"]> {
  // created_at is deliberate and must match issue #395 retention/eviction's
  // column. If #395 expires on occurred_at, this alarm silently stops catching
  // its near-loss case.
  const query: pg.QueryConfig<[number, string, string]> & {
    query_timeout: number;
  } = {
    text: `
      SELECT
        namespace,
        COUNT(*)::integer AS undistilled_depth,
        GREATEST(
          0,
          FLOOR(EXTRACT(EPOCH FROM (now() - MIN(created_at))))
        )::bigint AS oldest_undistilled_age_seconds,
        GREATEST(0, EXTRACT(EPOCH FROM (now() - MIN(created_at))))
          / $1::double precision AS ratio
      FROM ob_raw_turns
      WHERE distilled_at IS NULL
        AND retention_tier = $2
        -- Parity fixtures are not operator-actionable distillation lag.
        AND namespace NOT LIKE $3
      GROUP BY namespace
      ORDER BY namespace
    `,
    values: [ttlSeconds, "live", "parity-raw-turn-%"],
    query_timeout: OPTIONAL_TIMEOUT_MS,
  };
  return withTimeout(
    pool
      .query<DistillationLagRow>(query)
      .then(({ rows }) => rows.map(distillationLagRow))
      .catch((error: unknown) => {
        logger.warn("doctor_distillation_lag_query_failed", describeError(error));
        return [];
      }),
    [],
  );
}

export async function checkEmbeddingAvailability(): Promise<boolean> {
  const baseUrl = embeddingBaseUrl();
  if (!baseUrl) return false;
  const headers: Record<string, string> = {};
  const apiKey = embeddingApiKey();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return withTimeout(probeUrl(`${baseUrl}/models`, headers), false);
}

type QmdIndexPathSource = "option" | "env" | "default";

interface ResolvedQmdIndexPath {
  path: string;
  source: QmdIndexPathSource;
}

function resolveQmdIndexPath(
  options: OperatorDoctorBuildOptions,
): ResolvedQmdIndexPath {
  if (options.qmdIndexPath !== undefined) {
    return {
      path: options.qmdIndexPath,
      source: options.qmdIndexPathSource ?? "env",
    };
  }
  return { path: DEFAULT_QMD_INDEX_PATH, source: "default" };
}

function unavailableQmdIndexStatus(
  resolved: ResolvedQmdIndexPath,
  staleAfterHours: number,
): OperatorDoctorStatus["qmd"]["index"] {
  return {
    path: resolved.path,
    path_source: resolved.source,
    status: "unavailable",
    last_updated_at: null,
    age_hours: null,
    freshness: "unknown",
    stale_after_hours: staleAfterHours,
    document_count: null,
    collection_count: null,
  };
}

// Concurrent callers share one probe per path. Each probe spawns a Worker that
// boots a module graph and opens the index, and buildOperatorDoctorStatus is
// called repeatedly under load (the contract parity suite drives it many times
// in quick succession). Spawning one per call starved the event loop enough
// that neighbouring fixtures exceeded their 5s query timeout -- measured as
// 8-10 parity failures against origin/main's stable 7. The entry is cleared on
// settle, so the next call re-probes rather than serving a stale reading.
const inFlightQmdIndexProbes = new Map<string, Promise<QmdIndexProbeResult>>();

function spawnQmdIndexProbe(path: string): {
  task: Promise<QmdIndexProbeResult>;
  terminate: () => void;
} {
  const worker = new Worker(
    new URL("../../src/qmd-index-probe-worker.ts", import.meta.url),
    { type: "module" },
  );
  const task = new Promise<QmdIndexProbeResult>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<QmdIndexProbeResult>) => {
      resolve(event.data);
    };
    worker.onerror = (event: ErrorEvent) => {
      reject(event.error ?? new Error(event.message));
    };
    worker.postMessage({ path });
  });
  return { task, terminate: () => worker.terminate() };
}

function startQmdIndexProbe(path: string): {
  task: Promise<QmdIndexProbeResult>;
  terminate: () => void;
} {
  const existing = inFlightQmdIndexProbes.get(path);
  if (existing) return { task: existing, terminate: () => {} };
  const spawned = spawnQmdIndexProbe(path);
  const shared = spawned.task.finally(() => {
    inFlightQmdIndexProbes.delete(path);
    spawned.terminate();
  });
  // Keep the shared promise from surfacing as an unhandled rejection when the
  // only awaiting caller has already timed out.
  shared.catch(() => {});
  inFlightQmdIndexProbes.set(path, shared);
  return { task: shared, terminate: () => {} };
}

function availableQmdIndexStatus(
  options: OperatorDoctorBuildOptions,
  resolved: ResolvedQmdIndexPath,
  staleAfterHours: number,
  result: QmdIndexProbeResult,
): OperatorDoctorStatus["qmd"]["index"] {
  const modifiedAt = new Date(result.modified_at_ms);
  const ageHours = Math.max(
    0,
    ((options.now ?? Date.now)() - modifiedAt.getTime()) / 3_600_000,
  );
  return {
    path: resolved.path,
    path_source: resolved.source,
    status: "available",
    last_updated_at: modifiedAt.toISOString(),
    age_hours: Math.round(ageHours * 100) / 100,
    freshness: ageHours >= staleAfterHours ? "stale" : "current",
    stale_after_hours: staleAfterHours,
    document_count: result.document_count,
    collection_count: result.collection_count,
  };
}

async function readQmdIndexStatus(
  options: OperatorDoctorBuildOptions,
): Promise<OperatorDoctorStatus["qmd"]["index"]> {
  const resolved = resolveQmdIndexPath(options);
  const staleAfterHours =
    options.qmdIndexStaleAfterHours ?? QMD_INDEX_STALE_AFTER_HOURS;
  const fallback = unavailableQmdIndexStatus(resolved, staleAfterHours);
  const probe = startQmdIndexProbe(resolved.path);
  try {
    const result = await withTimeout(probe.task, null);
    if (result === null) return fallback;
    return availableQmdIndexStatus(options, resolved, staleAfterHours, result);
  } catch (error) {
    logger.warn("doctor_qmd_index_unreadable", {
      path_source: resolved.source,
      ...describeError(error),
    });
    return fallback;
  } finally {
    probe.terminate();
  }
}

// Availability = the qmd entrypoint file exists at the same resolved path
// search_all executes (server/config/qmd-path.ts). This remains binary presence only;
// repo-local index freshness is reported separately below.
export async function checkQmdStatus(
  options: OperatorDoctorBuildOptions,
): Promise<OperatorDoctorStatus["qmd"]> {
  const resolved = resolveQmdPath({ qmdPath: options.qmdPath });
  let available = false;
  try {
    available = existsSync(resolved.path);
  } catch (error) {
    // existsSync swallows ENOENT itself, so reaching here means something
    // stranger -- a permission error on an ancestor directory, an unmounted
    // volume. Reporting the binary as simply absent would send the operator
    // looking for a missing install that is actually present and unreachable.
    logger.warn("doctor_qmd_probe_failed", {
      path_source: resolved.source,
      ...describeError(error),
    });
  }
  return {
    configured: true,
    path_source: resolved.source,
    available,
    status: available ? "available" : "unavailable",
    index: await readQmdIndexStatus(options),
  };
}
