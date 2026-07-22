import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FirstClassMemoryRuntime,
  PARKED_NAMESPACE_KEY,
  ReceiptStatus,
} from "../src/runtime.ts";
import { JsonlSpool } from "../src/spool.ts";
import { OpenBrainToolError, type Json } from "../src/client.ts";
import {
  LaneAwareTransport,
  StartThenFailClient,
  runtimeConfig,
  runtimeScope,
  toolCalls,
} from "./fakes.ts";

const SENTINEL = "secret-value";

function tempSpool(
  options: ConstructorParameters<typeof JsonlSpool>[1] = {},
): JsonlSpool {
  const dir = mkdtempSync(join(tmpdir(), "obmem-ts-runtime-"));
  return new JsonlSpool(join(dir, "spool.jsonl"), options);
}

describe("runtime write degradation", () => {
  it("spools a failed write after a started lane and stamps provenance", async () => {
    const spool = tempSpool();
    const client = new StartThenFailClient();
    const runtime = new FirstClassMemoryRuntime(
      runtimeConfig(),
      runtimeScope(),
      {
        client,
        spool,
      },
    );
    const output = await runtime.captureDistilled("A distilled fact");
    expect(output.receipt.status).toBe(ReceiptStatus.SPOOLED);
    expect(output.receipt.durable).toBe(true);
    expect(output.receipt.spoolKey).not.toBeNull();
    // The client error carried a token=... payload; the receipt must not.
    expect(output.receipt.error ?? "").not.toContain(SENTINEL);
    expect(output.receipt.error).toBe("local_error=Error");
    const records = spool.records();
    expect(records.map((record) => record.operation)).toEqual([
      "append_session_event",
    ]);
    expect(records[0]?.payload[PARKED_NAMESPACE_KEY]).toBe("bilby");
    expect(readFileSync(spool.path, "utf-8")).not.toContain(SENTINEL);
  });

  it("keeps remote response bodies out of runtime receipts", async () => {
    const sentinel = "remote-body-sentinel";
    class RemoteFailureClient extends StartThenFailClient {
      override append_session_event(): Json {
        throw new OpenBrainToolError("remote tool failure", {
          statusCode: 502,
          context: "call_tool:append_session_event",
          body: sentinel,
        });
      }
    }
    const runtime = new FirstClassMemoryRuntime(
      runtimeConfig(),
      runtimeScope(),
      { client: new RemoteFailureClient(), spool: tempSpool() },
    );
    const output = await runtime.captureDistilled("A distilled fact");
    expect(output.receipt.status).toBe(ReceiptStatus.SPOOLED);
    expect(output.receipt.error).toBe(
      "remote_error=OpenBrainToolError status=502 context=call_tool:append_session_event",
    );
    expect(JSON.stringify(output.receipt.asDict())).not.toContain(sentinel);
  });

  it("pairs the lane prerequisite with the write when session start fails", async () => {
    const spool = tempSpool();
    const client = new StartThenFailClient({ failStart: true });
    const runtime = new FirstClassMemoryRuntime(
      runtimeConfig(),
      runtimeScope(),
      {
        client,
        spool,
      },
    );
    const output = await runtime.wrap("Wrap summary for a downed brain");
    expect(output.receipt.status).toBe(ReceiptStatus.SPOOLED);
    expect(output.receipt.durable).toBe(true);
    const records = spool.records();
    expect(records.map((record) => record.operation)).toEqual([
      "session_start",
      "session_wrap",
    ]);
    // Both records carry the parked-namespace provenance marker.
    for (const record of records) {
      expect(record.payload[PARKED_NAMESPACE_KEY]).toBe("bilby");
    }
    // The batch is one atomic unit (same group).
    expect(records[0]?.group_id).toBeDefined();
    expect(records[0]?.group_id).toBe(records[1]?.group_id as string);
    expect(readFileSync(spool.path, "utf-8")).not.toContain(SENTINEL);
  });

  it("reports LOST when no spool is configured", async () => {
    const runtime = new FirstClassMemoryRuntime(
      runtimeConfig(),
      runtimeScope(),
      {
        client: new StartThenFailClient(),
      },
    );
    const output = await runtime.captureDistilled("A distilled fact");
    expect(output.receipt.status).toBe(ReceiptStatus.LOST);
    expect(output.receipt.durable).toBe(false);
    expect(output.receipt.error ?? "").not.toContain(SENTINEL);
  });

  it("fails closed on invalid or secret-bearing content", async () => {
    const runtime = new FirstClassMemoryRuntime(
      runtimeConfig(),
      runtimeScope(),
      {
        client: new StartThenFailClient(),
        spool: tempSpool(),
      },
    );
    const empty = await runtime.captureDistilled("   ");
    expect(empty.receipt.status).toBe(ReceiptStatus.FAILED);
    const badType = await runtime.captureDistilled("fine", {
      eventType: "not-a-type",
    });
    expect(badType.receipt.status).toBe(ReceiptStatus.FAILED);
    const secret = await runtime.captureDistilled(
      ["api", "key"].join("_") + "=" + ["abcd", "1234", "efgh"].join(""),
    );
    expect(secret.receipt.status).toBe(ReceiptStatus.FAILED);
    expect(secret.receipt.durable).toBe(false);
  });

  it("rejects oversized distilled content before any transport call", async () => {
    const transport = new LaneAwareTransport();
    const runtime = new FirstClassMemoryRuntime(
      runtimeConfig(),
      runtimeScope(),
      {
        transport,
      },
    );
    const output = await runtime.captureDistilled("x".repeat(17 * 1024));
    expect(output.receipt.status).toBe(ReceiptStatus.FAILED);
    expect(toolCalls(transport).length).toBe(0);
  });
});

