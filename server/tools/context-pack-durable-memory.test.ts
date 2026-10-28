/**
 * The durable_memory burst rule (#563) without Postgres (issue 683).
 *
 * The rule's only other catchers are Postgres-gated, so a run with no test
 * database skipped them and a changed burst size went unnoticed. Here the one
 * retrieval call is replaced by an in-memory fake that returns a fixed ranked
 * recall, and the rule is asserted at its edge: one under, at, and one over
 * the burst size, plus the continuation that walks the remainder.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthIdentity } from "../auth/types.ts";
import type { AgentContextPackArgs } from "./context-pack-args.ts";
import type { SearchRow } from "./search-engine.ts";
import type { MemoryToolDependencies } from "./types.ts";
import { DEFAULT_SHARED_NAMESPACE_NAMES } from "./shared-namespace-fixture.ts";

const fakeRecall = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock("./search-engine.ts", () => ({
  executeSearch: vi.fn(async () => fakeRecall.rows),
  readableSearchSources: vi.fn(() => ["thoughts"]),
}));

const { loadDurableMemoryContext } = await import("./context-pack-durable-memory.ts");

/** The burst size the operator ruled on (ledger item 23). */
const BURST = 10;

function recalledRows(count: number): SearchRow[] {
  return Array.from({ length: count }, (_, index) => ({
    source_type: "thought",
    id: `row-${index}`,
    namespace: "burst-test",
    content_preview: `record ${index}`,
    tags: null,
    created_at: "2026-09-27T00:00:00.000Z",
    usefulness: 0,
  }));
}

const auth: AuthIdentity = {
  role: "admin",
  clientId: "burst-test",
  tokenClientId: "burst-test",
  namespaceSource: "token",
};

async function recall(count: number, offset?: number) {
  fakeRecall.rows = recalledRows(count);
  const args = {
    agent: "burst-test",
    platform: "vitest",
    session_key: "burst-test",
    query: "burst",
    ...(offset === undefined ? {} : { continue_from: { offset } }),
  } as unknown as AgentContextPackArgs;
  const fragment = await loadDurableMemoryContext({
    args,
    auth,
    namespace: "burst-test",
    dependencies: {
      sharedNamespaceNames: DEFAULT_SHARED_NAMESPACE_NAMES,
    } as unknown as MemoryToolDependencies,
  });
  const section = fragment.section as {
    items: Array<{ id: string }>;
    next?: { offset: number; delivered_through: number };
  };
  return { fragment, section };
}

describe("durable_memory burst rule (no Postgres)", () => {
  beforeEach(() => {
    fakeRecall.rows = [];
  });

  it("reports the current burst size in the budget", async () => {
    const { fragment } = await recall(1);
    expect(fragment.budget.burst_items).toBe(BURST);
  });

  it("one under the burst size: every record in one reply, no continuation", async () => {
    const { section } = await recall(BURST - 1);
    expect(section.items).toHaveLength(BURST - 1);
    expect(section.next).toBeUndefined();
  });

  it("at the burst size: every record in one reply, no continuation", async () => {
    const { section } = await recall(BURST);
    expect(section.items).toHaveLength(BURST);
    expect(section.next).toBeUndefined();
  });

  it("one over the burst size: one burst, then a continuation to the rest", async () => {
    const first = await recall(BURST + 1);
    expect(first.section.items).toHaveLength(BURST);
    expect(first.section.items.map((item) => item.id)).toEqual(
      recalledRows(BURST).map((row) => row.id),
    );
    expect(first.section.next).toEqual({ offset: BURST, delivered_through: BURST });

    const second = await recall(BURST + 1, first.section.next?.offset);
    expect(second.section.items.map((item) => item.id)).toEqual([`row-${BURST}`]);
    expect(second.section.next).toBeUndefined();
    expect(second.fragment.budget.burst_offset).toBe(BURST);
  });
});
