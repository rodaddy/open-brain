/**
 * Structured logging boundary tests.
 * Design authority: `_DOCS/STANDARDS-observability.md`.
 */
import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { DestinationStream } from "pino";
import { withCorrelation } from "./context.ts";
import { createLogger, withOperation, workerLogPath } from "./logger.ts";
import { sanitizeValue } from "./sanitize.ts";

// A repo-relative scratch dir, never `/tmp` or `$TMPDIR`: those are
// sandbox-local, so a runner, a sandbox, and the host each see a different one
// and anything written there is invisible to the others (Development
// AGENTS.md, hard rule).
//
// Repo-relative rather than the shared `{temp_workspace}` path, because this
// runs in CI too. An absolute `/Volumes/...` default is unwritable on the Linux
// runner and fails with `EACCES: permission denied, mkdir '/Volumes'` — which
// is exactly how the first push of this test failed. `_scratch/` is already
// gitignored and already used by `src/operator-doctor.test.ts`.
const SCRATCH_ROOT =
  process.env.OPENBRAIN_TEST_SCRATCH_DIR ?? join(import.meta.dir, "../../_scratch/logging");
await mkdir(SCRATCH_ROOT, { recursive: true });

const CONFIG = {
  level: "debug" as const,
  file: "logs/open-brain.log",
  service: "open-brain-server",
  workerName: "worker-2",
};

function captureLogger(): {
  logger: ReturnType<typeof createLogger>;
  entries(): Record<string, unknown>[];
} {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  return {
    logger: createLogger(CONFIG, stream as DestinationStream),
    entries: () => lines.flatMap((line) =>
      line.split("\n").filter(Boolean).map((item) => JSON.parse(item)),
    ),
  };
}

describe("structured logging boundary", () => {
  it("emits the required envelope and carries correlation across await", async () => {
    const capture = captureLogger();
    await withCorrelation(async () => {
      await Promise.resolve();
      capture.logger.info("foundation_ready");
    }, "correlation-test");
    expect(capture.entries()[0]).toMatchObject({
      level: "info",
      message: "foundation_ready",
      service: "open-brain-server",
      worker: "worker-2",
      correlation_id: "correlation-test",
    });
    expect(typeof capture.entries()[0]?.timestamp).toBe("string");
  });

  it("redacts declared secret fields and safely projects nested values", () => {
    const capture = captureLogger();
    const sensitiveValue = randomUUID();
    capture.logger.info({ authorization: sensitiveValue, nested: { apiKey: sensitiveValue, ok: "yes" } }, "safe_event");
    expect(capture.entries()[0]?.authorization).toBe("[REDACTED]");
    expect(capture.entries()[0]?.nested).toEqual({ apiKey: "[REDACTED]", ok: "yes" });
    expect((sanitizeValue("x".repeat(250)) as string).length).toBeLessThan(250);
    expect(sanitizeValue(new URL("https://example.invalid/path"))).toEqual({ type: "URL", key_count: 0 });
  });

  it("emits entry, result, duration, and failure through the operation wrapper", async () => {
    const capture = captureLogger();
    await withOperation({ logger: capture.logger, name: "ok", work: async () => 7 });
    const sensitiveMessage = randomUUID();
    await expect(withOperation({ logger: capture.logger, name: "bad", work: async () => { throw new TypeError(sensitiveMessage); } })).rejects.toThrow(sensitiveMessage);
    expect(capture.entries().map((entry) => entry.message)).toEqual([
      "operation_entry",
      "operation_result",
      "operation_entry",
      "operation_failure",
    ]);
    expect(capture.entries()[1]?.duration_ms).toBeNumber();
    expect(capture.entries()[3]?.error).toEqual({ type: "TypeError" });
    expect(JSON.stringify(capture.entries())).not.toContain(sensitiveMessage);
  });

  it("derives a separate file path for every worker", () => {
    expect(workerLogPath("logs/open-brain.log", "worker/2")).toBe("logs/open-brain.worker_2.log");
  });

  // Regression for #612. Every other test in this file injects an in-memory
  // stream, which is the SINGLE-destination pino path — and that is precisely
  // why they all passed while the running server logged nothing at all. This
  // one takes the production default (`createLogger(config)` with no injected
  // destination) and reads the file back off disk, because the defect lived
  // entirely in the composition the tests were substituting away.
  //
  // Asserts a CHILD-logger line specifically: `component` arrives as a child
  // binding, which is the shape #612 was reported against.
  it("delivers module and child lines to the real rotating file destination", async () => {
    const dir = await mkdtemp(join(SCRATCH_ROOT, "logging-612-"));
    const configured = join(dir, "open-brain.log");
    const logger = createLogger({ ...CONFIG, file: configured });

    logger.info({ probe: "module" }, "routing_probe_module");
    logger.child({ component: "maintenance" }).info({ probe: "child" }, "routing_probe_child");

    // pino-roll appends an index to the configured name and writes through a
    // worker thread, so poll for the content rather than assuming it is
    // flushed synchronously.
    const expectedFile = workerLogPath(configured, CONFIG.workerName)
      .replace(/\.log$/, ".1.log");
    let contents = "";
    for (let attempt = 0; attempt < 100 && !contents.includes("routing_probe_child"); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      contents = await readFile(expectedFile, "utf8").catch(() => "");
    }

    const lines = contents.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const moduleLine = lines.find((line) => line.message === "routing_probe_module");
    const childLine = lines.find((line) => line.message === "routing_probe_child");

    // The module line proves the destination receives anything at all; without
    // it a missing child line is ambiguous between "child bindings are lost"
    // and "nothing is written", and the real defect was the latter.
    expect(moduleLine).toBeDefined();
    expect(childLine).toBeDefined();
    expect(childLine?.component).toBe("maintenance");
    // The envelope must survive the routing fix unchanged — a string level is
    // what the shared envelope requires, and is also what broke multi-target
    // routing in the first place.
    expect(childLine?.level).toBe("info");
    expect(childLine?.service).toBe(CONFIG.service);
    expect(typeof childLine?.timestamp).toBe("string");
  });
});
