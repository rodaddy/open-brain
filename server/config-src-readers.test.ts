/**
 * The env keys the remaining non-`server/` modules read, parsed at the door.
 *
 * Split into its own file rather than grown onto `server/config.test.ts` for
 * the same reason #868 split `config-equivalence.test.ts` out: each file stays
 * under the max-lines rule, so the shared REQUIRED baseline is repeated.
 *
 * Every expectation names the reader it mirrors by file and line. The readers
 * live under `src/`, which `server/` must not import, so a module-private
 * expression is written out beside its coordinates instead of being called —
 * an edit to either side then fails a test rather than drifting apart quietly.
 */
import { describe, expect, it } from "bun:test";
import { parseServerConfig } from "./config.ts";

const REQUIRED = {
  DB_HOST: "db.internal",
  DB_NAME: "open_brain_test",
  DB_USER: "open_brain",
  LOG_FILE: "logs/open-brain.log",
};

function configFrom(overrides: Record<string, string | undefined> = {}) {
  const result = parseServerConfig({ ...REQUIRED, ...overrides });
  if (!result.ok) {
    throw new Error(`expected valid configuration: ${JSON.stringify(result.issues)}`);
  }
  return result.config;
}

describe("embedding keys — src/embedding.ts", () => {
  it("defaults to the module constants when every key is unset", () => {
    const embedding = configFrom().embedding;
    // `:6-9`, `:36`, `:99-112`.
    expect(embedding.timeoutMs).toBe(8_000);
    expect(embedding.dimensions).toBe(768);
    expect(embedding.model).toBe("gemini-embedding-001");
    expect(embedding.watchdog.failureThreshold).toBe(2);
    expect(embedding.watchdog.cooldownMs).toBe(300_000);
    expect("restartScript" in embedding.watchdog).toBe(false);
  });

  it("carries a set value through", () => {
    const embedding = configFrom({
      EMBEDDING_TIMEOUT_MS: "1200",
      EMBEDDING_DIMENSIONS: "1536",
      EMBEDDING_MODEL: "embed-gemma-dense",
      EMBEDDING_WATCHDOG_FAILURE_THRESHOLD: "5",
      EMBEDDING_WATCHDOG_COOLDOWN_MS: "0",
      EMBEDDING_WATCHDOG_RESTART_SCRIPT: "/opt/bounce.sh",
    }).embedding;
    expect(embedding.timeoutMs).toBe(1_200);
    expect(embedding.dimensions).toBe(1_536);
    expect(embedding.model).toBe("embed-gemma-dense");
    expect(embedding.watchdog.failureThreshold).toBe(5);
    // Zero is a legal cooldown: the reader guards `< 0`, not `<= 0` (`:111`).
    expect(embedding.watchdog.cooldownMs).toBe(0);
    expect(embedding.watchdog.restartScript).toBe("/opt/bounce.sh");
  });

  it("falls back on a malformed value instead of rejecting it", () => {
    // Every reader here answers its default on `NaN` rather than throwing, so
    // an environment that boots today must still boot.
    const embedding = configFrom({
      EMBEDDING_TIMEOUT_MS: "abc",
      EMBEDDING_DIMENSIONS: "0",
      EMBEDDING_WATCHDOG_FAILURE_THRESHOLD: "-1",
      EMBEDDING_WATCHDOG_COOLDOWN_MS: "-1",
    }).embedding;
    expect(embedding.timeoutMs).toBe(8_000);
    expect(embedding.dimensions).toBe(768);
    expect(embedding.watchdog.failureThreshold).toBe(2);
    expect(embedding.watchdog.cooldownMs).toBe(300_000);
  });

  it("keeps `parseInt` semantics rather than `Number` ones", () => {
    // `parseInt("8000ms", 10)` is 8000 and `parseInt("1e3", 10)` is 1. A
    // `z.coerce.number()` mirror would answer NaN and 1000 — the second is a
    // thousand-fold divergence from a live deployment.
    const embedding = configFrom({
      EMBEDDING_TIMEOUT_MS: "9000ms",
      EMBEDDING_DIMENSIONS: "1e3",
    }).embedding;
    expect(embedding.timeoutMs).toBe(9_000);
    expect(embedding.dimensions).toBe(1);
  });

  it("treats a blank restart script as no restart configured", () => {
    // `:141` returns early on any falsy value.
    const embedding = configFrom({
      EMBEDDING_WATCHDOG_RESTART_SCRIPT: "",
    }).embedding;
    expect("restartScript" in embedding.watchdog).toBe(false);
  });
});

