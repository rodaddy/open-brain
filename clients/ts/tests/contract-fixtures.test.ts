/**
 * Runtime-neutral memory-contract fixture consumers for the TypeScript
 * client — the structural mirror of
 * `python/openbrain-memory/tests/test_contract_fixtures.py`.
 *
 * Every fixture in `contracts/memory/` whose `consumers` include `ts` is
 * replayed here against the real client/runtime/spool implementations.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import {
  COMPATIBLE_CONTRACT_VERSIONS,
  CURRENT_CONTRACT_HEADER,
  CURRENT_CONTRACT_SCHEMA_HASH,
  CURRENT_CONTRACT_SCHEMA_VERSION,
  CURRENT_CONTRACT_VERSION,
} from "../src/contract.ts";
import { OpenBrainClient, type Json } from "../src/client.ts";
import {
  errorCategory,
  coerceErrorCategory,
  publicReceipt,
  PUBLIC_ERROR_CATEGORIES,
} from "../src/receipts.ts";
import {
  FirstClassMemoryRuntime,
  ReceiptStatus,
  RuntimeReceipt,
  type ReceiptStatusValue,
} from "../src/runtime.ts";
import { JsonlSpool, SpoolFullError } from "../src/spool.ts";
import {
  LaneAwareTransport,
  ScopeProofClient,
  TEST_TOKEN,
  runtimeConfig,
  runtimeScope,
  toolCalls,
} from "./fakes.ts";

const FIXTURE_DIR = join(import.meta.dir, "../../../contracts/memory");

const fixtureSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    capability: z.string().min(1),
    runtime: z.enum(["both", "python", "ts"]),
    consumers: z.array(z.enum(["python", "ts"])),
    request: z.record(z.string(), z.unknown()),
    expectation: z.record(z.string(), z.unknown()),
  })
  .loose();
type Fixture = z.infer<typeof fixtureSchema>;

function loadFixtures(): Fixture[] {
  const fixtures: Fixture[] = [];
  for (const name of readdirSync(FIXTURE_DIR).sort()) {
    if (!name.endsWith(".fixture.json")) {
      continue;
    }
    const raw: unknown = JSON.parse(
      readFileSync(join(FIXTURE_DIR, name), "utf-8"),
    );
    fixtures.push(fixtureSchema.parse(raw));
  }
  return fixtures;
}

const ALL_FIXTURES = loadFixtures();
const TS_FIXTURES = ALL_FIXTURES.filter((fixture) =>
  fixture.consumers.includes("ts"),
);

/**
 * Derive the TS fixture set from the parity manifest plus the fixture runtime,
 * rather than maintaining a second list that can silently omit a new shared
 * fixture from the TS replay suite.
 */
const PARITY_MANIFEST = JSON.parse(
  readFileSync(join(FIXTURE_DIR, "parity-manifest.json"), "utf-8"),
) as {
  expected_fixture_ids: Record<string, string>;
  capabilities: Array<{ capability: string; ts: string }>;
};
const TS_IMPLEMENTED_CAPABILITIES = new Set(
  PARITY_MANIFEST.capabilities
    .filter((entry) => entry.ts === "implemented")
    .map((entry) => entry.capability),
);
const FIXTURE_BY_ID = new Map(
  ALL_FIXTURES.map((fixture) => [fixture.id, fixture] as const),
);
const EXPECTED_TS_FIXTURE_IDS = new Set(
  Object.entries(PARITY_MANIFEST.expected_fixture_ids).flatMap(
    ([id, runtime]) => {
      if (runtime === "ts") return [id];
      const fixture = FIXTURE_BY_ID.get(id);
      return runtime === "both" &&
        fixture !== undefined &&
        TS_IMPLEMENTED_CAPABILITIES.has(fixture.capability)
        ? [id]
        : [];
    },
  ),
);

