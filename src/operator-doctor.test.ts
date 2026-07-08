import { afterEach, describe, expect, it } from "bun:test";
import { buildOperatorDoctorStatus } from "./operator-doctor.ts";
import { readNatsRuntimeBoundary } from "./nats-runtime.ts";

const originalFetch = globalThis.fetch;

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

afterEach(() => {
  (globalThis as Record<string, unknown>).fetch = originalFetch;
  delete process.env.EMBEDDING_BASE_URL;
  delete process.env.EMBEDDING_API_KEY;
  delete process.env.QMD_PATH;
  delete process.env.LOG_FILE;
  delete process.env.LOG_MAX_BYTES;
  delete process.env.LOG_MAX_FILES;
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

    expect(status.contract_version).toBe("2026-07-08.operator-doctor.v1");
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
    expect(status.qmd.status).toBe("not_configured");
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(embeddingHost);
    expect(serialized).not.toContain(logPath);
  });

  it("bounds optional dependency failures without making the service unhealthy", async () => {
    process.env.EMBEDDING_BASE_URL = "http://embedding.internal:8791/v1";
    (globalThis as Record<string, unknown>).fetch = () =>
      Promise.reject(new Error("connection refused"));

    const status = await buildOperatorDoctorStatus(
      makePoolWithUnknownMigrations(),
      readNatsRuntimeBoundary({}),
    );

    expect(status.status).toBe("healthy");
    expect(status.migrations.status).toBe("unknown");
    expect(status.embedding_provider.available).toBe(false);
    expect(status.optional_dependencies.embedding_provider).toBe("unavailable");
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
});
