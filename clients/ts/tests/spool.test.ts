import { describe, expect, it } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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

describe("JsonlSpool durability and cross-process exclusion", () => {
  it("restores original bytes when directory durability proof fails", () => {
    const baseline = tempSpool();
    baseline.append("before", { content: "preserve" }, "before-key");
    const original = readFileSync(baseline.path);
    let calls = 0;
    const spool = new JsonlSpool(baseline.path, {
      directorySync() {
        calls += 1;
        if (calls === 1) throw new Error("injected directory fsync failure");
      },
    });
    expect(() =>
      spool.append("after", { content: "must not acknowledge" }),
    ).toThrow("injected directory fsync failure");
    expect(calls).toBe(2);
    expect(readFileSync(baseline.path).equals(original)).toBe(true);
    expect(baseline.records().map((record) => record.idempotency_key)).toEqual([
      "before-key",
    ]);
  });

  it("restores original absence when first-write directory durability proof fails", () => {
    const baseline = tempSpool();
    let calls = 0;
    const spool = new JsonlSpool(baseline.path, {
      directorySync() {
        calls += 1;
        if (calls === 1) throw new Error("injected directory fsync failure");
      },
    });
    expect(() =>
      spool.append("first", { content: "must not acknowledge" }),
    ).toThrow("injected directory fsync failure");
    expect(calls).toBe(2);
    expect(existsSync(baseline.path)).toBe(false);
  });

  it("recovers a lock whose recorded owner process is dead", () => {
    const spool = tempSpool();
    writeFileSync(
      spool.lockPath,
      JSON.stringify({ token: "dead-owner", pid: 2_147_483_647 }),
      { mode: 0o600 },
    );
    expect(
      spool.append("after-crash", { content: "recover" }, "recovered-key"),
    ).toBe("recovered-key");
  });

  it("recovers stale malformed lock metadata", () => {
    const baseline = tempSpool();
    writeFileSync(baseline.lockPath, "incomplete", { mode: 0o600 });
    utimesSync(baseline.lockPath, new Date(0), new Date(0));
    const spool = new JsonlSpool(baseline.path, {
      lockTimeoutMs: 50,
      lockStaleMs: 1,
    });
    expect(
      spool.append("after-stale", { content: "recover" }, "stale-key"),
    ).toBe("stale-key");
  });

  it("recovers stale locks with invalid numeric owner pids", () => {
    for (const pid of [0, -1, 1.5]) {
      const baseline = tempSpool();
      writeFileSync(
        baseline.lockPath,
        JSON.stringify({ token: `invalid-${pid}`, pid }),
        { mode: 0o600 },
      );
      utimesSync(baseline.lockPath, new Date(0), new Date(0));
      const spool = new JsonlSpool(baseline.path, {
        lockTimeoutMs: 50,
        lockStaleMs: 1,
      });
      expect(typeof spool.append("after-invalid", { content: "recover" })).toBe(
        "string",
      );
    }
  });

  it("never steals a stale-looking lock from a live owner", () => {
    const baseline = tempSpool();
    writeFileSync(
      baseline.lockPath,
      JSON.stringify({ token: "live-owner", pid: process.pid }),
      { mode: 0o600 },
    );
    utimesSync(baseline.lockPath, new Date(0), new Date(0));
    const spool = new JsonlSpool(baseline.path, {
      lockTimeoutMs: 20,
      lockStaleMs: 1,
    });
    expect(() => spool.append("blocked", { content: "do not race" })).toThrow(
      "timed out acquiring spool lock",
    );
    expect(existsSync(baseline.path)).toBe(false);
  });

  it("preserves every acknowledged key from independently opened child spools", async () => {
    const spool = tempSpool();
    const gate = join(tmpdir(), `obmem-ts-spool-gate-${crypto.randomUUID()}`);
    const workerModule = new URL("../src/spool.ts", import.meta.url).href;
    const keys = Array.from({ length: 12 }, (_, index) => `child-key-${index}`);
    const children = keys.map((key) =>
      Bun.spawn({
        cmd: [
          process.execPath,
          "-e",
          [
            `import { existsSync } from "node:fs";`,
            `import { JsonlSpool } from ${JSON.stringify(workerModule)};`,
            `while (!existsSync(${JSON.stringify(gate)})) await Bun.sleep(1);`,
            `new JsonlSpool(${JSON.stringify(spool.path)}).append("child", { content: "${key}" }, "${key}");`,
          ].join("\n"),
        ],
        stdout: "ignore",
        stderr: "pipe",
      }),
    );
    writeFileSync(gate, "go", { mode: 0o600 });
    for (const child of children) {
      const exitCode = await child.exited;
      if (exitCode !== 0) {
        throw new Error(await new Response(child.stderr).text());
      }
    }
    expect(
      spool
        .records()
        .map((record) => record.idempotency_key)
        .sort(),
    ).toEqual([...keys].sort());
  });
});

describe("JsonlSpool replay symlink checks", () => {
  it("rejects a symlink before reading a replay snapshot", async () => {
    const spool = tempSpool();
    spool.append("log_thought", { content: "queued" });
    const moved = spool.path + ".moved";
    const target = spool.path + ".target";
    renameSync(spool.path, moved);
    writeFileSync(target, "unrelated", { mode: 0o600 });
    symlinkSync(target, spool.path);
    await expect(spool.replayWithReport(() => ({}))).rejects.toThrow(
      "Refusing to use symlink spool path",
    );
  });

  it("rejects a symlink before replay commit reconciliation", async () => {
    const spool = tempSpool();
    spool.append("log_thought", { content: "queued" });
    const moved = spool.path + ".moved";
    const target = spool.path + ".target";
    writeFileSync(target, "unrelated", { mode: 0o600 });
    await expect(
      spool.replayWithReport(() => {
        renameSync(spool.path, moved);
        symlinkSync(target, spool.path);
        return {};
      }),
    ).rejects.toThrow("Refusing to use symlink spool path");
    expect(readFileSync(target, "utf-8")).toBe("unrelated");
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
