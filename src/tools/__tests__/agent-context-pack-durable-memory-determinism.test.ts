import { describe, expect, it } from "bun:test";
import type { AuthInfo } from "../../types.ts";
import {
  AGENT_CONTEXT_PACK_SCOPE as SCOPE,
  setupAgentContextPackToolClient as setupToolClient,
} from "./agent-context-pack-test-helpers.ts";
import {
  brainRecord,
  searchPool,
  type JsonRecord,
} from "./agent-context-pack-durable-memory-test-helpers.ts";

describe("agent_context_pack durable_memory determinism", () => {
  it("multi-query determinism: identical inputs produce identical durable_memory allocation", async () => {
    const records = Array.from({ length: 5 }, (_, index) =>
      brainRecord({
        id: `stable-${index}`,
        content_preview: `stable-${index}:` + "S".repeat(700),
        distance: 0.1 + index * 0.05,
        fts_rank: 1 - index * 0.1,
      }),
    );
    async function run() {
      const { pool } = searchPool(records);
      const auth: AuthInfo = { role: "admin", clientId: "rico" };
      const { client, cleanup } = await setupToolClient(auth, pool);
      try {
        const pack = await client.callTool({
          name: "agent_context_pack",
          arguments: {
            ...SCOPE,
            query: "stable",
            requested_sections: ["durable_memory"],
            budget: { max_tokens: 900 },
          },
        });
        return JSON.parse((pack.content as [{ text: string }])[0].text);
      } finally {
        await cleanup();
      }
    }
    const first = await run();
    const second = await run();
    expect(first.sections.durable_memory.items.map((i: JsonRecord) => i.id)).toEqual(
      second.sections.durable_memory.items.map((i: JsonRecord) => i.id),
    );
    expect(first.budget.durable_memory).toEqual(second.budget.durable_memory);
    expect(first.warnings.truncation).toEqual(second.warnings.truncation);
  });
});

describe("agent_context_pack durable_memory absent budget", () => {
  it("recalls a large body WHOLE when no budget is supplied (absent budget = total recall)", async () => {
    // Regression for the Sol cross-family finding: with neither an explicit
    // whole-pack allocation nor a caller budget.max_tokens, the section MUST
    // return everything, matching the durable-lane resolver and the section's
    // own 'unbounded by default' contract. The prior code applied an undeclared
    // 4000-token default -> ~14,800 char ceiling, silently truncating any
    // larger single record. This body is far past that ceiling and must survive
    // intact, with the reported content_char_limit being the unbounded cap.
    const bigBody = "Z".repeat(60_000);
    const { pool } = searchPool([
      brainRecord({
        id: "big-1",
        source_type: "decision",
        content_preview: bigBody,
      }),
    ]);
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(auth, pool);
    try {
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          query: "big durable record",
          requested_sections: ["durable_memory"],
          // Deliberately NO budget: this is the total-recall path.
        },
      });
      const payload = JSON.parse((pack.content as [{ text: string }])[0].text);
      expect(pack.isError).toBeFalsy();
      const section = payload.sections.durable_memory;
      expect(section.items.length).toBe(1);
      // The body survives whole -- not clipped at the old ~14,800 ceiling.
      expect(section.items[0].content.length).toBe(bigBody.length);
      expect(section.items[0].content).toBe(bigBody);
      expect(section.truncated).toBe(false);
      // The reported per-section char limit is the unbounded cap, not 14,800.
      expect(payload.budget.durable_memory.content_char_limit).toBe(
        Number.MAX_SAFE_INTEGER,
      );
    } finally {
      await cleanup();
    }
  });
});

describe("agent_context_pack durable_memory explicit budget", () => {
  it("still bounds the section when an explicit budget.max_tokens is supplied", async () => {
    // The no-default fix must not disable explicit budgeting: a caller that
    // asks for a small token budget still gets a derived char ceiling that
    // truncates an oversized body. This keeps the total-recall default from
    // silently ignoring a real request.
    const bigBody = "Y".repeat(60_000);
    const { pool } = searchPool([
      brainRecord({
        id: "bounded-1",
        source_type: "decision",
        content_preview: bigBody,
      }),
    ]);
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(auth, pool);
    try {
      const maxTokens = 500;
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          query: "bounded durable record",
          requested_sections: ["durable_memory"],
          budget: { max_tokens: maxTokens },
        },
      });
      const payload = JSON.parse((pack.content as [{ text: string }])[0].text);
      expect(pack.isError).toBeFalsy();
      const section = payload.sections.durable_memory;
      // The reported limit derives from the explicit budget, not the unbounded
      // cap -- so an explicit budget is honoured, not bypassed by the default.
      expect(payload.budget.durable_memory.content_char_limit).toBeLessThan(
        Number.MAX_SAFE_INTEGER,
      );
      // The oversized body is truncated to fit the explicit budget.
      if (section.items.length > 0) {
        expect(section.items[0].content.length).toBeLessThan(bigBody.length);
      }
      expect(section.truncated).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
