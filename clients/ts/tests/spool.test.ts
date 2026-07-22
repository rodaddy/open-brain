import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ValidationError } from "../src/policy.ts";
import {
  JsonlSpool,
  SpoolFullError,
  SpoolUnitRetained,
  type SpoolRecord,
} from "../src/spool.ts";

// Assembled at runtime so no credential-shaped literal lands in source.
const SENTINEL = ["leakmark", "unit", "sentinel", "987654"].join("-");
const SECRET_LINE = ["password", `${SENTINEL}`].join(": ");

function tempSpool(options: ConstructorParameters<typeof JsonlSpool>[1] = {}) {
  const dir = mkdtempSync(join(tmpdir(), "obmem-ts-spool-"));
  return new JsonlSpool(join(dir, "spool.jsonl"), options);
}

async function failPasses(
  spool: JsonlSpool,
  passes: number,
  error: () => Error,
): Promise<void> {
  for (let index = 0; index < passes; index += 1) {
    await spool.replayWithReport(() => {
      throw error();
    });
  }
}

describe("JsonlSpool caps and backpressure", () => {
  it("accepts appends up to the exact line cap and rejects the next", () => {
    const spool = tempSpool({ maxLines: 3 });
    spool.append("one", { content: "1" });
    spool.append("two", { content: "2" });
    spool.append("three", { content: "3" });
    expect(spool.status().pending_count).toBe(3);
    const before = readFileSync(spool.path);
    expect(() => spool.append("four", { content: "4" })).toThrow(
      SpoolFullError,
    );
    expect(readFileSync(spool.path).equals(before)).toBe(true);
    expect(spool.status().pending_count).toBe(3);
  });

  it("enforces the byte cap without changing acknowledged records", () => {
    const spool = tempSpool({ maxBytes: 400 });
    spool.append("one", { content: "x".repeat(100) });
    const before = readFileSync(spool.path);
    // The second record fits an empty spool but not the remaining budget.
    expect(() => spool.append("two", { content: "y".repeat(150) })).toThrow(
      SpoolFullError,
    );
    expect(readFileSync(spool.path).equals(before)).toBe(true);
    expect(spool.records().map((record) => record.operation)).toEqual(["one"]);
  });

  it("rejects a batch that can never fit with a plain validation error", () => {
    const spool = tempSpool({ maxLines: 1 });
    let thrown: unknown = null;
    try {
      spool.appendBatch([
        { operation: "one", payload: { content: "1" } },
        { operation: "two", payload: { content: "2" } },
      ]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ValidationError);
    expect(thrown).not.toBeInstanceOf(SpoolFullError);
    expect(existsSync(spool.path)).toBe(false);
  });

  it("preserves replay order after a rejected append", async () => {
    const spool = tempSpool({ maxLines: 2 });
    spool.append("first", { content: "1" }, "key-1");
    spool.append("second", { content: "2" }, "key-2");
    expect(() => spool.append("third", { content: "3" }, "key-3")).toThrow(
      SpoolFullError,
    );
    const seen: string[] = [];
    await spool.replay((record) => {
      seen.push(record.operation);
      return {};
    });
    expect(seen).toEqual(["first", "second"]);
    expect(spool.status().pending_count).toBe(0);
  });
});

describe("JsonlSpool redact-before-persist", () => {
  it("never writes a labeled secret value to disk", () => {
    const spool = tempSpool();
    spool.append("log_thought", { content: SECRET_LINE });
    const persisted = readFileSync(spool.path, "utf-8");
    expect(persisted).not.toContain(SENTINEL);
    expect(persisted).toContain("[REDACTED]");
    const record = spool.records()[0] as SpoolRecord;
    expect(JSON.stringify(record.payload)).not.toContain(SENTINEL);
  });

  it("redacts sensitive keys anywhere in the payload tree", () => {
    const spool = tempSpool();
    spool.append("log_thought", {
      content: "safe",
      metadata: { api_key: SENTINEL, nested: { credential: SENTINEL } },
    });
    const persisted = readFileSync(spool.path, "utf-8");
    expect(persisted).not.toContain(SENTINEL);
  });

  it("keeps the sentinel out of the quarantine sidecar", async () => {
    const spool = tempSpool({ quarantineThreshold: 1 });
    spool.append("log_thought", { content: SECRET_LINE }, "leak-key");
    await spool.replayWithReport(() => {
      throw new Error(`dispatch saw ${SECRET_LINE}`);
    });
    const sidecar = readFileSync(spool.quarantinePath, "utf-8");
    expect(sidecar).not.toContain(SENTINEL);
    // Envelope carries the error CLASS only, never the message body.
    expect(sidecar).toContain('"error_category":"Error"');
    expect(sidecar).not.toContain("dispatch saw");
  });
});

describe("JsonlSpool quarantine lifecycle", () => {
  it("quarantines exactly at the consecutive-failure threshold", async () => {
    const spool = tempSpool();
    spool.append("log_thought", { content: "poison" }, "poison-key");
    await failPasses(spool, 4, () => new TypeError("boom"));
    expect(spool.status().pending_count).toBe(1);
    expect(spool.status().quarantined_count).toBe(0);
    expect(spool.status().retry_counts["poison-key"]).toBe(4);

    const report = await spool.replayWithReport(() => {
      throw new TypeError("boom");
    });
    expect(report.outcomes[0]?.status).toBe("quarantined");
    expect(report.outcomes[0]?.consecutive_failures).toBe(5);
    expect(report.outcomes[0]?.error_category).toBe("TypeError");
    expect(spool.status().pending_count).toBe(0);
    expect(spool.status().quarantined_count).toBe(1);
  });

  it("supports operator restore-then-replay with sidecar reconciliation", async () => {
    const spool = tempSpool({ quarantineThreshold: 2 });
    spool.append("log_thought", { content: "flaky" }, "flaky-key");
    await failPasses(spool, 2, () => new Error("down"));
    expect(spool.status().quarantined_count).toBe(1);
    expect(spool.status().pending_count).toBe(0);

    // Operator restore: copy the quarantined record lines back into the
    // spool (envelope line stays behind as a stale entry).
    const sidecarLines = readFileSync(spool.quarantinePath, "utf-8")
      .split("\n")
      .filter(Boolean);
    const recordLines = sidecarLines.filter(
      (line) => !line.includes('"schema":"openbrain.spool_quarantine.v1"'),
    );
    appendFileSync(spool.path, recordLines.map((line) => line + "\n").join(""));
    expect(spool.status().pending_count).toBe(1);

    const report = await spool.replayWithReport(() => ({ ok: true }));
    expect(report.outcomes[0]?.status).toBe("replayed");
    expect(spool.status().pending_count).toBe(0);
    // Success reconciliation removes the stale sidecar entry.
    expect(spool.status().quarantined_count).toBe(0);
  });

  it("replaces (never skips) a re-quarantined unit's sidecar entry", async () => {
    const spool = tempSpool({ quarantineThreshold: 1 });
    spool.append("log_thought", { content: "always-bad" }, "bad-key");
    await failPasses(spool, 1, () => new Error("first"));
    expect(spool.status().quarantined_count).toBe(1);

    // Restore and let it fail to threshold again (crash-window shape: the
    // unit exists in both the sidecar and the main spool).
    const sidecarLines = readFileSync(spool.quarantinePath, "utf-8")
      .split("\n")
      .filter(Boolean);
    const recordLines = sidecarLines.filter(
      (line) => !line.includes('"schema":"openbrain.spool_quarantine.v1"'),
    );
    appendFileSync(spool.path, recordLines.map((line) => line + "\n").join(""));
    await failPasses(spool, 1, () => new RangeError("second"));

    const sidecar = readFileSync(spool.quarantinePath, "utf-8");
    const envelopes = sidecar
      .split("\n")
      .filter((line) =>
        line.includes('"schema":"openbrain.spool_quarantine.v1"'),
      );
    expect(envelopes.length).toBe(1);
    // Freshest category wins on replacement.
    expect(envelopes[0]).toContain('"error_category":"RangeError"');
    expect(spool.status().quarantined_count).toBe(1);
    expect(spool.status().pending_count).toBe(0);
  });

  it("never counts retained units toward quarantine", async () => {
    const spool = tempSpool({ quarantineThreshold: 1 });
    spool.append("log_thought", { content: "foreign" }, "foreign-key");
    for (let pass = 0; pass < 3; pass += 1) {
      const report = await spool.replayWithReport(() => {
        throw new SpoolUnitRetained("parked elsewhere");
      });
      expect(report.outcomes[0]?.status).toBe("retained");
    }
    expect(spool.status().pending_count).toBe(1);
    expect(spool.status().quarantined_count).toBe(0);
    expect(Object.keys(spool.status().retry_counts)).toEqual([]);
  });

  it("fails a whole batch unit when any record dispatch fails", async () => {
    const spool = tempSpool();
    spool.appendBatch([
      { operation: "session_start", payload: { session_key: "s" }, key: "k-1" },
      {
        operation: "append_session_event",
        payload: { content: "c" },
        key: "k-2",
      },
    ]);
    const report = await spool.replayWithReport((record) => {
      if (record.operation === "append_session_event") {
        throw new Error("second record fails");
      }
      return {};
    });
    expect(report.outcomes.length).toBe(1);
    expect(report.outcomes[0]?.status).toBe("failed");
    expect(report.outcomes[0]?.record_keys).toEqual(["k-1", "k-2"]);
    // The whole unit stays pending for the next at-least-once delivery.
    expect(spool.status().pending_count).toBe(2);
  });
});

describe("JsonlSpool sidecar hardening", () => {
  it("degrades to empty retry state on sidecar corruption", async () => {
    const spool = tempSpool();
    spool.append("log_thought", { content: "x" }, "key-x");
    await failPasses(spool, 2, () => new Error("down"));
    expect(spool.status().retry_counts["key-x"]).toBe(2);
    appendFileSync(spool.retryStatePath, "not json at all\n");
    // Corrupted sidecar loses counters, never records.
    expect(spool.status().pending_count).toBe(1);
    expect(spool.status().retry_counts).toEqual({});
    expect(spool.status().last_success_at).toBeNull();
  });

  it("records last_success_at only after a pass that replayed", async () => {
    const spool = tempSpool();
    spool.append("log_thought", { content: "x" });
    expect(spool.status().last_success_at).toBeNull();
    await spool.replayWithReport(() => ({}));
    const after = spool.status().last_success_at;
    expect(after).not.toBeNull();
  });
});
