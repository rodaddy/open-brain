/**
 * Functional tests for `agent_context_pack` / `agent_reflex_pointers`.
 *
 * The parity fixtures freeze the EMPTY-path envelope. They cannot reach the
 * behavior that actually distinguishes a correct pack from a broken one:
 * budget-driven trimming, citation bijection after a trim, the one-recall
 * invariant, the pointer/durable dedupe, and the body-free pointer guarantee.
 * A pack that emitted memory bodies as pointers, or double-listed evidence, or
 * ran the retrieval stack twice, would pass every fixture in the suite.
 *
 * Everything here runs against a fake pool, so there is no database and no
 * fixture state to reset. Assertions are on emitted SQL/parameters and on the
 * returned payload, never on rows a real database happened to hold.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pino from "pino";
import type { Pool } from "pg";
import type { Role } from "../config.ts";
import { WorkingSetStore } from "../realtime/working-set.ts";
import { registerMemoryTools } from "./index.ts";

interface CapturedQuery {
  readonly sql: string;
  readonly values: readonly unknown[];
}

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** One recalled brain row, shaped as the search engine emits it. */
function searchRow(id: string, preview: string, namespace = "rico") {
  return {
    source_type: "thought",
    id,
    namespace,
    content_preview: preview,
    tags: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: null,
    usefulness: 1,
    tier: "warm",
  };
}

/**
 * Whether a captured statement belongs to the hybrid recall.
 *
 * A hybrid `executeSearch` issues TWO statements — the vector arm and the FTS
 * arm, in parallel — so counting statements counts arms, not retrieval stacks.
 * The vector arm is identified by its `query_embedding` CTE and the FTS arm by
 * its `fts_query` CTE, which lets a test count either one to count STACKS.
 */
function isRecallSql(sql: string): boolean {
  return sql.includes("query_embedding") || sql.includes("fts_query");
}

/** @returns The count of hybrid recall STACKS run (one per `executeSearch`). */
function recallStackCount(queries: readonly CapturedQuery[]): number {
  // Count only the vector arm: exactly one is issued per hybrid executeSearch.
  return queries.filter((query) => query.sql.includes("query_embedding")).length;
}

interface HarnessOptions {
  /** Rows every recall query returns. */
  readonly rows?: Array<Record<string, unknown>>;
  readonly workingSetStore?: WorkingSetStore;
  /** Forces the recall query to throw, exercising the degraded path. */
  readonly failRecall?: boolean;
}

