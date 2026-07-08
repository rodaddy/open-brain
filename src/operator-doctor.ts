import { readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { CONTRACT_VERSION, CONTRACT_SCHEMA_VERSION } from "./contract.ts";
import {
  getEmbeddingProviderDiagnostics,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
} from "./embedding.ts";
import { checkPoolHealth } from "./db/pool.ts";
import type { NatsBridgeHealth } from "./nats-bridge.ts";
import type { NatsRuntimeBoundary } from "./nats-runtime.ts";
import type { PoolHealth } from "./types.ts";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "db",
  "migrations",
);

const DOCTOR_CONTRACT_VERSION = "2026-07-08.operator-doctor.v1";
const OPTIONAL_TIMEOUT_MS = 2_000;

let cachedServiceVersion: string | null = null;

async function readServiceVersion(): Promise<string> {
  if (cachedServiceVersion !== null) return cachedServiceVersion;
  try {
    const pkg = (await Bun.file(
      join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    ).json()) as { version?: unknown };
    cachedServiceVersion =
      typeof pkg.version === "string" && pkg.version.length > 0
        ? pkg.version
        : (process.env.npm_package_version ?? "unknown");
  } catch {
    cachedServiceVersion = process.env.npm_package_version ?? "unknown";
  }
  return cachedServiceVersion;
}

export interface OperatorDoctorStatus {
  status: "healthy" | "degraded";
  contract_version: string;
  generated_at: string;
  runtime: {
    service: "open-brain";
    version: string;
    contract_version: string;
    contract_schema_version: number;
    node_env: "production" | "development" | "test" | "unknown";
  };
  database: PoolHealth;
  migrations: {
    status: "current" | "pending" | "unknown";
    applied_count: number | null;
    expected_count: number;
    pending_count: number | null;
    latest_applied: string | null;
    latest_expected: string | null;
  };
  embedding_provider: {
    configured: boolean;
    available: boolean;
    model: string;
    dimensions: number;
    recent_failures: {
      last_failure_code: string | null;
      consecutive_restartable_failures: number;
      restart_configured: boolean;
      restart_in_flight: boolean;
      last_restart_at: string | null;
    };
  };
  qmd: {
    configured: boolean;
    available: boolean | null;
    status: "available" | "unavailable" | "not_configured";
  };
  transport: {
    mode: "http" | "nats";
    availability: "available" | "not_runtime_available";
    fallback_http: boolean;
    consecutive_failures: number;
    last_error: "redacted" | null;
  };
  log_audit: {
    request_logger: "enabled";
    file_log_configured: boolean;
    rotation_configured: boolean;
    audit_storage: "available" | "not_available";
  };
  optional_dependencies: {
    embedding_provider: "available" | "unavailable" | "not_configured";
    qmd: "available" | "unavailable" | "not_configured";
  };
}