describe("promotion kill switch — src/promotion-service.ts:235", () => {
  it("is off when unset", () => {
    expect(configFrom().promotion.killSwitch).toBe(false);
  });

  it("is on for exactly `1`", () => {
    expect(
      configFrom({ OPENBRAIN_PROMOTION_KILL_SWITCH: "1" }).promotion.killSwitch,
    ).toBe(true);
  });

  it("stays off for any other truthy-looking value", () => {
    // The reader is `=== "1"`, so `true` does NOT stop promotion today.
    for (const value of ["true", "yes", "on", "0", ""]) {
      expect(
        configFrom({ OPENBRAIN_PROMOTION_KILL_SWITCH: value }).promotion.killSwitch,
      ).toBe(false);
    }
  });
});

describe("mcp audit — readMcpAuditConfig, src/audit-log.ts:134-157", () => {
  it("defaults to enabled with the constants at `:6-11`", () => {
    const audit = configFrom().mcpAudit;
    expect(audit.enabled).toBe(true);
    expect(audit.retentionDays).toBe(30);
    expect(audit.cleanupIntervalMs).toBe(60 * 60 * 1_000);
    expect(audit.writeTimeoutMs).toBe(1_000);
  });

  it("disables on exactly `0` and stays on otherwise", () => {
    expect(configFrom({ OPENBRAIN_MCP_AUDIT_ENABLED: "0" }).mcpAudit.enabled).toBe(
      false,
    );
    // Audit is on unless explicitly disabled: an omitted or unrecognized value
    // must never silently stop the record of who called what.
    expect(configFrom({ OPENBRAIN_MCP_AUDIT_ENABLED: "false" }).mcpAudit.enabled).toBe(
      true,
    );
  });

  it("carries an in-range value through", () => {
    const audit = configFrom({
      OPENBRAIN_MCP_AUDIT_RETENTION_DAYS: "366",
      OPENBRAIN_MCP_AUDIT_CLEANUP_INTERVAL_MS: "60000",
      OPENBRAIN_MCP_AUDIT_WRITE_TIMEOUT_MS: "50",
    }).mcpAudit;
    expect(audit.retentionDays).toBe(366);
    expect(audit.cleanupIntervalMs).toBe(60_000);
    expect(audit.writeTimeoutMs).toBe(50);
  });

  it("falls back outside the range and on a non-digit value", () => {
    // `readBoundedInt` tests `/^[0-9]+$/` BEFORE parsing (`:166`), so `1.5` and
    // `1000ms` fall back here where bare `parseInt` would answer 1 and 1000.
    const audit = configFrom({
      OPENBRAIN_MCP_AUDIT_RETENTION_DAYS: "367",
      OPENBRAIN_MCP_AUDIT_CLEANUP_INTERVAL_MS: "1000ms",
      OPENBRAIN_MCP_AUDIT_WRITE_TIMEOUT_MS: "1.5",
    }).mcpAudit;
    expect(audit.retentionDays).toBe(30);
    expect(audit.cleanupIntervalMs).toBe(60 * 60 * 1_000);
    expect(audit.writeTimeoutMs).toBe(1_000);
  });
});