async function harness(
  role: Role,
  clientId: string,
  options: HarnessOptions = {},
): Promise<{ client: Client; queries: CapturedQuery[] }> {
  const queries: CapturedQuery[] = [];
  const server = new McpServer({ name: "context-pack-test", version: "1.0.0" });
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      // The structured sections read ob_session_events / ob_entities and get [].
      const isRecall = isRecallSql(sql);
      if (isRecall && options.failRecall) throw new Error("recall exploded");
      return { rows: isRecall ? (options.rows ?? []) : [] };
    },
  } as unknown as Pool;
  registerMemoryTools(server, {
    pool,
    embedFn: async () => Array(768).fill(0.01),
    logger: pino({ level: "silent" }),
    ...(options.workingSetStore
      ? { workingSetStore: options.workingSetStore }
      : {}),
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, sendOptions) =>
    send(message, {
      ...sendOptions,
      authInfo: { role, clientId, namespaceSource: "token" },
    } as unknown as Parameters<typeof send>[1]);
  const client = new Client({ name: "context-pack-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, queries };
}

/** Call a tool and parse its single JSON text payload. */
async function callJson(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ payload: Record<string, unknown>; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
  return {
    payload: JSON.parse(text) as Record<string, unknown>,
    isError: result.isError === true,
  };
}

const SCOPE = {
  agent: "fixture-agent",
  platform: "test",
  server_id: "server-1",
  channel_id: "channel-1",
  session_key: "pack/test",
};

function sectionsOf(payload: Record<string, unknown>) {
  return payload.sections as Record<string, Record<string, unknown> | undefined>;
}

/**
 * The named section, failing loudly when it is absent.
 *
 * Asserting presence here rather than optional-chaining downstream means a
 * missing section fails as "expected pointers to be defined" instead of as a
 * confusing `undefined` mismatch several assertions later.
 */
function sectionOf(
  payload: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  const section = sectionsOf(payload)[name];
  expect(section).toBeDefined();
  return section as Record<string, unknown>;
}

/** Items of a named section, typed for the field each test reads. */
function itemsOf<T extends Record<string, unknown>>(
  payload: Record<string, unknown>,
  name: string,
): T[] {
  return (sectionOf(payload, name).items ?? []) as T[];
}

function citationIds(payload: Record<string, unknown>): string[] {
  return (payload.citations as Array<{ id: string }>).map(
    (citation) => citation.id,
  );
}

describe("namespace isolation is enforced before any query runs", () => {
  test("an unauthorized explicit namespace is denied, not silently emptied", async () => {
    const { client, queries } = await harness("agent", "rico");

    const { payload, isError } = await callJson(client, "agent_context_pack", {
      ...SCOPE,
      namespace: "someone-else",
      query: "anything",
      requested_sections: ["durable_memory"],
    });

    expect(isError).toBe(true);
    expect(payload.error).toBe(
      "Permission denied: cannot read namespace 'someone-else'",
    );
    // The point of gating BEFORE the query: a denial that ran the query and
    // returned no rows is indistinguishable from "nothing matched".
    expect(queries).toHaveLength(0);
  });

  test("the recall binds the caller's own namespaces, never a global read", async () => {
    const { client, queries } = await harness("agent", "rico");

    await callJson(client, "agent_context_pack", {
      ...SCOPE,
      query: "needle",
      requested_sections: ["durable_memory"],
    });

    const recall = queries.find((query) => isRecallSql(query.sql));
    expect(recall).toBeDefined();
    expect(recall?.values).toContainEqual(["rico", "shared-kb"]);
  });
});

describe("one retrieval stack feeds durable_memory, pointers, and candidates", () => {
  test("requesting durable_memory AND pointers together runs exactly one recall", async () => {
    const { client, queries } = await harness("agent", "rico", {
      rows: [searchRow("a", "alpha"), searchRow("b", "bravo")],
    });

    await callJson(client, "agent_context_pack", {
      ...SCOPE,
      query: "needle",
      requested_sections: ["durable_memory", "pointers"],
    });

    // Two recall STACKS would double every pack's cost AND could rank
    // differently, so pointers would dedupe against rows durable_memory never
    // saw. (One stack is two statements: the parallel vector and FTS arms.)
    expect(recallStackCount(queries)).toBe(1);
  });

  test("candidate_memory alone runs no recall at all", async () => {
    const { client, queries } = await harness("agent", "rico", {
      rows: [searchRow("a", "alpha")],
    });

    const { payload } = await callJson(client, "agent_context_pack", {
      ...SCOPE,
      query: "needle",
      requested_sections: ["candidate_memory"],
    });

    expect(recallStackCount(queries)).toBe(0);
    // It is always empty, so retrieving anything to dedupe against would be
    // pure waste on a section that can never emit a row.
    expect(sectionOf(payload, "candidate_memory")).toMatchObject({
      items: [],
      item_count: 0,
      empty_reason: "candidate_predicate_unavailable",
      confidence: "unconfirmed",
      auto_promotable: false,
    });
  });
});

describe("pointers carry references, never bodies", () => {
  test("a pointer emits identity and structural source_ref with no content field", async () => {
    const { client } = await harness("agent", "rico", {
      rows: [searchRow("a", "a memory body that must not be copied")],
    });

    const { payload } = await callJson(client, "agent_context_pack", {
      ...SCOPE,
      query: "needle",
      requested_sections: ["pointers"],
    });

    expect(sectionOf(payload, "pointers").item_count).toBe(1);
    const item = itemsOf<Record<string, unknown>>(payload, "pointers")[0]!;
    expect(item.citation_id).toBe("brain_record:thought:a");
    expect(item.source_ref).toEqual({
      source: "brain",
      type: "thought",
      id: "a",
      namespace: "rico",
    });
    // The whole value of a pointer is that it is cheap and body-free. Any of
    // these fields appearing is body leakage.
    for (const forbidden of ["content", "content_preview", "label", "preview"]) {
      expect(item).not.toHaveProperty(forbidden);
    }
    // ... including inside the nested source_ref, which the durable item's own
    // source_ref DOES carry.
    expect(item.source_ref).not.toHaveProperty("label");
    expect(item.source_ref).not.toHaveProperty("preview");
  });

  test("a pointer is dropped when durable_memory already emitted that record", async () => {
    const { client } = await harness("agent", "rico", {
      rows: [searchRow("a", "alpha"), searchRow("b", "bravo")],
    });

    const { payload } = await callJson(client, "agent_context_pack", {
      ...SCOPE,
      query: "needle",
      requested_sections: ["durable_memory", "pointers"],
    });

    const durableIds = itemsOf<{ citation_id: string }>(
      payload,
      "durable_memory",
    ).map((item) => item.citation_id);
    const pointerIds = itemsOf<{ citation_id: string }>(
      payload,
      "pointers",
    ).map((item) => item.citation_id);

    expect(durableIds).toEqual(["brain_record:thought:a", "brain_record:thought:b"]);
    // Durable owns this evidence; re-listing it would double-count it against
    // the caller's budget and show the same record twice.
    expect(pointerIds).toEqual([]);
  });

  test("a record suppressed from durable output stays pointer-eligible", async () => {
    const { client } = await harness("agent", "rico", {
      rows: [searchRow("a", "alpha")],
    });

    // pointers-only: the durable SECTION is suppressed for output, so every
    // authorized row remains pointer-eligible rather than vanishing entirely.
    const { payload } = await callJson(client, "agent_context_pack", {
      ...SCOPE,
      query: "needle",
      requested_sections: ["pointers"],
    });

    expect(sectionsOf(payload)).not.toHaveProperty("durable_memory");
    expect(sectionOf(payload, "pointers").item_count).toBe(1);
  });
});

describe("prior-context suppression removes only what the caller already has", () => {
  test("a record referenced by citation_id is dropped and counted", async () => {
    const { client } = await harness("agent", "rico", {
      rows: [searchRow("a", "alpha"), searchRow("b", "bravo")],
    });

    const { payload } = await callJson(client, "agent_context_pack", {
      ...SCOPE,
      query: "needle",
      requested_sections: ["durable_memory"],
      prior_context: [{ citation_id: "brain_record:thought:a" }],
    });

    const durable = sectionOf(payload, "durable_memory");
    expect(
      itemsOf<{ id: string }>(payload, "durable_memory").map((item) => item.id),
    ).toEqual(["b"]);
    // Content-free counters: counts only, never an id or a body.
    expect(durable.prior_context_suppression).toEqual({
      recalled: 2,
      suppressed: 1,
      net_new: 1,
      emitted: 1,
    });
  });

  test("a structural source_ref suppresses the same record as its citation_id", async () => {
    const { client } = await harness("agent", "rico", {
      rows: [searchRow("a", "alpha")],
    });

    const { payload } = await callJson(client, "agent_context_pack", {
      ...SCOPE,
      query: "needle",
      requested_sections: ["durable_memory"],
      // The structural form a caller echoes back from an emitted item. Display
      // fields are absent here and present on the emitted ref; identity must
      // still match, or suppression silently stops working after a truncation.
      prior_context: [
        {
          source_ref: {
            source: "brain",
            type: "thought",
            id: "a",
            namespace: "rico",
          },
        },
      ],
    });

    const durable = sectionOf(payload, "durable_memory");
    expect(durable.item_count).toBe(0);
    expect(durable.empty_reason).toBe("all_suppressed");
  });
});

describe("citations stay a bijection with emitted items", () => {
  test("every citation maps to an emitted item and every item to a citation", async () => {
    const { client } = await harness("agent", "rico", {
      rows: [searchRow("a", "alpha"), searchRow("b", "bravo")],
    });

    const { payload } = await callJson(client, "agent_context_pack", {
      ...SCOPE,
      query: "needle",
      requested_sections: ["durable_memory", "pointers"],
    });

    const emitted = Object.values(sectionsOf(payload)).flatMap((section) =>
      ((section?.items ?? []) as Array<{ citation_id?: string }>)
        .map((item) => item.citation_id)
        .filter((id): id is string => typeof id === "string"),
    );
    expect(citationIds(payload).sort()).toEqual(emitted.sort());
  });

  test("a whole-pack trim drops the citations of the items it dropped", async () => {
    const rows = Array.from({ length: 12 }, (_, index) =>
      searchRow(`row-${index}`, "x".repeat(400)),
    );
    const { client } = await harness("agent", "rico", { rows });

    const { payload } = await callJson(client, "agent_context_pack", {
      ...SCOPE,
      query: "needle",
      requested_sections: ["durable_memory"],
      // Measured against these exact rows, not guessed: 12 rows of 400 chars
      // yield 0 items at 600 tokens, 5 at 2000, and all 12 at 4000. 2000 is
      // therefore squarely inside the PARTIAL-trim band this test is about — a
      // fully starved section would exercise the omission path instead.
      budget: { max_tokens: 2000 },
    });

    const durable = sectionOf(payload, "durable_memory");
    const kept = itemsOf<{ citation_id: string }>(
      payload,
      "durable_memory",
    ).map((item) => item.citation_id);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(rows.length);
    // A citation pointing at trimmed evidence is worse than no citation: it
    // looks resolvable and is not.
    expect(citationIds(payload).sort()).toEqual([...kept].sort());
    expect(durable.item_count).toBe(kept.length);
    expect(durable.truncated).toBe(true);
  });
});

describe("the whole-pack budget is a hard bound", () => {
  test("the serialized sections object never exceeds the declared limit", async () => {
    const rows = Array.from({ length: 20 }, (_, index) =>
      searchRow(`row-${index}`, "y".repeat(500)),
    );
    const { client } = await harness("agent", "rico", { rows });

    const { payload } = await callJson(client, "agent_context_pack", {
      ...SCOPE,
      query: "needle",
      requested_sections: ["durable_memory", "pointers"],
      budget: { max_tokens: 800 },
    });

    const budget = payload.budget as {
      whole_pack: { content_char_limit: number; content_chars_used: number };
    };
    // The bound applies to the SERIALIZED object, not the summed bodies —
    // wrappers, ids, and metadata all have to fit inside the caller's tokens.
    expect(JSON.stringify(payload.sections).length).toBeLessThanOrEqual(
      budget.whole_pack.content_char_limit,
    );
    expect(budget.whole_pack.content_chars_used).toBeLessThanOrEqual(
      budget.whole_pack.content_char_limit,
    );
    expect(
      (payload.warnings as { truncation: unknown[] }).truncation.length,
    ).toBeGreaterThan(0);
  });

  test("the declared limit never falls below the irreducible empty object", async () => {
    const { client } = await harness("agent", "rico", {
      rows: [searchRow("a", "z".repeat(5000))],
    });

    const { payload } = await callJson(client, "agent_context_pack", {
      ...SCOPE,
      query: "needle",
      requested_sections: ["durable_memory"],
      // Far below the envelope reserve, so the member budget clamps to zero.
      budget: { max_tokens: 100 },
    });

    const budget = payload.budget as {
      whole_pack: { content_char_limit: number };
    };
    // `JSON.stringify({})` is 2 characters even with every section omitted, so
    // a declared limit below 2 would be a bound the payload cannot honour.
    expect(budget.whole_pack.content_char_limit).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(payload.sections).length).toBeLessThanOrEqual(
      budget.whole_pack.content_char_limit,
    );
  });

  test("a section starved out entirely still records a starved marker", async () => {
    const { client } = await harness("agent", "rico", {
      rows: [searchRow("a", "z".repeat(5000))],
    });

    const { payload } = await callJson(client, "agent_context_pack", {
      ...SCOPE,
      query: "needle",
      requested_sections: ["durable_memory"],
      budget: { max_tokens: 100 },
    });

    expect(sectionsOf(payload)).not.toHaveProperty("durable_memory");
    // Omitted-and-silent would be indistinguishable from never-requested.
    expect(
      (payload.warnings as { truncation: Array<Record<string, unknown>> })
        .truncation,
    ).toContainEqual(
      expect.objectContaining({
        source: "durable_memory",
        reason: "whole_pack_budget",
        starved: true,
      }),
    );
    // No citation may survive for a section that was not emitted.
    expect(citationIds(payload)).toEqual([]);
  });
});

describe("working_set reads exact scope only", () => {
  test("items appear for the exact scope and never for a near-miss scope", async () => {
    const store = new WorkingSetStore();
    store.append(
      { namespace: "rico", ...SCOPE, thread_id: null },
      { kind: "current_intent", content: "the active intent" },
    );
    const { client } = await harness("agent", "rico", {
      workingSetStore: store,
    });

    const exact = await callJson(client, "agent_context_pack", {
      ...SCOPE,
      requested_sections: ["working_set"],
    });
    expect(sectionOf(exact.payload, "working_set").item_count).toBe(1);

    // One coordinate differs. Exact scope means exact: a channel sibling must
    // not see this lane's working context.
    const nearMiss = await callJson(client, "agent_context_pack", {
      ...SCOPE,
      channel_id: "channel-2",
      requested_sections: ["working_set"],
    });
    const section = sectionOf(nearMiss.payload, "working_set");
    expect(section.item_count).toBe(0);
    // The near miss is reported content-free, so the caller can tell "wrong
    // lane" from "nothing here" without learning the other lane's contents.
    const denials = (
      nearMiss.payload.warnings as {
        scope_denials: Array<Record<string, unknown>>;
      }
    ).scope_denials;
    expect(denials).toContainEqual(
      expect.objectContaining({ reasons: ["channel_id"] }),
    );
    expect(JSON.stringify(denials)).not.toContain("the active intent");
  });
});

describe("a failed recall degrades content-free instead of erroring", () => {
  test("durable_memory reports recall_failed and leaks no error detail", async () => {
    const { client } = await harness("agent", "rico", { failRecall: true });

    const { payload, isError } = await callJson(client, "agent_context_pack", {
      ...SCOPE,
      query: "needle",
      requested_sections: ["durable_memory"],
    });

    expect(isError).toBe(false);
    expect(sectionOf(payload, "durable_memory")).toMatchObject({
      items: [],
      item_count: 0,
      empty_reason: "recall_failed",
    });
    expect(
      (payload.warnings as { degraded_sources: unknown[] }).degraded_sources,
    ).toContainEqual({ source: "durable_memory", reason: "recall_failed" });
    // The envelope must not carry the driver's message.
    expect(JSON.stringify(payload)).not.toContain("recall exploded");
  });
});

describe("agent_reflex_pointers projects the pack without a second stack", () => {
  test("the reflex runs exactly one recall and returns body-free pointers", async () => {
    const { client, queries } = await harness("agent", "rico", {
      rows: [searchRow("a", "alpha"), searchRow("b", "bravo")],
    });

    const { payload } = await callJson(client, "agent_reflex_pointers", {
      ...SCOPE,
      query: "needle",
    });

    expect(recallStackCount(queries)).toBe(1);
    expect(payload.schema).toBe("openbrain.agent_reflex_pointers.v1");
    expect(payload.placement).toBe("client_owned");
    expect(payload.resolvable_reference_only).toBe(true);
    const pointers = payload.pointers as Record<string, unknown>;
    expect(pointers.item_count).toBe(2);
    for (const item of pointers.items as Array<Record<string, unknown>>) {
      expect(item).not.toHaveProperty("content");
    }
    // The bijection survives the projection.
    expect(citationIds(payload).sort()).toEqual(
      (pointers.items as Array<{ citation_id: string }>)
        .map((item) => item.citation_id)
        .sort(),
    );
  });

  test("the reflex emits no non-pointer section even when the pack could", async () => {
    const { client } = await harness("agent", "rico", {
      rows: [searchRow("a", "alpha")],
    });

    const { payload } = await callJson(client, "agent_reflex_pointers", {
      ...SCOPE,
      query: "needle",
    });

    // It is a pointer reflex; a durable body arriving here would defeat the
    // entire reason the surface exists.
    expect(payload).not.toHaveProperty("sections");
    expect(payload).not.toHaveProperty("durable_memory");
  });

  test("an auth denial passes through unchanged rather than inventing a message", async () => {
    const { client } = await harness("agent", "rico");

    const { payload, isError } = await callJson(
      client,
      "agent_reflex_pointers",
      { ...SCOPE, namespace: "someone-else", query: "needle" },
    );

    expect(isError).toBe(true);
    expect(payload.error).toBe(
      "Permission denied: cannot read namespace 'someone-else'",
    );
  });

  test("prior-context suppression applies before any pointer is emitted", async () => {
    const { client } = await harness("agent", "rico", {
      rows: [searchRow("a", "alpha"), searchRow("b", "bravo")],
    });

    const { payload } = await callJson(client, "agent_reflex_pointers", {
      ...SCOPE,
      query: "needle",
      prior_context: [{ citation_id: "brain_record:thought:a" }],
    });

    const pointers = payload.pointers as Record<string, unknown>;
    expect(
      (pointers.items as Array<{ citation_id: string }>).map(
        (item) => item.citation_id,
      ),
    ).toEqual(["brain_record:thought:b"]);
  });
});