describe("runtime scope-aware auto-drain", () => {
  it("retains foreign-namespace parked units without dispatch or failure", async () => {
    const spool = tempSpool();
    spool.append(
      "log_thought",
      { content: "someone else's memory", [PARKED_NAMESPACE_KEY]: "other-ns" },
      "foreign-key",
    );
    spool.append(
      "log_thought",
      { content: "our memory", [PARKED_NAMESPACE_KEY]: "bilby" },
      "local-key",
    );
    const transport = new LaneAwareTransport();
    const runtime = new FirstClassMemoryRuntime(
      runtimeConfig(),
      runtimeScope(),
      {
        transport,
        spool,
      },
    );
    const output = await runtime.recallContext("drain now");
    expect(output.receipt.status).toBe(ReceiptStatus.DIRECT);
    expect(output.drain?.retainedUnits).toBe(1);
    expect(output.drain?.replayedUnits).toBe(1);
    expect(output.drain?.failedUnits).toBe(0);
    expect(output.drain?.quarantinedUnits).toBe(0);
    // The foreign unit was never dispatched to the server.
    const dispatched = toolCalls(transport).map(
      (call) => (call["params"] as Record<string, unknown>)["name"],
    );
    expect(dispatched.filter((name) => name === "log_thought").length).toBe(1);
    // ...and stays pending with no retry accrual.
    expect(spool.status().pending_count).toBe(1);
    expect(spool.status().retry_counts).toEqual({});
    expect(spool.records()[0]?.idempotency_key).toBe("foreign-key");
  });

  it("strips the provenance marker before dispatching a local unit", async () => {
    const spool = tempSpool();
    spool.append(
      "log_thought",
      { content: "ours", [PARKED_NAMESPACE_KEY]: "bilby" },
      "local-key",
    );
    const transport = new LaneAwareTransport();
    const runtime = new FirstClassMemoryRuntime(
      runtimeConfig(),
      runtimeScope(),
      {
        transport,
        spool,
      },
    );
    await runtime.recallContext("drain now");
    const dispatchedThought = toolCalls(transport)
      .map((call) => call["params"] as Record<string, unknown>)
      .find((params) => params["name"] === "log_thought");
    expect(dispatchedThought).toBeDefined();
    const args = dispatchedThought?.["arguments"] as Record<string, unknown>;
    expect(PARKED_NAMESPACE_KEY in args).toBe(false);
  });

  it("quarantines a poison unit through repeated healthy recalls", async () => {
    const spool = tempSpool();
    // Not on the replay allowlist: dispatch fails every pass.
    spool.append("archive_entry", { entry_id: "x" }, "poison-key");
    const transport = new LaneAwareTransport();
    const runtime = new FirstClassMemoryRuntime(
      runtimeConfig(),
      runtimeScope(),
      {
        transport,
        spool,
      },
    );
    let lastDrain = null;
    for (let pass = 0; pass < 5; pass += 1) {
      const output = await runtime.recallContext(`drain pass ${pass}`);
      lastDrain = output.drain ?? null;
    }
    expect(lastDrain?.quarantinedUnits).toBe(1);
    const receipt = lastDrain?.receipts.at(-1);
    expect(receipt?.status).toBe(ReceiptStatus.QUARANTINED);
    expect(receipt?.spoolKey).toBe("poison-key");
    // Category is a class name, never free text with spaces.
    expect(receipt?.error).toBe("ValidationError");
    expect(spool.status().pending_count).toBe(0);
    expect(spool.status().quarantined_count).toBe(1);
  });

  it("does not drain on failed recalls", async () => {
    const spool = tempSpool();
    spool.append("log_thought", { content: "waiting" }, "wait-key");
    const runtime = new FirstClassMemoryRuntime(
      runtimeConfig(),
      runtimeScope(),
      {
        client: new StartThenFailClient(),
        spool,
      },
    );
    const output = await runtime.recallContext("this recall fails");
    expect(output.receipt.status).toBe(ReceiptStatus.FAILED);
    expect(output.drain ?? null).toBeNull();
    expect(spool.status().pending_count).toBe(1);
  });
});

