import { afterEach, describe, expect, it } from "bun:test";
import { readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DOCTOR_CONTRACT_VERSION,
  buildOperatorDoctorStatus,
  canReadDoctor,
  getOperatorDoctorStatus,
  resetOperatorDoctorCache,
} from "./operator-doctor.ts";
import { readNatsRuntimeBoundary } from "./nats-runtime.ts";

const originalFetch = globalThis.fetch;
const THIS_FILE = fileURLToPath(import.meta.url);

function makePool(appliedFilenames: string[]) {
  return {
    totalCount: 1,
    idleCount: 1,
    waitingCount: 0,
    query: async (sql: string) => {
      if (sql.trim() === "SELECT 1") return { rows: [{ ok: 1 }] };
      if (sql.includes("FROM _migrations")) {
        return { rows: appliedFilenames.map((filename) => ({ filename })) };
      }
      return { rows: [] };
    },
  } as any;
}

function makePoolWithUnknownMigrations() {
  return {
    totalCount: 1,
    idleCount: 1,
    waitingCount: 0,
    query: async (sql: string) => {
      if (sql.trim() === "SELECT 1") return { rows: [{ ok: 1 }] };
      if (sql.includes("FROM _migrations")) throw new Error("not available");
      return { rows: [] };
    },
  } as any;
}

// Pool that reports every on-disk migration as applied: migrations "current".
async function makeCurrentPool() {
  const migrationsDir = join(dirname(THIS_FILE), "db", "migrations");
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql"));
  return makePool(files);
}

function makeDownPool() {
  return {
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
    query: async () => {
      throw new Error("connection refused");
    },
  } as any;
}

afterEach(() => {
  (globalThis as Record<string, unknown>).fetch = originalFetch;
  delete process.env.EMBEDDING_BASE_URL;
  delete process.env.EMBEDDING_API_KEY;
  delete process.env.QMD_PATH;
  delete process.env.LOG_FILE;
  delete process.env.LOG_MAX_BYTES;
  delete process.env.LOG_MAX_FILES;
  resetOperatorDoctorCache();
});

