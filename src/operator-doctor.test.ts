import { afterEach, describe, expect, it } from "bun:test";
import { readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DISTILLATION_LAG_CRITICAL_RATIO,
  DISTILLATION_LAG_TTL_SECONDS_DEFAULT,
  DISTILLATION_LAG_WARNING_RATIO,
  DOCTOR_CONTRACT_VERSION,
  buildOperatorDoctorStatus,
  canReadDoctor,
  classifyDistillationLag,
  getOperatorDoctorStatus,
  readDistillationLagTtlSeconds,
  resetOperatorDoctorCache,
} from "./operator-doctor.ts";
import { readNatsRuntimeBoundary } from "./nats-runtime.ts";
import { addLogSink } from "./logger.ts";

const originalFetch = globalThis.fetch;
const THIS_FILE = fileURLToPath(import.meta.url);
type QueryInput = string | { text: string; values?: readonly unknown[] };

function queryText(query: QueryInput): string {
  return typeof query === "string" ? query : query.text;
}

function makePool(
  appliedFilenames: string[],
  auditProbe: "reachable" | "throws" = "reachable",
  onAuditProbe?: () => void,
  distillationLagRows: Array<Record<string, unknown>> | "throws" = [],
) {
  return {
    totalCount: 1,
    idleCount: 1,
    waitingCount: 0,
    query: async (query: QueryInput) => {
      const sql = queryText(query);
      if (sql.trim() === "SELECT 1") return { rows: [{ ok: 1 }] };
      if (sql.includes("FROM _migrations")) {
        return { rows: appliedFilenames.map((filename) => ({ filename })) };
      }
      if (sql.includes("to_regclass")) {
        onAuditProbe?.();
        if (auditProbe === "throws") throw new Error("audit table unavailable");
        return { rows: [{ table_name: "mcp_tool_audit_log" }] };
      }
      if (sql.includes("FROM ob_raw_turns")) {
        if (distillationLagRows === "throws") {
          throw new Error("distillation lag unavailable");
        }
        const exclusion = sql.match(/namespace\s+NOT\s+LIKE\s+\$(\d+)/i);
        if (!exclusion) return { rows: distillationLagRows };
        const value =
          typeof query === "string"
            ? undefined
            : query.values?.[Number(exclusion[1]) - 1];
        if (typeof value !== "string" || !value.endsWith("%")) {
          throw new Error("unsupported namespace exclusion");
        }
        const prefix = value.slice(0, -1);
        return {
          rows: distillationLagRows.filter(
            (row) =>
              typeof row.namespace !== "string" ||
              !row.namespace.startsWith(prefix),
          ),
        };
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
    query: async (query: QueryInput) => {
      const sql = queryText(query);
      if (sql.trim() === "SELECT 1") return { rows: [{ ok: 1 }] };
      if (sql.includes("FROM _migrations")) throw new Error("not available");
      return { rows: [] };
    },
  } as any;
}

// Pool that reports every on-disk migration as applied: migrations "current".
async function makeCurrentPool(
  distillationLagRows: Array<Record<string, unknown>> | "throws" = [],
) {
  const migrationsDir = join(dirname(THIS_FILE), "db", "migrations");
  const files = (await readdir(migrationsDir)).filter((f) =>
    f.endsWith(".sql"),
  );
  return makePool(files, "reachable", undefined, distillationLagRows);
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
  delete process.env.OPENBRAIN_MCP_AUDIT_ENABLED;
  delete process.env.OPENBRAIN_RAW_TURN_TTL_SECONDS;
  resetOperatorDoctorCache();
});

describe("distillation lag classification", () => {
  it("crosses the warning and critical TTL ratios at their exact thresholds", () => {
    expect(classifyDistillationLag(DISTILLATION_LAG_WARNING_RATIO - 0.01)).toBe(
      "ok",
    );
    expect(classifyDistillationLag(DISTILLATION_LAG_WARNING_RATIO)).toBe(
      "warning",
    );
    expect(classifyDistillationLag(DISTILLATION_LAG_CRITICAL_RATIO)).toBe(
      "critical",
    );
  });

  it("uses the documented one-week TTL unless config supplies a positive integer", () => {
    expect(readDistillationLagTtlSeconds({})).toBe(
      DISTILLATION_LAG_TTL_SECONDS_DEFAULT,
    );
    expect(
      readDistillationLagTtlSeconds({
        OPENBRAIN_RAW_TURN_TTL_SECONDS: "86400",
      }),
    ).toBe(86400);
    expect(
      readDistillationLagTtlSeconds({
        OPENBRAIN_RAW_TURN_TTL_SECONDS: "invalid",
      }),
    ).toBe(DISTILLATION_LAG_TTL_SECONDS_DEFAULT);
  });
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
      expect(init?.headers).toMatchObject({
        Authorization: `Bearer ${secret}`,
      });
      return Promise.resolve(new Response("{}", { status: 200 }));
    };

    const status = await buildOperatorDoctorStatus(
      makePool(["001_init.sql"]),
      readNatsRuntimeBoundary({}),
    );
    const serialized = JSON.stringify(status);

    expect(status.contract_version).toBe("2026-08-05.operator-doctor.v3");
    expect(status.runtime.contract_version).toBe("2026-07-23.memory-tools.v23");
    expect(status.database.connected).toBe(true);
    expect(status.embedding_provider).toMatchObject({
      configured: true,
      available: true,
    });
    expect(status.log_audit).toMatchObject({
      request_logger: "enabled",
      file_log_configured: true,
      rotation_configured: true,
      audit_storage: "available",
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

  it("reports content-free distillation lag separately for each namespace", async () => {
    const status = await buildOperatorDoctorStatus(
      await makeCurrentPool([
        {
          namespace: "alpha",
          undistilled_depth: "4",
          oldest_undistilled_age_seconds: "241920",
          ratio: "0.4",
          content: "must-not-leak",
          content_hash: "must-not-leak-hash",
          id: "must-not-leak-id",
        },
        {
          namespace: "beta",
          undistilled_depth: "7",
          oldest_undistilled_age_seconds: "483840",
          ratio: "0.8",
        },
      ]),
      readNatsRuntimeBoundary({}),
    );

    expect(status.distillation_lag).toEqual([
      {
        namespace: "alpha",
        undistilled_depth: 4,
        oldest_undistilled_age_seconds: 241920,
        ratio: 0.4,
        level: "ok",
      },
      {
        namespace: "beta",
        undistilled_depth: 7,
        oldest_undistilled_age_seconds: 483840,
        ratio: 0.8,
        level: "critical",
      },
    ]);
    expect(status.status).toBe("degraded");
    expect(JSON.stringify(status)).not.toContain("must-not-leak");
  });

  it("excludes parity raw-turn fixtures from operator-actionable lag", async () => {
    const status = await buildOperatorDoctorStatus(
      await makeCurrentPool([
        {
          namespace: "customer-live",
          undistilled_depth: "2",
          oldest_undistilled_age_seconds: "302400",
          ratio: "0.5",
        },
        {
          namespace: "parity-raw-turn-admin",
          undistilled_depth: "9",
          oldest_undistilled_age_seconds: "544320",
          ratio: "0.9",
        },
      ]),
      readNatsRuntimeBoundary({}),
    );

    expect(status.distillation_lag).toEqual([
      {
        namespace: "customer-live",
        undistilled_depth: 2,
        oldest_undistilled_age_seconds: 302400,
        ratio: 0.5,
        level: "warning",
      },
    ]);
    expect(status.status).toBe("healthy");
  });

  it("keeps warning-level lag healthy", async () => {
    const warning = await buildOperatorDoctorStatus(
      await makeCurrentPool([
        {
          namespace: "alpha",
          undistilled_depth: "1",
          oldest_undistilled_age_seconds: "302400",
          ratio: String(DISTILLATION_LAG_WARNING_RATIO),
        },
      ]),
      readNatsRuntimeBoundary({}),
    );

    expect(warning.distillation_lag[0]?.level).toBe("warning");
    expect(warning.status).toBe("healthy");
  });

  it("falls back content-free when the distillation lag probe fails", async () => {
    const status = await buildOperatorDoctorStatus(
      await makeCurrentPool("throws"),
      readNatsRuntimeBoundary({}),
    );

    expect(status.distillation_lag).toEqual([]);
    expect(status.status).toBe("healthy");
  });

  it("reports audit storage as available when audit is enabled and the table is reachable", async () => {
    const status = await buildOperatorDoctorStatus(
      makePool(["001_init.sql"]),
      readNatsRuntimeBoundary({}),
    );

    expect(status.log_audit.audit_storage).toBe("available");
  });

  it("reports audit storage as not available without probing when audit is disabled", async () => {
    process.env.OPENBRAIN_MCP_AUDIT_ENABLED = "0";
    let auditProbeCount = 0;

    const status = await buildOperatorDoctorStatus(
      makePool(["001_init.sql"], "reachable", () => {
        auditProbeCount += 1;
      }),
      readNatsRuntimeBoundary({}),
    );

    expect(status.log_audit.audit_storage).toBe("not_available");
    expect(auditProbeCount).toBe(0);
  });

  it("reports audit storage as not available when the table probe throws", async () => {
    const status = await buildOperatorDoctorStatus(
      makePool(["001_init.sql"], "throws"),
      readNatsRuntimeBoundary({}),
    );

    expect(status.log_audit.audit_storage).toBe("not_available");
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
    expect(JSON.stringify(status)).not.toContain(
      "/nonexistent/qmd-entrypoint.ts",
    );
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
    expect(status.optional_dependencies.embedding_provider).toBe(
      "not_configured",
    );
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
    expect(DOCTOR_CONTRACT_VERSION).toBe("2026-08-05.operator-doctor.v3");

    const status = await buildOperatorDoctorStatus(
      makePool(["001_init.sql"], "reachable", undefined, [
        {
          namespace: "shape-lock",
          undistilled_depth: "1",
          oldest_undistilled_age_seconds: "1",
          ratio: "0",
        },
      ]),
      readNatsRuntimeBoundary({}),
    );

    expect(Object.keys(status).sort()).toEqual([
      "contract_version",
      "database",
      "distillation_lag",
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
    expect(Object.keys(status.distillation_lag[0] ?? {}).sort()).toEqual([
      "level",
      "namespace",
      "oldest_undistilled_age_seconds",
      "ratio",
      "undistilled_depth",
    ]);
    expect(Object.keys(status.embedding_provider).sort()).toEqual([
      "available",
      "configured",
      "dimensions",
      "model",
      "recent_failures",
    ]);
    expect(
      Object.keys(status.embedding_provider.recent_failures).sort(),
    ).toEqual([
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
      query: async (query: QueryInput) => {
        const sql = queryText(query);
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

  it("logs a build failure at the owning boundary and still re-throws", async () => {
    // Both consumers -- the REST route in src/index.ts and the MCP tool --
    // convert this rejection into a deliberately content-free response, so the
    // reason existed nowhere: a 500 in an access log and nothing else. It is
    // logged here, once, because the in-flight promise is shared across
    // concurrent callers.
    resetOperatorDoctorCache();
    const lines: Array<Record<string, unknown>> = [];
    const detach = addLogSink((entry) => lines.push(entry));
    // Each individual probe inside buildOperatorDoctorStatus catches its own
    // failure and degrades -- that is deliberate and stays. Reaching the outer
    // rejection therefore needs a fault OUTSIDE those guards: here the pool's
    // own count accessor throws, which checkPoolHealth reads before its try.
    const pool = {
      get totalCount(): number {
        throw Object.assign(new Error("pool handle destroyed"), {
          code: "53300",
        });
      },
      idleCount: 0,
      waitingCount: 0,
      query: async () => ({ rows: [{ ok: 1 }] }),
    } as any;
    const boundary = readNatsRuntimeBoundary({});

    try {
      // Two concurrent callers share one in-flight build, so one failure must
      // produce exactly one line -- not one per waiter.
      const results = await Promise.allSettled([
        getOperatorDoctorStatus(pool, boundary),
        getOperatorDoctorStatus(pool, boundary),
      ]);
      // Re-thrown unchanged: callers still decide what the response says.
      expect(results.every((r) => r.status === "rejected")).toBe(true);

      const failures = lines.filter(
        (l) => l.message === "doctor_status_build_failed",
      );
      expect(failures.length).toBe(1);
      expect(failures[0]!.level).toBe("error");
      expect(failures[0]!.error_message).toContain("pool handle destroyed");
      // The pg SQLSTATE survives to the log, which is the whole point.
      expect((failures[0]!.driver as Record<string, string>).code).toBe(
        "53300",
      );
    } finally {
      detach();
      resetOperatorDoctorCache();
    }
  });

  it("serves cached results within the TTL and rebuilds after expiry", async () => {
    resetOperatorDoctorCache();
    let probeCycles = 0;
    const pool = {
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
      query: async (query: QueryInput) => {
        const sql = queryText(query);
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

    const first = await getOperatorDoctorStatus(
      pool,
      boundary,
      undefined,
      options,
    );
    clock = 4_999;
    const cached = await getOperatorDoctorStatus(
      pool,
      boundary,
      undefined,
      options,
    );
    expect(probeCycles).toBe(1);
    expect(cached).toBe(first);

    clock = 5_001;
    const rebuilt = await getOperatorDoctorStatus(
      pool,
      boundary,
      undefined,
      options,
    );
    expect(probeCycles).toBe(2);
    expect(rebuilt).not.toBe(first);
  });

  it("rebuilds immediately after resetOperatorDoctorCache", async () => {
    resetOperatorDoctorCache();
    const boundary = readNatsRuntimeBoundary({});
    const first = await getOperatorDoctorStatus(
      makePool(["001_init.sql"]),
      boundary,
    );
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
    expect(canReadDoctor({ role: "ob-admin", clientId: "b" } as any)).toBe(
      true,
    );
    expect(canReadDoctor({ role: "agent", clientId: "c" } as any)).toBe(false);
    expect(canReadDoctor({ role: "readonly", clientId: "d" } as any)).toBe(
      false,
    );
    expect(canReadDoctor(undefined)).toBe(false);
  });
});