describe("runtime lifecycle surface", () => {
  it("starts the exact lane once and reuses it across writes", async () => {
    const transport = new LaneAwareTransport();
    const runtime = new FirstClassMemoryRuntime(
      runtimeConfig(),
      runtimeScope(),
      {
        transport,
      },
    );
    const started = await runtime.sessionStart();
    expect(started.receipt.status).toBe(ReceiptStatus.DIRECT);
    const first = await runtime.captureDistilled("first fact");
    const second = await runtime.captureDistilled("second fact");
    expect(first.receipt.status).toBe(ReceiptStatus.SAVED);
    expect(second.receipt.status).toBe(ReceiptStatus.SAVED);
    const startCalls = toolCalls(transport)
      .map((call) => (call["params"] as Record<string, unknown>)["name"])
      .filter((name) => name === "session_start");
    expect(startCalls.length).toBe(1);
  });

  it("checkpoint and wrap write durable session_wrap checkpoints", async () => {
    const transport = new LaneAwareTransport();
    const runtime = new FirstClassMemoryRuntime(
      runtimeConfig(),
      runtimeScope(),
      {
        transport,
      },
    );
    const checkpointed = await runtime.checkpoint("Mid-session checkpoint", {
      keyDecisions: ["Use the spool"],
      receiptRefs: ["receipt-1"],
    });
    expect(checkpointed.receipt.status).toBe(ReceiptStatus.SAVED);
    expect(checkpointed.receipt.durable).toBe(true);
    const wrapped = await runtime.wrap("Final wrap");
    expect(wrapped.receipt.status).toBe(ReceiptStatus.SAVED);
    const wrapCalls = toolCalls(transport)
      .map((call) => call["params"] as Record<string, unknown>)
      .filter((params) => params["name"] === "session_wrap");
    expect(wrapCalls.length).toBe(2);
    const firstWrapArgs = wrapCalls[0]?.["arguments"] as Record<
      string,
      unknown
    >;
    expect(firstWrapArgs["next_steps"]).toEqual(["Receipt ref: receipt-1"]);
    expect("receipt_refs" in firstWrapArgs).toBe(false);
  });
});