describe("doctor — src/operator-doctor.ts", () => {
  it("has no index path and an unknown node environment when unset", () => {
    const doctor = configFrom().doctor;
    // `:433` branches on `!== undefined`, so absent means the doctor's own
    // default rather than a value chosen here.
    expect("qmdIndexPath" in doctor).toBe(false);
    expect(doctor.nodeEnvironment).toBe("unknown");
    expect(doctor.rotationConfigured).toBe(false);
  });

  it("carries a set index path through untrimmed, blank included", () => {
    expect(configFrom({ QMD_INDEX_PATH: "/srv/i.sqlite" }).doctor.qmdIndexPath).toBe(
      "/srv/i.sqlite",
    );
    // Deliberately not blank-as-absent: `:433` sees a present variable.
    expect(configFrom({ QMD_INDEX_PATH: "" }).doctor.qmdIndexPath).toBe("");
  });

  it("recognizes only the three node environments at `:649-652`", () => {
    for (const value of ["production", "development", "test"] as const) {
      expect(configFrom({ NODE_ENV: value }).doctor.nodeEnvironment).toBe(value);
    }
    expect(configFrom({ NODE_ENV: "staging" }).doctor.nodeEnvironment).toBe("unknown");
  });

  it("reports rotation configured when either variable carries a value", () => {
    // `:685-686` is an OR over two `Boolean(...)` tests.
    expect(configFrom({ LOG_MAX_BYTES: "1048576" }).doctor.rotationConfigured).toBe(
      true,
    );
    expect(configFrom({ LOG_MAX_FILES: "5" }).doctor.rotationConfigured).toBe(true);
    expect(configFrom({ LOG_MAX_BYTES: "" }).doctor.rotationConfigured).toBe(false);
  });
});

describe("drop-folder scan bounds — src/drop-folder-collector.ts:19-42", () => {
  it("defaults to DEFAULT_DROP_COLLECTOR_BOUNDS when every key is unset", () => {
    const bounds = configFrom().dropCollector;
    // `server/capture/drop-folder-contract.ts:51-56`.
    expect(bounds.files).toBe(256);
    expect(bounds.fileBytes).toBe(1_048_576);
    expect(bounds.totalBytes).toBe(16_777_216);
    expect(bounds.depth).toBe(8);
    // Absent, not zero: the collector derives the entry bound from `files`.
    expect("scanEntries" in bounds).toBe(false);
  });

  it("takes each configured override", () => {
    const bounds = configFrom({
      DROP_COLLECTOR_MAX_FILES: "12",
      DROP_COLLECTOR_MAX_FILE_BYTES: "2048",
      DROP_COLLECTOR_MAX_TOTAL_BYTES: "4096",
      DROP_COLLECTOR_MAX_DEPTH: "3",
      DROP_COLLECTOR_MAX_SCAN_ENTRIES: "77",
    }).dropCollector;
    expect(bounds.files).toBe(12);
    expect(bounds.fileBytes).toBe(2048);
    expect(bounds.totalBytes).toBe(4096);
    expect(bounds.depth).toBe(3);
    expect(bounds.scanEntries).toBe(77);
  });

  it("falls back on every value `boundedInt` rejects at `:19-24`", () => {
    // `!raw`, then a non-integer or non-positive parse: blank, zero, negative,
    // and a word all take the fallback rather than rejecting the config.
    for (const value of ["", "0", "-4", "nope"]) {
      expect(configFrom({ DROP_COLLECTOR_MAX_FILES: value }).dropCollector.files).toBe(
        256,
      );
    }
    // `parseInt("1.5", 10)` is 1 to the reader at `:22`, which is a positive
    // integer and therefore wins. Recorded rather than tidied: the bar is
    // start-equivalence with the adapter, not a nicer parse.
    expect(configFrom({ DROP_COLLECTOR_MAX_FILES: "1.5" }).dropCollector.files).toBe(1);
  });

  it("keeps the base-10 `parseInt` reading of a trailing suffix", () => {
    // `parseInt("512files", 10)` is 512 to the reader at `:22`, not NaN.
    expect(
      configFrom({ DROP_COLLECTOR_MAX_FILE_BYTES: "512files" }).dropCollector.fileBytes,
    ).toBe(512);
  });

  it("omits `scanEntries` for any value at or below zero — `:38`", () => {
    for (const value of ["0", "-1", ""]) {
      const bounds = configFrom({
        DROP_COLLECTOR_MAX_SCAN_ENTRIES: value,
      }).dropCollector;
      expect("scanEntries" in bounds).toBe(false);
    }
  });
});