describe("contract fixture discovery", () => {
  it("matches the manifest's ts-consumable fixture set", () => {
    expect(ALL_FIXTURES.length).toBe(FIXTURE_BY_ID.size);
    expect(new Set(FIXTURE_BY_ID.keys())).toEqual(
      new Set(Object.keys(PARITY_MANIFEST.expected_fixture_ids)),
    );
    expect(EXPECTED_TS_FIXTURE_IDS.size).toBeGreaterThan(0);
    expect(new Set(TS_FIXTURES.map((fixture) => fixture.id))).toEqual(
      EXPECTED_TS_FIXTURE_IDS,
    );
    for (const id of EXPECTED_TS_FIXTURE_IDS) {
      expect(PARITY_MANIFEST.expected_fixture_ids[id]).toBeDefined();
    }
  });
});

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural mirror of the Python `_assert_contract_value`. */
function assertContractValue(actual: unknown, expected: unknown): void {
  if (expected === "<non-empty-string>") {
    expect(typeof actual).toBe("string");
    expect((actual as string).length).toBeGreaterThan(0);
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual)).toBe(true);
    expect((actual as unknown[]).length).toBe(expected.length);
    expected.forEach((expectedItem, index) => {
      assertContractValue((actual as unknown[])[index], expectedItem);
    });
    return;
  }
  if (isRecord(expected)) {
    expect(isRecord(actual)).toBe(true);
    expect(Object.keys(actual as Json).sort()).toEqual(
      Object.keys(expected).sort(),
    );
    for (const [key, value] of Object.entries(expected)) {
      assertContractValue((actual as Json)[key], value);
    }
    return;
  }
  expect(actual).toEqual(expected);
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "obmem-ts-fixture-"));
}

async function consumeContractDeclaration(fixture: Fixture): Promise<void> {
  const request = fixture.request;
  const expectation = fixture.expectation;
  expect(CURRENT_CONTRACT_VERSION).toBe(request["contract_id"] as string);
  expect(CURRENT_CONTRACT_SCHEMA_VERSION).toBe(
    request["schema_version"] as number,
  );
  expect(CURRENT_CONTRACT_SCHEMA_HASH).toBe(request["schema_hash"] as string);
  expect([...COMPATIBLE_CONTRACT_VERSIONS]).toEqual(
    expectation["compatible_contract_ids"] as string[],
  );
  expect(CURRENT_CONTRACT_HEADER).toBe(expectation["client_header"] as string);
}

async function consumeSessionLifecycle(fixture: Fixture): Promise<void> {
  const request = fixture.request;
  const expectation = fixture.expectation;
  const transport = new LaneAwareTransport();
  const entrypoint = request["entrypoint"] as string;
  const args = request["arguments"] as Json;
  let status: string;
  let durable: boolean | null = null;

  if (entrypoint === "client.session_start") {
    const client = new OpenBrainClient("https://brain.example", {
      token: TEST_TOKEN,
      namespace: "bilby",
      agentId: "bilby",
      transport,
    });
    const result = await client.session_start(args);
    status = result["lane"] ? "direct" : "failed";
  } else {
    const runtime = new FirstClassMemoryRuntime(
      runtimeConfig(),
      runtimeScope(),
      {
        transport,
      },
    );
    let output;
    switch (entrypoint) {
      case "runtime.capture_distilled":
        output = await runtime.captureDistilled(args["content"] as string, {
          eventType: args["event_type"] as string,
        });
        break;
      case "runtime.checkpoint":
        output = await runtime.checkpoint(args["summary"] as string, {
          keyDecisions: args["key_decisions"] as string[] | undefined,
          nextSteps: args["next_steps"] as string[] | undefined,
          receiptRefs: args["receipt_refs"] as string[] | undefined,
        });
        break;
      case "runtime.wrap":
        output = await runtime.wrap(args["summary"] as string, {
          keyDecisions: args["key_decisions"] as string[] | undefined,
          nextSteps: args["next_steps"] as string[] | undefined,
          receiptRefs: args["receipt_refs"] as string[] | undefined,
        });
        break;
      case "runtime.recall_context": {
        const options: {
          maxTokens?: number;
          maxLatencyMs?: number;
          requestedSections?: string[];
        } = {};
        if (args["max_tokens"] !== undefined) {
          options.maxTokens = args["max_tokens"] as number;
        }
        if (args["max_latency_ms"] !== undefined) {
          options.maxLatencyMs = args["max_latency_ms"] as number;
        }
        if (args["requested_sections"] !== undefined) {
          options.requestedSections = args["requested_sections"] as string[];
        }
        output = await runtime.recallContext(args["query"] as string, options);
        break;
      }
      default:
        throw new Error(`unexpected entrypoint: ${entrypoint}`);
    }
    status = output.receipt.status as string;
    durable = output.receipt.durable;
  }

  const calls = toolCalls(transport)
    .map((call) => call["params"] as Json)
    .filter((params) => params["name"] !== "get_contract");
  const expectedCalls = fixture.expectation["tool_calls"] as unknown[];
  expect(calls.length).toBe(expectedCalls.length);
  calls.forEach((actual, index) => {
    assertContractValue(actual, expectedCalls[index]);
  });
  expect(status).toBe(expectation["status"] as string);
  if ("durable" in expectation) {
    expect(durable).toBe(expectation["durable"] as boolean);
  }
  for (const httpRequest of transport.requests) {
    expect(httpRequest.headers["X-OB-Contract"]).toBe(CURRENT_CONTRACT_HEADER);
  }
}

