import { describe, expect, it } from "bun:test";
import {
  DEFAULT_WORKING_SET_BUDGET,
  WORKING_SET_LABEL,
  WorkingSetStore,
  compareWorkingSetScope,
  normalizeWorkingSetScope,
  workingSetScopeKey,
  type WorkingSetScope,
} from "./working-set.ts";

const BASE_SCOPE: WorkingSetScope = {
  namespace: "shared-kb",
  agent: "nagatha",
  platform: "discord",
  server_id: "rodaddy-live",
  channel_id: "open-brain",
  thread_id: null,
  session_key: "discord:rodaddy-live:open-brain:nagatha",
};

const BASE_TIME = new Date("2026-07-06T13:15:00.000Z");

function variant(
  patch: Partial<WorkingSetScope>,
): WorkingSetScope {
  return { ...BASE_SCOPE, ...patch };
}

describe("WorkingSetStore", () => {
  it("includes only exact-scope working context in a context-pack fragment", () => {
    const store = new WorkingSetStore();
    const append = store.append(
      BASE_SCOPE,
      {
        kind: "current_intent",
        content: "Finish issue #222 local working-set slice.",
        confidence: 0.92,
        trace_id: "trace-222",
      },
      BASE_TIME,
    );

    expect(append.accepted).toBe(true);

    const fragment = store.buildContextPackFragment(BASE_SCOPE, BASE_TIME);

    expect(fragment.working_set.schema).toBe("openbrain.working_set.v1");
    expect(fragment.working_set.label).toBe(WORKING_SET_LABEL);
    expect(fragment.working_set.not_durable_memory).toBe(true);
    expect(fragment.working_set.exact_scope_required).toBe(true);
    expect(fragment.working_set.item_count).toBe(1);
    expect(fragment.working_set.items[0]).toMatchObject({
      kind: "current_intent",
      label: WORKING_SET_LABEL,
      content: "Finish issue #222 local working-set slice.",
      trace_id: "trace-222",
    });
    expect(fragment.warnings.scope_denials).toEqual([]);
  });

  it.each([
    ["namespace", variant({ namespace: "other-ns" })],
    ["agent", variant({ agent: "skippy" })],
    ["platform", variant({ platform: "slack" })],
    ["server_id", variant({ server_id: "other-server" })],
    ["channel_id", variant({ channel_id: "other-channel" })],
    ["thread_id", variant({ thread_id: "thread-1" })],
    ["session_key", variant({ session_key: "different-session" })],
  ] as const)(
    "denies working-set content across different %s",
    (field, adjacentScope) => {
      const store = new WorkingSetStore();
      store.append(
        BASE_SCOPE,
        {
          kind: "task_state",
          content: "base scope task",
        },
        BASE_TIME,
      );
      store.append(
        adjacentScope,
        {
          kind: "task_state",
          content: `adjacent ${field} task`,
        },
        BASE_TIME,
      );

      const fragment = store.buildContextPackFragment(BASE_SCOPE, BASE_TIME);

      expect(fragment.working_set.items.map((item) => item.content)).toEqual([
        "base scope task",
      ]);
      expect(fragment.warnings.scope_denials).toHaveLength(1);
      expect(fragment.warnings.scope_denials[0]?.reasons).toContain(field);
    },
  );

  it("treats missing thread and threaded scope as different exact scopes", () => {
    const unthreaded = normalizeWorkingSetScope(BASE_SCOPE);
    const threaded = normalizeWorkingSetScope(variant({ thread_id: "t-1" }));

    expect(unthreaded.thread_id).toBeNull();
    expect(threaded.thread_id).toBe("t-1");
    expect(workingSetScopeKey(unthreaded)).not.toBe(
      workingSetScopeKey(threaded),
    );
    expect(compareWorkingSetScope(unthreaded, threaded)).toEqual(["thread_id"]);
  });

  it("expires RAM-first items and exposes the expired counter", () => {
    const store = new WorkingSetStore({ ttl_ms: 1000 });
    store.append(
      BASE_SCOPE,
      {
        kind: "recent_event",
        content: "temporary event",
      },
      BASE_TIME,
    );

    const afterTtl = new Date(BASE_TIME.getTime() + 1001);
    const fragment = store.buildContextPackFragment(BASE_SCOPE, afterTtl);

    expect(fragment.working_set.items).toEqual([]);
    expect(fragment.working_set.counters.expired).toBe(1);
  });

  it("drops invalid or oversized items and exposes dropped counters", () => {
    const store = new WorkingSetStore({ max_item_chars: 8 });

    const empty = store.append(
      BASE_SCOPE,
      {
        kind: "recent_event",
        content: "   ",
      },
      BASE_TIME,
    );
    const oversized = store.append(
      BASE_SCOPE,
      {
        kind: "recent_event",
        content: "too long for budget",
      },
      BASE_TIME,
    );

    expect(empty).toMatchObject({ accepted: false, reason: "empty_content" });
    expect(oversized).toMatchObject({
      accepted: false,
      reason: "content_too_large",
    });
    expect(store.getCounters().dropped).toBe(2);
  });

  it("trims per-session and global budgets and exposes trimmed counters", () => {
    const store = new WorkingSetStore({
      max_items_per_session: 2,
      max_global_items: 3,
      max_sessions: DEFAULT_WORKING_SET_BUDGET.max_sessions,
    });

    store.append(BASE_SCOPE, { kind: "recent_event", content: "one" }, BASE_TIME);
    store.append(BASE_SCOPE, { kind: "recent_event", content: "two" }, BASE_TIME);
    store.append(
      BASE_SCOPE,
      { kind: "recent_event", content: "three" },
      BASE_TIME,
    );

    const perSession = store.buildContextPackFragment(BASE_SCOPE, BASE_TIME);
    expect(perSession.working_set.items.map((item) => item.content)).toEqual([
      "two",
      "three",
    ]);
    expect(perSession.working_set.counters.trimmed).toBe(1);

    store.append(
      variant({ session_key: "session-2" }),
      { kind: "recent_event", content: "four" },
      BASE_TIME,
    );
    store.append(
      variant({ session_key: "session-3" }),
      { kind: "recent_event", content: "five" },
      BASE_TIME,
    );

    expect(store.getCounters().trimmed).toBeGreaterThanOrEqual(2);
  });

  it("uses documented budget defaults", () => {
    const store = new WorkingSetStore();

    expect(store.budget).toEqual(DEFAULT_WORKING_SET_BUDGET);
    expect(store.budget).toMatchObject({
      ttl_ms: 1_800_000,
      max_sessions: 128,
      max_items_per_session: 24,
      max_global_items: 1024,
    });
  });
});
