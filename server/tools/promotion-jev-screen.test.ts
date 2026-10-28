/**
 * Issue 1618 B3: the optional Jev screen in front of `promote_shared`.
 *
 * The synchronous classifier (`classifyShareCandidate`, secret check first)
 * always runs before the screen; the screen can only HOLD what the classifier
 * would have let through, never admit what it refused. Default off: with the
 * flag off the tool behaves exactly as before and never calls Jev.
 *
 * The source read and the promotion write are faked at their module
 * boundaries; the live-Postgres half lives in `promotion.pg.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pino from "pino";
import type pg from "pg";
import type { JevConfig, JevFetch } from "../integrations/jev.ts";
import { parseServerConfig } from "../config.ts";
import { DEFAULT_SHARED_NAMESPACE_NAMES } from "./shared-namespace-fixture.ts";

const state = vi.hoisted(() => ({
  content: "",
  promoteCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("../db/promotion-repository.ts", () => ({
  createPromotionRepository: () => ({
    selectPromotionSource: async () => [{ id: "src", content: state.content }],
    countNamespaceRows: async () => [],
  }),
}));

vi.mock("../domain/promotion-service.ts", () => ({
  promoteEntry: async (
    _pool: unknown,
    _table: string,
    id: string,
    options: Record<string, unknown>,
  ) => {
    state.promoteCalls.push(options);
    const provenance = { promotion_confidence: options.promotionConfidence ?? null };
    return options.dryRun
      ? { status: "dry_run", would_insert: true, source_id: id, provenance }
      : { status: "promoted", new_id: "new", source_id: id, provenance };
  },
}));

const { registerPromotionTools } = await import("./promotion.ts");

const SHAREABLE =
  "The parity harness resolves each provider through the TOOLS_BOUNDARY seam.";
const SECRET_ISH =
  "The staging database is reachable at postgres://svc-user:hunter2horse@db.internal:5432/appdb which is why the job works.";
const ID = "00000000-0000-4000-8000-000000000001";

const JEV_ON: JevConfig = {
  enabled: true,
  apiKey: "test-key",
  baseUrl: "https://jev.test/v1",
  model: "jev-test",
  timeoutMs: 1_000,
  maxRequestBytes: 192_000,
  maxStateQuestionBytes: 96_000,
};

function jevAnswer(choice: string, confidence: number): JevFetch {
  return vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          model: "jev-test",
          answers: {
            share_screen: {
              type: "choice",
              choice,
              probabilities: { [choice]: confidence },
              confidence,
            },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200 },
      ),
  ) as unknown as JevFetch;
}

async function promote(
  jevShareScreen: { config: JevConfig; fetchFn?: JevFetch } | undefined,
  args: Record<string, unknown> = { dry_run: false },
): Promise<{ isError: boolean; body: Record<string, unknown> }> {
  const server = new McpServer({ name: "b3", version: "1.0.0" });
  registerPromotionTools(server, {
    pool: {} as pg.Pool,
    embedFn: async () => [],
    logger: pino({ level: "silent" }),
    embeddingModel: "b3",
    sharedNamespaceNames: DEFAULT_SHARED_NAMESPACE_NAMES,
    ...(jevShareScreen ? { jevShareScreen } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    originalSend(message, {
      ...options,
      authInfo: { role: "promoter", clientId: "lane-b3", namespaceSource: "token" },
    } as never);
  const client = new Client({ name: "b3", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: "promote_shared",
      arguments: { table: "thoughts", id: ID, ...args },
    });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text);
    } catch {
      body = { text };
    }
    return { isError: result.isError === true, body };
  } finally {
    await client.close();
    await server.close();
  }
}

beforeEach(() => {
  state.content = SHAREABLE;
  state.promoteCalls = [];
});

describe("promote_shared Jev share screen (issue 1618 B3)", () => {
  it("shareable at 0.95 promotes and records the confidence", async () => {
    const fetchFn = jevAnswer("shareable", 0.95);
    const { isError, body } = await promote({ config: JEV_ON, fetchFn });
    expect(isError).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(state.promoteCalls).toHaveLength(1);
    expect(state.promoteCalls[0]?.promotionConfidence).toBe(0.95);
    expect(body.status).toBe("promoted");
    expect((body.provenance as Record<string, unknown>).promotion_confidence).toBe(
      0.95,
    );
  });

  it("shareable at 0.7 is held for manual review", async () => {
    const { isError, body } = await promote({
      config: JEV_ON,
      fetchFn: jevAnswer("shareable", 0.7),
    });
    expect(isError).toBe(true);
    expect(String(body.text)).toContain("manual-review");
    expect(String(body.text)).toContain("shareable");
    expect(String(body.text)).toContain("0.7");
    expect(state.promoteCalls).toHaveLength(0);
  });

  it("credential_bearing at 0.3 is held at any confidence", async () => {
    const { isError, body } = await promote({
      config: JEV_ON,
      fetchFn: jevAnswer("credential_bearing", 0.3),
    });
    expect(isError).toBe(true);
    expect(String(body.text)).toContain("credential_bearing");
    expect(state.promoteCalls).toHaveLength(0);
  });

  it("fetch rejects: held, fail closed, and the refusal says so", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as JevFetch;
    const { isError, body } = await promote({ config: JEV_ON, fetchFn });
    expect(isError).toBe(true);
    expect(String(body.text)).toContain("manual-review");
    expect(String(body.text)).toContain("fail closed");
    expect(state.promoteCalls).toHaveLength(0);
  });

  it("a regex secret is refused as reject-secret and Jev is never called", async () => {
    state.content = SECRET_ISH;
    const fetchFn = jevAnswer("shareable", 0.99);
    const { isError, body } = await promote({ config: JEV_ON, fetchFn });
    expect(isError).toBe(true);
    expect(String(body.text)).toContain("reject-secret");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(state.promoteCalls).toHaveLength(0);
  });

  it("flag off: identical to today, Jev never called", async () => {
    const fetchFn = jevAnswer("credential_bearing", 0.99);
    const { isError, body } = await promote({
      config: { ...JEV_ON, enabled: false },
      fetchFn,
    });
    expect(isError).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(body.classification).toBe("share");
    expect(state.promoteCalls[0]?.promotionConfidence).toBeUndefined();
  });

  it("dry_run returns the would-insert preview plus the screen verdict", async () => {
    const { isError, body } = await promote(
      { config: JEV_ON, fetchFn: jevAnswer("shareable", 0.93) },
      { dry_run: true },
    );
    expect(isError).toBe(false);
    expect(body.would_insert).toBe(true);
    expect(body.share_screen).toEqual({ answer: "shareable", confidence: 0.93 });
  });

  it("arrival: the parsed OPENBRAIN_JEV_SHARE_SCREEN_ENABLED reaches the tool", async () => {
    const base = {
      DB_HOST: "db.internal",
      DB_NAME: "open_brain_test",
      DB_USER: "open_brain",
      LOG_FILE: "logs/open-brain.log",
      OPENBRAIN_JEV_API_KEY: "test-key",
    };
    const off = parseServerConfig(base);
    const on = parseServerConfig({ ...base, OPENBRAIN_JEV_SHARE_SCREEN_ENABLED: "1" });
    if (!off.ok || !on.ok) throw new Error("expected valid configuration");
    expect(off.config.search.jevShareScreen.enabled).toBe(false);
    expect(on.config.search.jevShareScreen.enabled).toBe(true);
    const fetchFn = jevAnswer("namespace_private", 0.99);
    const { isError } = await promote({
      config: on.config.search.jevShareScreen,
      fetchFn,
    });
    expect(isError).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