async function consumeExactScopeProof(fixture: Fixture): Promise<void> {
  const request = fixture.request;
  const expectation = fixture.expectation;
  const exact = { ...(request["scope"] as Json) };
  const accepted = await new FirstClassMemoryRuntime(
    runtimeConfig(),
    runtimeScope(),
    { client: new ScopeProofClient(exact) },
  ).recallContext("Exact scope fixture");
  expect(accepted.receipt.status as string).toBe(
    expectation["exact_status"] as string,
  );

  for (const field of request["mismatch_fields"] as string[]) {
    const mismatched = { ...exact, [field]: "other" };
    const output = await new FirstClassMemoryRuntime(
      runtimeConfig(),
      runtimeScope(),
      { client: new ScopeProofClient(mismatched) },
    ).recallContext(`Mismatch fixture: ${field}`);
    expect(output.receipt.status as string).toBe(
      expectation["mismatch_status_without_fallback"] as string,
    );
    expect(output.context).toEqual(
      expectation["mismatch_context_without_fallback"] as Json,
    );
  }
}

async function consumeSpoolBackpressure(fixture: Fixture): Promise<void> {
  const request = fixture.request;
  const expectation = fixture.expectation;
  const spool = new JsonlSpool(join(tempDir(), "backpressure.jsonl"), {
    maxLines: request["max_lines"] as number,
  });
  const records = request["records"] as Array<{
    operation: string;
    payload: Json;
    key: string;
  }>;
  for (const record of records.slice(0, 2)) {
    spool.append(record.operation, record.payload, record.key);
  }
  const original = readFileSync(spool.path);
  expect(expectation["rejected_error"]).toBe("SpoolFullError");
  const third = records[2] as { operation: string; payload: Json; key: string };
  expect(() => spool.append(third.operation, third.payload, third.key)).toThrow(
    SpoolFullError,
  );
  expect(readFileSync(spool.path).equals(original)).toBe(true);
  expect(spool.records().map((record) => record.operation)).toEqual(
    expectation["retained_operations"] as string[],
  );
  const replayed = await spool.replay(async (record) => ({
    operation: record.operation,
  }));
  expect(replayed.map((result) => result["operation"])).toEqual(
    expectation["replay_operations"] as string[],
  );
}

async function consumeRedactBeforePersist(fixture: Fixture): Promise<void> {
  const request = fixture.request;
  const expectation = fixture.expectation;
  const spool = new JsonlSpool(join(tempDir(), "redacted.jsonl"));
  spool.append(
    request["operation"] as string,
    request["payload"] as Json,
    request["key"] as string,
  );
  const persisted = readFileSync(spool.path, "utf-8");
  const record = spool.records()[0];
  expect(record).toBeDefined();
  expect(record?.payload).toEqual(expectation["persisted_payload"] as Json);
  for (const forbidden of expectation["forbidden_substrings"] as string[]) {
    expect(persisted).not.toContain(forbidden);
    expect(JSON.stringify(record?.payload)).not.toContain(forbidden);
  }
  const mode = statSync(spool.path).mode & 0o7777;
  expect(mode.toString(8).padStart(4, "0")).toBe(
    expectation["file_mode"] as string,
  );
}

async function consumeAutoDrainAllowlist(fixture: Fixture): Promise<void> {
  const request = fixture.request;
  const expectation = fixture.expectation;
  const spool = new JsonlSpool(join(tempDir(), "drain.jsonl"));
  const operations = request["operations"] as Array<{
    operation: string;
    payload: Json;
  }>;
  operations.forEach((record, index) => {
    spool.append(record.operation, record.payload, `fixture-allowed-${index}`);
  });
  const transport = new LaneAwareTransport();
  const runtime = new FirstClassMemoryRuntime(runtimeConfig(), runtimeScope(), {
    transport,
    spool,
  });
  const output = await runtime.recallContext("Drain fixture");
  const dispatched = toolCalls(transport)
    .map((call) => (call["params"] as Json)["name"] as string)
    .filter((name) => name !== "get_contract" && name !== "agent_context_pack");
  expect(output.receipt.status as string).toBe(
    expectation["trigger_status"] as string,
  );
  expect(dispatched).toEqual(expectation["dispatched_operations"] as string[]);
  expect(spool.status().pending_count).toBe(
    expectation["pending_count"] as number,
  );
}