async function withTimeout<T>(
  task: Promise<T>,
  fallback: T,
  timeoutMs = OPTIONAL_TIMEOUT_MS,
): Promise<T> {
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

async function probeUrl(url: string, headers: Record<string, string>): Promise<boolean> {
  try {
    const resp = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(OPTIONAL_TIMEOUT_MS),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

async function readMigrationStatus(pool: pg.Pool): Promise<OperatorDoctorStatus["migrations"]> {
  let files: string[];
  try {
    files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  } catch {
    // Never let a filesystem error propagate: thrown messages can carry raw
    // paths into MCP tool error text or Express error pages.
    return {
      status: "unknown",
      applied_count: null,
      expected_count: 0,
      pending_count: null,
      latest_applied: null,
      latest_expected: null,
    };
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
  } catch {
    return {
      status: "unknown",
      applied_count: null,
      expected_count: files.length,
      pending_count: null,
      latest_applied: null,
      latest_expected: latestExpected,
    };
  }
}

async function checkEmbeddingAvailability(): Promise<boolean> {
  const baseUrl = process.env.EMBEDDING_BASE_URL?.replace(/\/+$/, "");
  if (!baseUrl) return false;
  const headers: Record<string, string> = {};
  if (process.env.EMBEDDING_API_KEY) {
    headers.Authorization = `Bearer ${process.env.EMBEDDING_API_KEY}`;
  }
  return withTimeout(probeUrl(`${baseUrl}/models`, headers), false);
}

async function checkQmdAvailability(): Promise<boolean | null> {
  if (!process.env.QMD_PATH) return null;
  try {
    const proc = Bun.spawn(["bun", process.env.QMD_PATH, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const result = await withTimeout(
      (async () => {
        await new Response(proc.stdout).text();
        await new Response(proc.stderr).text();
        return (await proc.exited) === 0;
      })(),
      false,
    );
    if (!result) proc.kill();
    return result;
  } catch {
    return false;
  }
}

function qmdStatus(available: boolean | null): "available" | "unavailable" | "not_configured" {
  if (available === null) return "not_configured";
  return available ? "available" : "unavailable";
}

export async function buildOperatorDoctorStatus(
  pool: pg.Pool,
  natsRuntimeBoundary: NatsRuntimeBoundary,
  natsBridgeHealth?: NatsBridgeHealth,
): Promise<OperatorDoctorStatus> {
  const [database, migrations, embeddingAvailable, qmdAvailable, serviceVersion] =
    await Promise.all([
      checkPoolHealth(pool),
      readMigrationStatus(pool),
      checkEmbeddingAvailability(),
      checkQmdAvailability(),
      readServiceVersion(),
    ]);

  const embeddingDiagnostics = getEmbeddingProviderDiagnostics();
  const transportAvailability =
    natsBridgeHealth?.availability ?? natsRuntimeBoundary.nats.availability;
  const transportDegraded =
    natsRuntimeBoundary.requested_transport === "nats" &&
    transportAvailability !== "available";
  const status =
    database.connected && migrations.status !== "pending" && !transportDegraded
      ? "healthy"
      : "degraded";
  const fileLogConfigured = Boolean(process.env.LOG_FILE?.trim());

  return {
    status,
    contract_version: DOCTOR_CONTRACT_VERSION,
    generated_at: new Date().toISOString(),
    runtime: {
      service: "open-brain",
      version: serviceVersion,
      contract_version: CONTRACT_VERSION,
      contract_schema_version: CONTRACT_SCHEMA_VERSION,
      node_env:
        process.env.NODE_ENV === "production" ||
        process.env.NODE_ENV === "development" ||
        process.env.NODE_ENV === "test"
          ? process.env.NODE_ENV
          : "unknown",
    },
    database,
    migrations,
    embedding_provider: {
      configured: embeddingDiagnostics.configured,
      available: embeddingAvailable,
      model: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      recent_failures: {
        last_failure_code: embeddingDiagnostics.last_failure_code,
        consecutive_restartable_failures:
          embeddingDiagnostics.consecutive_restartable_failures,
        restart_configured: embeddingDiagnostics.restart_configured,
        restart_in_flight: embeddingDiagnostics.restart_in_flight,
        last_restart_at: embeddingDiagnostics.last_restart_at,
      },
    },
    qmd: {
      configured: qmdAvailable !== null,
      available: qmdAvailable,
      status: qmdStatus(qmdAvailable),
    },
    transport: {
      mode: natsRuntimeBoundary.requested_transport,
      availability: transportAvailability,
      fallback_http: natsRuntimeBoundary.nats.fallback_http,
      consecutive_failures: natsBridgeHealth?.consecutiveFailures ?? 0,
      last_error: natsBridgeHealth?.lastError ? "redacted" : null,
    },
    log_audit: {
      request_logger: "enabled",
      file_log_configured: fileLogConfigured,
      rotation_configured:
        fileLogConfigured &&
        (Boolean(process.env.LOG_MAX_BYTES) || Boolean(process.env.LOG_MAX_FILES)),
      audit_storage: "not_available",
    },
    optional_dependencies: {
      embedding_provider: embeddingDiagnostics.configured
        ? embeddingAvailable
          ? "available"
          : "unavailable"
        : "not_configured",
      qmd: qmdStatus(qmdAvailable),
    },
  };
}