describe("operator doctor status", () => {
  it("returns stable privileged JSON without raw env values or sensitive paths", async () => {
    const secret = "doctor-secret-token";
    const embeddingHost = "embedding.internal";
    const logPath = "/sensitive/open-brain.log";
    process.env.EMBEDDING_BASE_URL = `http://${embeddingHost}:8791/v1`;
    process.env.EMBEDDING_API_KEY = secret;
    process.env.LOG_FILE = logPath;
    process.env.LOG_MAX_BYTES = "1000";
    process.env.QMD_PATH = THIS_FILE;

    (globalThis as Record<string, unknown>).fetch = (
      input: string | URL | globalThis.Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toContain("/models");
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${secret}` });
      return Promise.resolve(new Response("{}", { status: 200 }));
    };

    const status = await buildOperatorDoctorStatus(
      makePool(["001_init.sql"]),
      readNatsRuntimeBoundary({}),
    );
    const serialized = JSON.stringify(status);

    expect(status.contract_version).toBe("2026-07-08.operator-doctor.v2");
    expect(status.runtime.contract_version).toBe("2026-07-08.memory-tools.v20");
    expect(status.database.connected).toBe(true);
    expect(status.embedding_provider).toMatchObject({
      configured: true,
      available: true,
    });
    expect(status.log_audit).toMatchObject({
      request_logger: "enabled",
      file_log_configured: true,
      rotation_configured: true,
      audit_storage: "not_available",
    });
    // QMD_PATH points at an existing file: binary presence only.
    expect(status.qmd).toEqual({
      configured: true,
      path_source: "env",
      available: true,
      status: "available",
    });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(embeddingHost);
    expect(serialized).not.toContain(logPath);
    // The resolved qmd path must never appear in the payload.
    expect(serialized).not.toContain(THIS_FILE);
  });

  it("resolves qmd via the same search_all resolution and reports missing binaries as unavailable", async () => {
    delete process.env.EMBEDDING_BASE_URL;
    process.env.QMD_PATH = "/nonexistent/qmd-entrypoint.ts";

    const status = await buildOperatorDoctorStatus(
      await makeCurrentPool(),
      readNatsRuntimeBoundary({}),
    );

    expect(status.qmd).toEqual({
      configured: true,
      path_source: "env",
      available: false,
      status: "unavailable",
    });
    expect(status.optional_dependencies.qmd).toBe("unavailable");
    // qmd is an optional dependency: presence/absence never changes the tier.
    expect(status.status).toBe("healthy");
    expect(JSON.stringify(status)).not.toContain("/nonexistent/qmd-entrypoint.ts");
  });

  it("falls back to the shared default qmd path when QMD_PATH is unset", async () => {
    delete process.env.QMD_PATH;

    const status = await buildOperatorDoctorStatus(
      makePool(["001_init.sql"]),
      readNatsRuntimeBoundary({}),
    );

    // Unset env is NOT "not configured": search_all runs the default path.
    expect(status.qmd.configured).toBe(true);
    expect(status.qmd.path_source).toBe("default");
    expect(status.qmd.status).toBe(
      status.qmd.available ? "available" : "unavailable",
    );
  });

  it("degrades (never unhealthy) when a configured embedding provider is unavailable", async () => {
    process.env.EMBEDDING_BASE_URL = "http://embedding.internal:8791/v1";
    (globalThis as Record<string, unknown>).fetch = () =>
      Promise.reject(new Error("connection refused"));

    const status = await buildOperatorDoctorStatus(
      await makeCurrentPool(),
      readNatsRuntimeBoundary({}),
    );

    // Configured-but-down embedding hard-fails vector search: degraded,
    // but never unhealthy -- that tier is reserved for DB failure.
    expect(status.status).toBe("degraded");
    expect(status.database.connected).toBe(true);
    expect(status.migrations.status).toBe("current");
    expect(status.embedding_provider.available).toBe(false);
    expect(status.optional_dependencies.embedding_provider).toBe("unavailable");
  });

  it("stays healthy when the embedding provider is simply not configured", async () => {
    delete process.env.EMBEDDING_BASE_URL;

    const status = await buildOperatorDoctorStatus(
      await makeCurrentPool(),
      readNatsRuntimeBoundary({}),
    );

    expect(status.status).toBe("healthy");
    expect(status.embedding_provider.configured).toBe(false);
    expect(status.optional_dependencies.embedding_provider).toBe("not_configured");
  });

  it("degrades when the DB is connected but migration state is unknown", async () => {
    delete process.env.EMBEDDING_BASE_URL;

    const status = await buildOperatorDoctorStatus(
      makePoolWithUnknownMigrations(),
      readNatsRuntimeBoundary({}),
    );

    // Unknown migration state on a connected DB is an unverified or broken
    // schema, not a healthy service.
    expect(status.status).toBe("degraded");
    expect(status.database.connected).toBe(true);
    expect(status.migrations.status).toBe("unknown");
  });

  it("reports pending migrations as degraded operator status", async () => {
    const status = await buildOperatorDoctorStatus(
      makePool([]),
      readNatsRuntimeBoundary({}),
    );

    expect(status.status).toBe("degraded");
    expect(status.migrations.status).toBe("pending");
    expect(status.migrations.pending_count).toBeGreaterThan(0);
    expect(status.migrations.latest_expected).toMatch(/\.sql$/);
  });

  it("reports a hard database failure as unhealthy, distinct from degraded", async () => {
    const status = await buildOperatorDoctorStatus(
      makeDownPool(),
      readNatsRuntimeBoundary({}),
    );

    expect(status.status).toBe("unhealthy");
    expect(status.database.connected).toBe(false);
  });

  it("locks the exact doctor payload shape to DOCTOR_CONTRACT_VERSION", async () => {
    // ANY field addition or removal in this payload (top-level or per
    // section) requires bumping DOCTOR_CONTRACT_VERSION in
    // src/operator-doctor.ts. Update the version literal and these field
    // sets together, never one without the other.
    expect(DOCTOR_CONTRACT_VERSION).toBe("2026-07-08.operator-doctor.v2");

    const status = await buildOperatorDoctorStatus(
      makePool(["001_init.sql"]),
      readNatsRuntimeBoundary({}),
    );

    expect(Object.keys(status).sort()).toEqual([
      "contract_version",
      "database",
      "embedding_provider",
      "generated_at",
      "log_audit",
      "migrations",
      "optional_dependencies",
      "qmd",
      "runtime",
      "status",
      "transport",
    ]);
    expect(Object.keys(status.runtime).sort()).toEqual([
      "contract_schema_version",
      "contract_version",
      "node_env",
      "service",
      "version",
    ]);
    expect(Object.keys(status.database).sort()).toEqual([
      "connected",
      "idle",
      "total",
      "waiting",
    ]);
    expect(Object.keys(status.migrations).sort()).toEqual([
      "applied_count",
      "expected_count",
      "latest_applied",
      "latest_expected",
      "pending_count",
      "status",
    ]);
    expect(Object.keys(status.embedding_provider).sort()).toEqual([
      "available",
      "configured",
      "dimensions",
      "model",
      "recent_failures",
    ]);
    expect(Object.keys(status.embedding_provider.recent_failures).sort()).toEqual([
      "consecutive_restartable_failures",
      "last_failure_code",
      "last_restart_at",
      "restart_configured",
      "restart_in_flight",
    ]);
    expect(Object.keys(status.qmd).sort()).toEqual([
      "available",
      "configured",
      "path_source",
      "status",
    ]);
    expect(Object.keys(status.transport).sort()).toEqual([
      "availability",
      "consecutive_failures",
      "fallback_http",
      "last_error",
      "mode",
    ]);
    expect(Object.keys(status.log_audit).sort()).toEqual([
      "audit_storage",
      "file_log_configured",
      "request_logger",
      "rotation_configured",
    ]);
    expect(Object.keys(status.optional_dependencies).sort()).toEqual([
      "embedding_provider",
      "qmd",
    ]);
  });
});

describe("operator doctor cache", () => {
  it("shares one probe cycle across concurrent callers (single-flight)", async () => {
    resetOperatorDoctorCache();
    let probeCycles = 0;
    const pool = {
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
      query: async (sql: string) => {
        if (sql.trim() === "SELECT 1") {
          probeCycles += 1;
          // Keep the build in flight long enough for the second caller to
          // arrive while the first is still building.
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { rows: [{ ok: 1 }] };
        }
        if (sql.includes("FROM _migrations")) {
          return { rows: [{ filename: "001_init.sql" }] };
        }
        return { rows: [] };
      },
    } as any;
    const boundary = readNatsRuntimeBoundary({});

    const [first, second] = await Promise.all([
      getOperatorDoctorStatus(pool, boundary),
      getOperatorDoctorStatus(pool, boundary),
    ]);

    expect(probeCycles).toBe(1);
    expect(first).toBe(second);
  });

  it("serves cached results within the TTL and rebuilds after expiry", async () => {
    resetOperatorDoctorCache();
    let probeCycles = 0;
    const pool = {
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
      query: async (sql: string) => {
        if (sql.trim() === "SELECT 1") probeCycles += 1;
        if (sql.includes("FROM _migrations")) {
          return { rows: [{ filename: "001_init.sql" }] };
        }
        return { rows: [{ ok: 1 }] };
      },
    } as any;
    const boundary = readNatsRuntimeBoundary({});
    let clock = 0;
    const options = { ttlMs: 5_000, now: () => clock };

    const first = await getOperatorDoctorStatus(pool, boundary, undefined, options);
    clock = 4_999;
    const cached = await getOperatorDoctorStatus(pool, boundary, undefined, options);
    expect(probeCycles).toBe(1);
    expect(cached).toBe(first);

    clock = 5_001;
    const rebuilt = await getOperatorDoctorStatus(pool, boundary, undefined, options);
    expect(probeCycles).toBe(2);
    expect(rebuilt).not.toBe(first);
  });

  it("rebuilds immediately after resetOperatorDoctorCache", async () => {
    resetOperatorDoctorCache();
    const boundary = readNatsRuntimeBoundary({});
    const first = await getOperatorDoctorStatus(makePool(["001_init.sql"]), boundary);
    resetOperatorDoctorCache();
    const second = await getOperatorDoctorStatus(makeDownPool(), boundary);

    expect(first.status).toBe("degraded");
    expect(second.status).toBe("unhealthy");
    expect(second).not.toBe(first);
  });
});

describe("canReadDoctor", () => {
  it("permits only admin and ob-admin roles", () => {
    expect(canReadDoctor({ role: "admin", clientId: "a" } as any)).toBe(true);
    expect(canReadDoctor({ role: "ob-admin", clientId: "b" } as any)).toBe(true);
    expect(canReadDoctor({ role: "agent", clientId: "c" } as any)).toBe(false);
    expect(canReadDoctor({ role: "readonly", clientId: "d" } as any)).toBe(false);
    expect(canReadDoctor(undefined)).toBe(false);
  });
});