async function consumeReceiptShapes(fixture: Fixture): Promise<void> {
  // TS-owned taxonomy fixture (`ts-public-receipt-error-category-v1`).
  const request = fixture.request;
  const expectation = fixture.expectation;
  expect(expectation["field"]).toBe("error_category");
  expect(expectation["taxonomy"]).toEqual([...PUBLIC_ERROR_CATEGORIES]);
  // Unknown failures map into the bounded taxonomy, never free text.
  expect(errorCategory(new Error("unmapped mystery failure")) as string).toBe(
    expectation["unknown_maps_to"] as string,
  );
  expect(coerceErrorCategory("free text is not a category") as string).toBe(
    expectation["unknown_maps_to"] as string,
  );
  expect(expectation["free_text_allowed"]).toBe(false);
  const taxonomy = new Set(expectation["taxonomy"] as string[]);
  for (const status of request["package_receipt_statuses"] as string[]) {
    const receipt = publicReceipt(
      new RuntimeReceipt({
        operation: "capture",
        status: status as ReceiptStatusValue,
        durable: status === "spooled",
        directAttempted: true,
        fallbackAttempted: false,
        spoolKey: status === "spooled" ? "fixture-key" : null,
        error: "sanitized text stays internal",
      }),
      new Error("unmapped mystery failure"),
    );
    const category = receipt["error_category"];
    expect(typeof category).toBe("string");
    expect(taxonomy.has(category as string)).toBe(true);
  }
}

async function consumeDrainReceipts(fixture: Fixture): Promise<void> {
  const request = fixture.request;
  const expectation = fixture.expectation;
  const statuses: string[] = [];
  for (const name of ["replayed_receipt", "quarantined_receipt"] as const) {
    const declared = request[name] as Json;
    const receipt = new RuntimeReceipt({
      operation: declared["operation"] as string,
      status: declared["status"] as ReceiptStatusValue,
      durable: declared["durable"] as boolean,
      directAttempted: declared["direct_attempted"] as boolean,
      fallbackAttempted: declared["fallback_attempted"] as boolean,
      spoolKey: declared["spool_key"] as string,
      error: (declared["error"] as string | undefined) ?? null,
    }).asDict();
    expect(receipt["schema"]).toBe(expectation["runtime_schema"] as string);
    for (const [key, value] of Object.entries(declared)) {
      expect(receipt[key]).toEqual(value);
    }
    statuses.push(receipt["status"] as string);
  }
  expect(statuses).toEqual(expectation["statuses"] as string[]);
  expect(ReceiptStatus.REPLAYED as string).toBe("replayed");
  expect(ReceiptStatus.QUARANTINED as string).toBe("quarantined");
  // Drain receipts carry error CATEGORY/class names only, never bodies.
  const quarantinedError = (request["quarantined_receipt"] as Json)[
    "error"
  ] as string;
  expect(expectation["error_is_category_only"]).toBe(true);
  expect(quarantinedError).not.toContain(" ");
}

const HANDLERS: Record<string, (fixture: Fixture) => Promise<void>> = {
  "contract-declaration": consumeContractDeclaration,
  "session-lifecycle": consumeSessionLifecycle,
  "exact-scope-proof": consumeExactScopeProof,
  "spool-backpressure": consumeSpoolBackpressure,
  "redact-before-persist": consumeRedactBeforePersist,
  "auto-drain-allowlist": consumeAutoDrainAllowlist,
  "receipt-shapes": consumeReceiptShapes,
  "drain-receipts": consumeDrainReceipts,
};

describe("TypeScript client consumes memory contract fixtures", () => {
  for (const fixture of TS_FIXTURES) {
    it(fixture.id, async () => {
      expect(fixture.consumers).toContain("ts");
      const handler = HANDLERS[fixture.capability];
      if (handler === undefined) {
        throw new Error(`no handler for capability: ${fixture.capability}`);
      }
      await handler(fixture);
    });
  }
});
