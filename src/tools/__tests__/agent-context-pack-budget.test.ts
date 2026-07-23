import { describe, expect, it } from "bun:test";
import type { AuthInfo } from "../../types.ts";
import {
  AGENT_CONTEXT_PACK_SCOPE as SCOPE,
  setupAgentContextPackToolClient as setupToolClient,
} from "./agent-context-pack-test-helpers.ts";
import { sectionFrameCost } from "../agent-context-pack-budget.ts";

const AUTH: AuthInfo = { role: "admin", clientId: "rico" };

describe("sectionFrameCost object framing", () => {
  it("charges no delimiter for the first admitted member", () => {
    // The first member of `{...}` is written as `"key":<body>` with no comma —
    // the outer braces are reserved separately. Framing is exactly the quoted
    // key plus the colon: '"' + key + '"' + ':' === key.length + 3.
    expect(sectionFrameCost("working_set", true)).toBe(
      "working_set".length + 3,
    );
    expect(sectionFrameCost("recovery", true)).toBe("recovery".length + 3);
    expect(sectionFrameCost("durable_lane_context", true)).toBe(
      "durable_lane_context".length + 3,
    );
  });

  it("charges exactly one comma for each subsequent admitted member", () => {
    // Each member after the first is written as `,"key":<body>` — one leading
    // comma on top of the quoted key and colon.
    expect(sectionFrameCost("working_set", false)).toBe(
      "working_set".length + 3 + 1,
    );
    expect(sectionFrameCost("recovery", false)).toBe("recovery".length + 3 + 1);
    expect(sectionFrameCost("durable_lane_context", false)).toBe(
      "durable_lane_context".length + 3 + 1,
    );
  });

  it("matches the literal JSON framing of a two-member sections object", () => {
    // Ground the helper against real JSON.stringify output: the framing a member
    // adds beyond its own serialized body equals sectionFrameCost.
    const bodyA = { x: 1 };
    const bodyB = { y: 2 };
    const twoMember = JSON.stringify({ working_set: bodyA, recovery: bodyB });
    // Outer braces (2) + first-member framing + firstBody + second-member
    // framing + secondBody === full serialized length.
    const firstFrame = sectionFrameCost("working_set", true);
    const secondFrame = sectionFrameCost("recovery", false);
    const total =
      2 +
      firstFrame +
      JSON.stringify(bodyA).length +
      secondFrame +
      JSON.stringify(bodyB).length;
    expect(total).toBe(twoMember.length);
    // A single-member object frames with only the first (comma-free) cost.
    const oneMember = JSON.stringify({ working_set: bodyA });
    expect(2 + firstFrame + JSON.stringify(bodyA).length).toBe(
      oneMember.length,
    );
  });
});

/**
 * Sum of retained section *content* characters — working-set item bodies plus
 * durable lane current-context and event bodies. This is the quantity the
 * whole-pack budget bounds; per-section serialized metadata is covered by the
 * envelope reserve, matching the durable-lane section's own budget model.
 */
function contentChars(payload: any): number {
  let total = 0;
  const ws = payload.sections.working_set;
  if (ws) {
    for (const item of ws.items) total += (item.content ?? "").length;
  }
  const durable = payload.sections.durable_lane_context;
  if (durable) {
    total += (durable.lane.current_context_md ?? "").length;
    for (const event of durable.events ?? [])
      total += (event.content ?? "").length;
  }
  const recovery = payload.sections.recovery;
  if (recovery) {
    for (const item of recovery.items)
      total += (item.content_preview ?? "").length;
  }
  return total;
}

const durableLane = {
  id: "lane-budget-1",
  session_key: SCOPE.session_key,
  status: "active",
  agent: SCOPE.agent,
  source: SCOPE.platform,
  channel_id: SCOPE.channel_id,
  thread_id: null,
  project: "open-brain",
  topic: "whole pack budget",
  current_context_md: "C".repeat(9000),
  updated_at: "2026-07-17T18:00:00Z",
};

// event-0 is oldest, event-7 newest (ascending created_at).
const durableEvents = Array.from({ length: 8 }, (_, index) => ({
  id: `event-${index}`,
  event_type: "fact",
  content: `event-${index}:` + "E".repeat(900),
  source: "shared",
  importance: "warm",
  artifact_path: null,
  transcript_ref: `collab/open-brain/conversations/${index}`,
  occurred_at: null,
  created_at: `2026-07-17T17:00:0${index}Z`,
}));

function durablePool() {
  return {
    query: async (sql: string) => {
      if (sql.includes("FROM ob_session_lanes") && !sql.includes("JOIN")) {
        return { rows: [durableLane] };
      }
      if (sql.includes("FROM ob_session_events")) {
        // Real SQL selects newest-first (created_at DESC); mirror that so the
        // loader's chronological reverse() lands the newest event at the tail,
        // matching the production ordering the whole-pack re-fit relies on.
        return { rows: [...durableEvents].reverse() };
      }
      return { rows: [] };
    },
  };
}

async function appendWorkingItem(
  client: any,
  content: string,
  extra: Record<string, unknown> = {},
) {
  return client.callTool({
    name: "working_set_append",
    arguments: {
      ...SCOPE,
      kind: "task_state",
      content,
      ...extra,
    },
  });
}

async function appendRecoveryItem(
  client: any,
  content: string,
  extra: Record<string, unknown> = {},
) {
  return client.callTool({
    name: "recovery_wal_append",
    arguments: {
      ...SCOPE,
      content,
      ...extra,
    },
  });
}

describe("agent_context_pack whole-pack budget", () => {
  it("bounds total serialized section content below the configured token budget", async () => {
    const { client, cleanup } = await setupToolClient(AUTH, durablePool());
    try {
      // Fill working set with several items and request a durable lane whose
      // 9000-char context alone would blow past the budget.
      for (let i = 0; i < 6; i += 1) {
        await appendWorkingItem(client, `item-${i}:` + "W".repeat(300));
      }

      const maxTokens = 1000;
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          requested_sections: ["working_set", "durable_lane_context"],
          budget: { max_tokens: maxTokens },
        },
      });

      expect(pack.isError).toBeFalsy();
      const payload = JSON.parse((pack.content as any)[0].text);
      // Content budget is max_tokens * 4 minus the envelope reserve (1200).
      const contentBudget = maxTokens * 4 - 1200;
      // Retained content never exceeds the whole-pack budget, even though the
      // durable context alone (9000 chars) would.
      expect(contentChars(payload)).toBeLessThanOrEqual(contentBudget);
      expect(payload.budget.whole_pack).toMatchObject({
        content_char_limit: contentBudget,
        allocation_order: [
          "working_set",
          "recovery",
          "durable_lane_context",
          "durable_memory",
          "profile_guidance",
          "process_guidance",
          "repo_facts",
          "pointers",
          "candidate_memory",
        ],
      });
    } finally {
      await cleanup();
    }
  });

  it("preserves the highest-priority section and starves the lowest under pressure", async () => {
    const { client, cleanup } = await setupToolClient(AUTH, durablePool());
    try {
      // One modest working-set item that fits comfortably.
      await appendWorkingItem(client, "keep-me:" + "W".repeat(400), {
        trace_id: "trace-keep",
      });

      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          // Budget large enough for the whole working set but not the 9000-char
          // durable context on top of it (max_tokens 700 => 1600 content chars).
          requested_sections: ["working_set", "durable_lane_context"],
          budget: { max_tokens: 700 },
        },
      });

      const payload = JSON.parse((pack.content as any)[0].text);
      // Highest-priority working_set survives whole.
      expect(payload.sections.working_set.item_count).toBe(1);
      expect(payload.sections.working_set.items[0].content).toContain(
        "keep-me",
      );
      // Durable lane is present but its content is bounded by the leftover
      // budget rather than its own independent 6000-char default cap.
      const durable = payload.sections.durable_lane_context;
      if (durable) {
        const contextLen = durable.lane.current_context_md?.length ?? 0;
        expect(contextLen).toBeLessThan(6000);
      }
      // Total retained content within budget.
      expect(contentChars(payload)).toBeLessThanOrEqual(700 * 4 - 1200);
    } finally {
      await cleanup();
    }
  });

  it("produces identical allocation and truncation for repeated identical inputs", async () => {
    async function run() {
      const { client, cleanup } = await setupToolClient(AUTH, durablePool());
      try {
        for (let i = 0; i < 5; i += 1) {
          await appendWorkingItem(client, `stable-${i}:` + "W".repeat(1500));
        }
        const pack = await client.callTool({
          name: "agent_context_pack",
          arguments: {
            ...SCOPE,
            requested_sections: ["working_set", "durable_lane_context"],
            budget: { max_tokens: 900 },
          },
        });
        return JSON.parse((pack.content as any)[0].text);
      } finally {
        await cleanup();
      }
    }

    const first = await run();
    const second = await run();
    // Timestamps in durable events are fixed; the only volatile fields are the
    // working-set item ids and created/expires timestamps, so compare the
    // allocation-relevant shape.
    expect(first.sections.working_set.item_count).toBe(
      second.sections.working_set.item_count,
    );
    expect(first.sections.working_set.items.map((i: any) => i.content)).toEqual(
      second.sections.working_set.items.map((i: any) => i.content),
    );
    expect(first.budget.whole_pack).toEqual(second.budget.whole_pack);
    expect(first.warnings.truncation).toEqual(second.warnings.truncation);
    expect(Boolean(first.sections.durable_lane_context)).toBe(
      Boolean(second.sections.durable_lane_context),
    );
  });

  it("records whole-pack truncation and never emits citations for dropped events", async () => {
    const { client, cleanup } = await setupToolClient(AUTH, durablePool());
    try {
      // Working set consumes nearly the whole budget so durable events are cut.
      for (let i = 0; i < 4; i += 1) {
        await appendWorkingItem(client, `big-${i}:` + "W".repeat(3500));
      }

      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          requested_sections: ["working_set", "durable_lane_context"],
          budget: { max_tokens: 1200 },
        },
      });

      const payload = JSON.parse((pack.content as any)[0].text);
      // Every emitted event citation must correspond to an event still present
      // in the durable section — no citation for truncated evidence.
      const durable = payload.sections.durable_lane_context;
      const retainedEventCitationIds = new Set(
        (durable?.events ?? []).map((e: any) => e.citation_id),
      );
      const eventCitations = payload.citations.filter(
        (c: any) => c.kind === "session_event",
      );
      for (const citation of eventCitations) {
        expect(retainedEventCitationIds.has(citation.id)).toBe(true);
      }
      // Whole-pack truncation is declared when a section is trimmed.
      const anyWholePack = payload.warnings.truncation.some(
        (t: any) => t.reason === "whole_pack_budget",
      );
      const durableTruncated = Boolean(durable?.truncated);
      expect(anyWholePack || durableTruncated).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("under pressure preserves the newest items and drops the oldest", async () => {
    const { client, cleanup } = await setupToolClient(AUTH, {
      query: async () => ({ rows: [] }),
    });
    try {
      // Items append oldest-first: drop-0 is the oldest, drop-7 the newest.
      // The store itself trims the oldest (index 0) under pressure, so the
      // whole-pack budget must do the same: keep the newest, shed the oldest.
      for (let i = 0; i < 8; i += 1) {
        await appendWorkingItem(client, `drop-${i}:` + "W".repeat(400), {
          trace_id: `trace-${i}`,
        });
      }

      // max_tokens 900 => 2400 content chars: several ~400-char items fit, not all.
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          requested_sections: ["working_set"],
          budget: { max_tokens: 900 },
        },
      });

      const payload = JSON.parse((pack.content as any)[0].text);
      const items = payload.sections.working_set.items;
      // item_count reflects retained content, not the full store.
      expect(payload.sections.working_set.item_count).toBe(items.length);
      expect(items.length).toBeGreaterThan(0);
      expect(items.length).toBeLessThan(8);
      // Serialized section — not merely content-body chars — stays within budget.
      expect(JSON.stringify(payload.sections).length).toBeLessThanOrEqual(
        900 * 4 - 1200,
      );
      expect(contentChars(payload)).toBeLessThanOrEqual(900 * 4 - 1200);
      // The oldest item (drop-0) is shed; the newest (drop-7) is preserved.
      const contents = items.map((i: any) => i.content);
      expect(contents.some((c: string) => c.includes("drop-0"))).toBe(false);
      expect(items[items.length - 1].content).toContain("drop-7");
      // Retained items are exactly the newest contiguous suffix of the store.
      const retainedIndices = contents.map((c: string) =>
        Number(/drop-(\d+):/.exec(c)![1]),
      );
      for (let k = 1; k < retainedIndices.length; k += 1) {
        expect(retainedIndices[k]).toBe(retainedIndices[k - 1] + 1);
      }
      expect(retainedIndices[retainedIndices.length - 1]).toBe(7);
    } finally {
      await cleanup();
    }
  });

  it("omits a fully-starved working-set section whose empty envelope exceeds the budget", async () => {
    const { client, cleanup } = await setupToolClient(AUTH, {
      query: async () => ({ rows: [] }),
    });
    try {
      // A single item far larger than the whole-pack budget can hold.
      await appendWorkingItem(client, "huge:" + "W".repeat(3900));

      // max_tokens 100 => 400 - 1200 clamps to a 0-char whole-pack budget. Even
      // the empty working_set envelope (label/scope/budget/counters) serializes
      // to hundreds of chars, so it cannot be emitted without breaking the hard
      // "sections never exceed budget" contract: the section is omitted.
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          requested_sections: ["working_set"],
          budget: { max_tokens: 100 },
        },
      });

      const payload = JSON.parse((pack.content as any)[0].text);
      // The section is omitted rather than emitted with an over-budget envelope.
      expect(payload.sections.working_set).toBeUndefined();
      // The serialized sections object is exactly the irreducible empty object
      // "{}" (2 chars), and the declared limit accounts for it with no slack.
      expect(JSON.stringify(payload.sections).length).toBeLessThanOrEqual(
        payload.budget.whole_pack.content_char_limit,
      );
      // Truncation still records the fully-starved requested section so the
      // caller knows it was dropped rather than silently absent.
      const starved = payload.warnings.truncation.find(
        (t: any) =>
          t.source === "working_set" && t.reason === "whole_pack_budget",
      );
      expect(starved).toBeDefined();
      expect(starved.starved).toBe(true);
      // whole_pack accounting never claims more content used than the limit.
      expect(payload.budget.whole_pack.content_chars_used).toBeLessThanOrEqual(
        payload.budget.whole_pack.content_char_limit,
      );
    } finally {
      await cleanup();
    }
  });

  it("declares a content_char_limit that admits the irreducible empty '{}' at a zero-member budget (#326)", async () => {
    const { client, cleanup } = await setupToolClient(AUTH, {
      query: async () => ({ rows: [] }),
    });
    try {
      // A single item that cannot fit, forcing the section to be omitted so the
      // serialized sections collapse to the irreducible empty object "{}".
      await appendWorkingItem(client, "huge:" + "W".repeat(3900));

      // max_tokens 100 => 400 - 1200 clamps the member budget to 0. The serialized
      // sections object is still "{}" (2 chars), so the declared limit must admit
      // those two irreducible chars while leaving zero for section members.
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          requested_sections: ["working_set"],
          budget: { max_tokens: 100 },
        },
      });

      const payload = JSON.parse((pack.content as any)[0].text);
      expect(payload.sections.working_set).toBeUndefined();
      // The serialized sections is exactly "{}".
      const serialized = JSON.stringify(payload.sections);
      expect(serialized).toBe("{}");
      // The declared whole-pack limit bounds the serialized sections object with
      // NO slack: this fails on the old head where content_char_limit was 0 while
      // JSON.stringify(payload.sections) is 2.
      expect(serialized.length).toBeLessThanOrEqual(
        payload.budget.whole_pack.content_char_limit,
      );
      // The limit accounts for the irreducible two-char empty object.
      expect(payload.budget.whole_pack.content_char_limit).toBe(2);
      // Zero characters were available for section members at this tiny budget.
      expect(payload.budget.whole_pack.content_chars_used).toBe(0);
      // content_chars_used stays truthful and within the declared limit.
      expect(payload.budget.whole_pack.content_chars_used).toBeLessThanOrEqual(
        payload.budget.whole_pack.content_char_limit,
      );
    } finally {
      await cleanup();
    }
  });

  it("retains exact-boundary working-set content when the unbounded sections length equals the limit (#326 terminal)", async () => {
    // Terminal-audit reproduction: outer `{}` is reserved once, but the prior
    // sectionFrameCost charged a comma for EVERY admitted member — including the
    // first, which has no comma. That overcharged one char and falsely truncated
    // content sitting exactly on the boundary.
    const { client, cleanup } = await setupToolClient(AUTH, {
      query: async () => ({ rows: [] }),
    });
    try {
      // A single small working-set item sized so the UNBOUNDED serialized
      // sections length lands exactly on the budget boundary (804 chars).
      await appendWorkingItem(client, "WXY");

      // First measure the UNBOUNDED serialized sections length for this exact
      // single-item working_set section.
      const unbounded = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          requested_sections: ["working_set"],
        },
      });
      const unboundedPayload = JSON.parse((unbounded.content as any)[0].text);
      const unboundedLen = JSON.stringify(unboundedPayload.sections).length;
      // Terminal fixture: this exact single-item working_set section serializes
      // to 804 chars unbounded, which is exactly the budget for max_tokens 501
      // (501 * 4 - 1200 = 804). Anchor the fixture so the boundary is exact, not
      // approximate — the item sits precisely on the limit with no slack.
      expect(unboundedLen).toBe(804);
      expect(501 * 4 - 1200).toBe(804);

      // Now request exactly that budget. The item fits with NO slack: the outer
      // braces plus first-member framing (no comma) plus the item body equal the
      // limit precisely. The old one-comma overcharge dropped the item here.
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          requested_sections: ["working_set"],
          budget: { max_tokens: 501 },
        },
      });

      const payload = JSON.parse((pack.content as any)[0].text);
      const budget = 501 * 4 - 1200;
      // The item survives — exact-boundary content is not falsely truncated.
      expect(payload.sections.working_set).toBeDefined();
      expect(payload.sections.working_set.item_count).toBe(1);
      expect(payload.sections.working_set.items[0].content).toBe("WXY");
      // Serialized sections is identical to the unbounded shape and exactly at
      // the limit — no slack, no overshoot.
      expect(JSON.stringify(payload.sections).length).toBe(budget);
      expect(JSON.stringify(payload.sections).length).toBeLessThanOrEqual(
        budget,
      );
      // No whole-pack truncation marker: nothing was dropped.
      expect(
        payload.warnings.truncation.some(
          (t: any) => t.reason === "whole_pack_budget",
        ),
      ).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("keeps a fully-starved working-set envelope when it still fits the budget", async () => {
    const { client, cleanup } = await setupToolClient(AUTH, {
      query: async () => ({ rows: [] }),
    });
    try {
      // One item whose body cannot fit, but where the empty envelope can. The
      // envelope serializes to roughly ~450-500 chars, so a whole-pack budget
      // comfortably above that but below the item body keeps the empty shape.
      await appendWorkingItem(client, "huge:" + "W".repeat(3000));

      // max_tokens 500 => 2000 - 1200 = 800-char whole-pack budget: too small for
      // the ~3000-char item body, large enough for the empty envelope.
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          requested_sections: ["working_set"],
          budget: { max_tokens: 500 },
        },
      });

      const payload = JSON.parse((pack.content as any)[0].text);
      const budget = 500 * 4 - 1200;
      // The empty envelope is preserved because it fits the surviving budget.
      expect(payload.sections.working_set).toBeDefined();
      expect(payload.sections.working_set.items).toEqual([]);
      expect(payload.sections.working_set.item_count).toBe(0);
      expect(payload.sections.working_set.label).toBe("working_context");
      // And the serialized sections still respect the whole-pack budget.
      expect(JSON.stringify(payload.sections).length).toBeLessThanOrEqual(
        budget,
      );
      const starved = payload.warnings.truncation.find(
        (t: any) =>
          t.source === "working_set" && t.reason === "whole_pack_budget",
      );
      expect(starved).toBeDefined();
      expect(starved.starved).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("bounds the serialized durable-lane section, not just its content body", async () => {
    const { client, cleanup } = await setupToolClient(AUTH, durablePool());
    try {
      // A budget that, after content trimming, still leaves durable-lane
      // metadata + event wrappers as the dominant serialized cost.
      const maxTokens = 800;
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          requested_sections: ["durable_lane_context"],
          budget: { max_tokens: maxTokens },
        },
      });

      const payload = JSON.parse((pack.content as any)[0].text);
      const contentBudget = maxTokens * 4 - 1200;
      // The *serialized* durable-lane section (metadata, event wrappers, and
      // citation ids included) fits within the whole-pack budget — it does not
      // overshoot just because the raw content body was under the limit.
      const durable = payload.sections.durable_lane_context;
      if (durable) {
        expect(JSON.stringify(durable).length).toBeLessThanOrEqual(
          contentBudget,
        );
      }
      // And the whole serialized sections object stays within budget too.
      expect(JSON.stringify(payload.sections).length).toBeLessThanOrEqual(
        contentBudget,
      );
      // Every emitted event citation still corresponds to a retained event.
      const retained = new Set(
        (durable?.events ?? []).map((e: any) => e.citation_id),
      );
      for (const citation of payload.citations.filter(
        (c: any) => c.kind === "session_event",
      )) {
        expect(retained.has(citation.id)).toBe(true);
      }
      // Reconciled content_chars_used matches the retained content body.
      if (durable) {
        expect(payload.budget.durable_lane_context.content_chars_used).toBe(
          contentChars(payload),
        );
      }
    } finally {
      await cleanup();
    }
  });

  it("drops the oldest durable-lane events first under whole-pack pressure", async () => {
    const { client, cleanup } = await setupToolClient(AUTH, durablePool());
    try {
      // Consume most of the budget with working-set items so only a couple of
      // durable events can survive. Events are chronological ascending, so
      // event-7 is newest and event-0 oldest.
      for (let i = 0; i < 2; i += 1) {
        await appendWorkingItem(client, `ws-${i}:` + "W".repeat(1000));
      }
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          requested_sections: ["working_set", "durable_lane_context"],
          budget: { max_tokens: 900 },
        },
      });

      const payload = JSON.parse((pack.content as any)[0].text);
      const durable = payload.sections.durable_lane_context;
      if (durable && durable.events.length > 0) {
        const ids = durable.events.map((e: any) => e.id);
        // Retained events are the newest suffix: the last retained id is the
        // newest available event, and the oldest (event-0) is not retained
        // unless all events fit.
        expect(ids[ids.length - 1]).toBe("event-7");
        if (ids.length < 8) {
          expect(ids).not.toContain("event-0");
        }
        expect(durable.event_count).toBe(durable.events.length);
      }
      expect(JSON.stringify(payload.sections).length).toBeLessThanOrEqual(
        900 * 4 - 1200,
      );
    } finally {
      await cleanup();
    }
  });

  it("omits the durable-lane section entirely when even its empty envelope exceeds the surviving budget", async () => {
    const { client, cleanup } = await setupToolClient(AUTH, durablePool());
    try {
      // A small working-set item is retained (highest priority), consuming enough
      // budget that the durable-lane section — whose empty lane-metadata envelope
      // is still ~400 chars — cannot fit the sliver that survives.
      await appendWorkingItem(client, "a:" + "W".repeat(100));

      // max_tokens 550 => 1000-char whole-pack budget: the ~900-char retained
      // working-set section leaves under ~100 chars, too little for the durable
      // envelope, which is dropped rather than emitted over budget.
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          requested_sections: ["working_set", "durable_lane_context"],
          budget: { max_tokens: 550 },
        },
      });

      const payload = JSON.parse((pack.content as any)[0].text);
      const budget = 550 * 4 - 1200;
      // Highest-priority working_set is retained whole.
      expect(payload.sections.working_set).toBeDefined();
      expect(payload.sections.working_set.item_count).toBe(1);
      // Durable-lane section is omitted rather than emitted over budget.
      expect(payload.sections.durable_lane_context).toBeUndefined();
      // The whole serialized sections object stays within the whole-pack budget.
      expect(JSON.stringify(payload.sections).length).toBeLessThanOrEqual(
        budget,
      );
      // No dangling citations reference the dropped section — neither the lane
      // citation nor any event citation survives.
      expect(
        payload.citations.filter((c: any) => c.kind === "session_lane"),
      ).toEqual([]);
      expect(
        payload.citations.filter((c: any) => c.kind === "session_event"),
      ).toEqual([]);
      // The reconciled durable budget reports zero content emitted, not the
      // loader's pre-refit selection.
      expect(payload.budget.durable_lane_context.content_chars_used).toBe(0);
      // A starved truncation marker signals the requested section was dropped.
      const starved = payload.warnings.truncation.find(
        (t: any) =>
          t.source === "durable_lane_context" &&
          t.reason === "whole_pack_budget",
      );
      expect(starved).toBeDefined();
      expect(starved.starved).toBe(true);
      // The loader's own per-section truncation markers are suppressed for the
      // dropped section (no orphan durable_lane_context.* markers).
      const orphanLoaderMarkers = payload.warnings.truncation.filter(
        (t: any) =>
          typeof t.source === "string" &&
          t.source.startsWith("durable_lane_context."),
      );
      expect(orphanLoaderMarkers).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("still honors max_latency_ms degradation under a whole-pack budget", async () => {
    const { client, cleanup } = await setupToolClient(AUTH, {
      query: async () => {
        throw new Error("budgeted reads must use a checked-out client");
      },
      connect: () => new Promise(() => undefined),
    });
    try {
      const startedAt = performance.now();
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          requested_sections: ["durable_lane_context"],
          budget: { max_tokens: 800, max_latency_ms: 25 },
        },
      });
      const elapsedMs = performance.now() - startedAt;

      expect(pack.isError).toBeFalsy();
      const payload = JSON.parse((pack.content as any)[0].text);
      expect(payload.sections.durable_lane_context).toBeUndefined();
      expect(payload.warnings.degraded_sources).toEqual([
        { source: "durable_lane_context", reason: "database_unavailable" },
      ]);
      expect(elapsedMs).toBeLessThan(250);
      // Envelope still advertises the whole-pack budget even when the section
      // degraded.
      expect(payload.budget.whole_pack.content_char_limit).toBe(800 * 4 - 1200);
    } finally {
      await cleanup();
    }
  });

  it("denies exact-scope durable lane under a whole-pack budget without querying events", async () => {
    const queries: string[] = [];
    const { client, cleanup } = await setupToolClient(AUTH, {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      },
    });
    try {
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          channel_id: "wrong-channel",
          requested_sections: ["durable_lane_context"],
          budget: { max_tokens: 1000 },
        },
      });

      const payload = JSON.parse((pack.content as any)[0].text);
      expect(payload.sections.durable_lane_context).toBeUndefined();
      expect(payload.warnings.scope_denials).toContainEqual({
        source: "durable_lane_context",
        reasons: ["exact_scope"],
      });
      expect(payload.citations).toEqual([]);
      expect(queries).toHaveLength(1);
      expect(queries[0]).not.toContain("ob_session_events");
    } finally {
      await cleanup();
    }
  });

  it("preserves per-section behavior and omits whole-pack budget when no budget is set", async () => {
    const { client, cleanup } = await setupToolClient(AUTH, durablePool());
    try {
      await appendWorkingItem(client, "compat:" + "W".repeat(3000));

      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          requested_sections: ["working_set", "durable_lane_context"],
        },
      });

      const payload = JSON.parse((pack.content as any)[0].text);
      // No whole-pack budget entry when max_tokens is absent.
      expect(payload.budget.whole_pack).toBeUndefined();
      expect(payload.budget.requested).toBeNull();
      // Working set retains its full item.
      expect(payload.sections.working_set.item_count).toBe(1);
      // Durable lane uses its historical per-section 12000-char default.
      expect(payload.budget.durable_lane_context.content_char_limit).toBe(
        12000,
      );
      // No whole-pack truncation markers when unbounded.
      expect(
        payload.warnings.truncation.every(
          (t: any) => t.reason !== "whole_pack_budget",
        ),
      ).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

describe("agent_context_pack whole-pack budget: recovery section", () => {
  it("trims the recovery section to the newest items and reconciles both item_count and pending_count", async () => {
    const { client, cleanup } = await setupToolClient(AUTH, {
      query: async () => ({ rows: [] }),
    });
    try {
      // Recovery items append oldest-first: rec-0 is oldest, rec-5 newest. The
      // WAL store itself trims the oldest (splice(0, …)) under budget pressure,
      // so the whole-pack re-fit must match that recency ordering — drop the
      // oldest, keep the newest suffix.
      for (let i = 0; i < 6; i += 1) {
        await appendRecoveryItem(client, `rec-${i}:` + "R".repeat(400), {
          trace_id: `rw-trace-${i}`,
        });
      }

      // max_tokens 950 => 2600-char whole-pack budget: several ~740-char
      // serialized recovery items fit, not all six.
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          include_unreviewed_recovery: true,
          requested_sections: ["recovery"],
          budget: { max_tokens: 950 },
        },
      });

      const payload = JSON.parse((pack.content as any)[0].text);
      const recovery = payload.sections.recovery;
      const contentBudget = 950 * 4 - 1200;
      expect(recovery).toBeDefined();
      // A real trim happened: some but not all items survived.
      expect(recovery.items.length).toBeGreaterThan(0);
      expect(recovery.items.length).toBeLessThan(6);
      // BOTH counters are reconciled to the retained items, not left at the
      // full store count. fitItemSection is called with both count keys, so a
      // regression that reconciled only item_count would leave pending_count
      // overstated here.
      expect(recovery.item_count).toBe(recovery.items.length);
      expect(recovery.pending_count).toBe(recovery.items.length);
      // Serialized section — not merely content-body chars — stays within the
      // whole-pack budget.
      expect(JSON.stringify(payload.sections).length).toBeLessThanOrEqual(
        contentBudget,
      );
      expect(contentChars(payload)).toBeLessThanOrEqual(contentBudget);
      // The oldest (rec-0) is shed; the newest (rec-5) is preserved at the tail.
      const previews = recovery.items.map((i: any) => i.content_preview);
      expect(previews.some((c: string) => c.startsWith("rec-0:"))).toBe(false);
      expect(
        recovery.items[recovery.items.length - 1].content_preview,
      ).toContain("rec-5");
      // Retained items are exactly the newest contiguous suffix of the store.
      const retainedIndices = previews.map((c: string) =>
        Number(/rec-(\d+):/.exec(c)![1]),
      );
      for (let k = 1; k < retainedIndices.length; k += 1) {
        expect(retainedIndices[k]).toBe(retainedIndices[k - 1] + 1);
      }
      expect(retainedIndices[retainedIndices.length - 1]).toBe(5);
      // A whole-pack truncation marker names the trimmed recovery section.
      const marker = payload.warnings.truncation.find(
        (t: any) => t.source === "recovery" && t.reason === "whole_pack_budget",
      );
      expect(marker).toBeDefined();
      // whole_pack accounting never claims more content used than the limit.
      expect(payload.budget.whole_pack.content_chars_used).toBeLessThanOrEqual(
        payload.budget.whole_pack.content_char_limit,
      );
    } finally {
      await cleanup();
    }
  });

  it("keeps a fully-starved recovery envelope with both counts zeroed when the envelope still fits", async () => {
    const { client, cleanup } = await setupToolClient(AUTH, {
      query: async () => ({ rows: [] }),
    });
    try {
      // One recovery item whose serialized body cannot fit, but where the empty
      // recovery envelope (~706 chars for this scope) can.
      await appendRecoveryItem(client, "solo:" + "R".repeat(400));

      // max_tokens 480 => 720-char whole-pack budget: too small for the ~740-char
      // serialized item, large enough for the empty envelope.
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          include_unreviewed_recovery: true,
          requested_sections: ["recovery"],
          budget: { max_tokens: 480 },
        },
      });

      const payload = JSON.parse((pack.content as any)[0].text);
      const contentBudget = 480 * 4 - 1200;
      const recovery = payload.sections.recovery;
      // The empty envelope is preserved because it fits the surviving budget.
      expect(recovery).toBeDefined();
      expect(recovery.items).toEqual([]);
      // Both counters are reconciled to zero when the section is starved empty.
      expect(recovery.item_count).toBe(0);
      expect(recovery.pending_count).toBe(0);
      expect(recovery.label).toBe("quarantined_recovery");
      // The serialized sections still respect the whole-pack budget.
      expect(JSON.stringify(payload.sections).length).toBeLessThanOrEqual(
        contentBudget,
      );
      const starved = payload.warnings.truncation.find(
        (t: any) => t.source === "recovery" && t.reason === "whole_pack_budget",
      );
      expect(starved).toBeDefined();
      expect(starved.starved).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("omits a fully-starved recovery section whose empty envelope exceeds the budget, still recording the starved marker", async () => {
    const { client, cleanup } = await setupToolClient(AUTH, {
      query: async () => ({ rows: [] }),
    });
    try {
      await appendRecoveryItem(client, "solo:" + "R".repeat(400));

      // max_tokens 450 => 600-char whole-pack budget: below even the empty
      // recovery envelope (~693 chars), so the section is omitted rather than
      // emitted over budget.
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          include_unreviewed_recovery: true,
          requested_sections: ["recovery"],
          budget: { max_tokens: 450 },
        },
      });

      const payload = JSON.parse((pack.content as any)[0].text);
      // The section is omitted rather than emitted with an over-budget envelope.
      expect(payload.sections.recovery).toBeUndefined();
      // The serialized sections object is exactly the irreducible empty object
      // "{}" (2 chars), and the declared limit accounts for it with no slack.
      expect(JSON.stringify(payload.sections).length).toBeLessThanOrEqual(
        payload.budget.whole_pack.content_char_limit,
      );
      // Truncation still records the fully-starved requested section so the
      // caller knows it was dropped rather than silently absent.
      const starved = payload.warnings.truncation.find(
        (t: any) => t.source === "recovery" && t.reason === "whole_pack_budget",
      );
      expect(starved).toBeDefined();
      expect(starved.starved).toBe(true);
      // whole_pack accounting never claims more content used than the limit.
      expect(payload.budget.whole_pack.content_chars_used).toBeLessThanOrEqual(
        payload.budget.whole_pack.content_char_limit,
      );
    } finally {
      await cleanup();
    }
  });

  it("preserves higher-priority working_set whole while trimming recovery under one shared budget", async () => {
    const { client, cleanup } = await setupToolClient(AUTH, {
      query: async () => ({ rows: [] }),
    });
    try {
      // working_set is higher priority than recovery in the allocation order, so
      // the modest working-set item survives whole while recovery absorbs the
      // remaining pressure.
      await appendWorkingItem(client, "keep-ws:" + "W".repeat(400), {
        trace_id: "ws-keep",
      });
      for (let i = 0; i < 4; i += 1) {
        await appendRecoveryItem(client, `rec-${i}:` + "R".repeat(400));
      }

      // max_tokens 950 => 2600-char budget: the ~900-char working-set section
      // survives whole, and recovery is starved to its empty envelope in the
      // sliver that remains.
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          include_unreviewed_recovery: true,
          requested_sections: ["working_set", "recovery"],
          budget: { max_tokens: 950 },
        },
      });

      const payload = JSON.parse((pack.content as any)[0].text);
      const contentBudget = 950 * 4 - 1200;
      // Highest-priority working_set survives whole.
      expect(payload.sections.working_set.item_count).toBe(1);
      expect(payload.sections.working_set.items[0].content).toContain(
        "keep-ws",
      );
      // Recovery is present but starved to zero content by the leftover budget,
      // with both counters reconciled.
      const recovery = payload.sections.recovery;
      if (recovery) {
        expect(recovery.item_count).toBe(recovery.items.length);
        expect(recovery.pending_count).toBe(recovery.items.length);
      }
      // The whole serialized sections object stays within the shared budget.
      expect(JSON.stringify(payload.sections).length).toBeLessThanOrEqual(
        contentBudget,
      );
      // Recovery is the trimmed/starved source, not working_set.
      const recoveryMarker = payload.warnings.truncation.find(
        (t: any) => t.source === "recovery" && t.reason === "whole_pack_budget",
      );
      expect(recoveryMarker).toBeDefined();
      const workingSetMarker = payload.warnings.truncation.find(
        (t: any) =>
          t.source === "working_set" && t.reason === "whole_pack_budget",
      );
      expect(workingSetMarker).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});

describe("agent_context_pack whole-pack budget: first-member framing (#326 terminal)", () => {
  // Measure the unbounded serialized `sections` length, then set max_tokens so
  // the whole-pack budget equals it exactly, and assert the content survives at
  // the boundary. The first admitted member frames as `"key":<body>` with no
  // comma, so a section on the exact limit must NOT be falsely truncated. This
  // exercises the same defect for recovery-first and durable-lane-first as the
  // working_set reproduction does, including the combination where an earlier
  // requested section is omitted and a later one becomes the first member.
  // Grow `content` by trailing padding until the recovery-only section's
  // unbounded serialized length lands exactly on a reachable budget boundary
  // (budget = max_tokens * 4 - 1200 can only hit multiples of 4). Returns the
  // padded content, that exact length, and the integer max_tokens that makes the
  // whole-pack budget equal it. This yields a genuine exact-boundary fixture for
  // any section without hardcoding envelope internals.
  async function recoveryExactBoundaryFixture(client: any) {
    for (let pad = 0; pad < 8; pad += 1) {
      const content = "REC" + "r".repeat(pad);
      // Fresh client per probe so the store holds exactly one item.
      const probe = await setupToolClient(AUTH, {
        query: async () => ({ rows: [] }),
      });
      try {
        await appendRecoveryItem(probe.client, content);
        const unbounded = await probe.client.callTool({
          name: "agent_context_pack",
          arguments: {
            ...SCOPE,
            include_unreviewed_recovery: true,
            requested_sections: ["recovery"],
          },
        });
        const payload = JSON.parse((unbounded.content as any)[0].text);
        const len = JSON.stringify(payload.sections).length;
        if ((len + 1200) % 4 === 0) {
          return { content, len, tokens: (len + 1200) / 4 };
        }
      } finally {
        await probe.cleanup();
      }
    }
    throw new Error("no exact-boundary recovery fixture found within padding");
  }

  it("frames recovery as the first admitted member at the exact boundary when working_set is absent", async () => {
    // Derive an exact-boundary recovery-only fixture, then assert the item
    // survives at that boundary. recovery is the only requested section, so it
    // is the first (comma-free) member; the old +1 comma overcharge dropped it.
    const fixtureClient = await setupToolClient(AUTH, {
      query: async () => ({ rows: [] }),
    });
    let fixture: { content: string; len: number; tokens: number };
    try {
      fixture = await recoveryExactBoundaryFixture(fixtureClient.client);
    } finally {
      await fixtureClient.cleanup();
    }

    const { client, cleanup } = await setupToolClient(AUTH, {
      query: async () => ({ rows: [] }),
    });
    try {
      await appendRecoveryItem(client, fixture.content);
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          include_unreviewed_recovery: true,
          requested_sections: ["recovery"],
          budget: { max_tokens: fixture.tokens },
        },
      });
      const payload = JSON.parse((pack.content as any)[0].text);
      // Recovery item survives at the exact boundary — no false truncation.
      expect(payload.sections.recovery).toBeDefined();
      expect(payload.sections.recovery.item_count).toBe(1);
      expect(payload.sections.recovery.items[0].content_preview).toContain(
        fixture.content,
      );
      // Serialized sections equals the unbounded length and exactly the budget.
      expect(JSON.stringify(payload.sections).length).toBe(fixture.len);
      expect(JSON.stringify(payload.sections).length).toBe(
        fixture.tokens * 4 - 1200,
      );
      expect(
        payload.warnings.truncation.some(
          (t: any) => t.reason === "whole_pack_budget",
        ),
      ).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("frames a starved first member comma-free and charges the second member exactly one comma at the boundary", async () => {
    // Combination case: working_set is requested with a body far too large to
    // retain, so it collapses to its empty envelope and is admitted as the
    // FIRST member (comma-free). recovery is admitted as the SECOND member and
    // MUST be charged exactly one leading comma. Land the two-member sections
    // object on an exact reachable budget and assert both survive with no slack:
    // the old code overcharged the first member's comma, and any regression that
    // dropped or mischarged the second member's comma would break the boundary.
    async function twoMemberBoundaryFixture() {
      for (let pad = 0; pad < 8; pad += 1) {
        const recContent = "REC" + "r".repeat(pad);
        const probe = await setupToolClient(AUTH, {
          query: async () => ({ rows: [] }),
        });
        try {
          await appendWorkingItem(probe.client, "hugews:" + "W".repeat(4000));
          await appendRecoveryItem(probe.client, recContent);
          // A budget comfortably above the two-member shape so nothing trims;
          // we only need the untrimmed two-member serialized length.
          const r = await probe.client.callTool({
            name: "agent_context_pack",
            arguments: {
              ...SCOPE,
              include_unreviewed_recovery: true,
              requested_sections: ["working_set", "recovery"],
              budget: { max_tokens: 5000 },
            },
          });
          const p = JSON.parse((r.content as any)[0].text);
          // Require the untrimmed shape: WS empty first member + recovery item.
          if (
            p.sections.working_set &&
            p.sections.working_set.items.length === 0 &&
            p.sections.recovery &&
            p.sections.recovery.items.length === 1
          ) {
            const len = JSON.stringify(p.sections).length;
            if ((len + 1200) % 4 === 0) {
              return { recContent, len, tokens: (len + 1200) / 4 };
            }
          }
        } finally {
          await probe.cleanup();
        }
      }
      throw new Error("no exact-boundary two-member fixture found");
    }

    const fixture = await twoMemberBoundaryFixture();

    const { client, cleanup } = await setupToolClient(AUTH, {
      query: async () => ({ rows: [] }),
    });
    try {
      await appendWorkingItem(client, "hugews:" + "W".repeat(4000));
      await appendRecoveryItem(client, fixture.recContent);

      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          include_unreviewed_recovery: true,
          requested_sections: ["working_set", "recovery"],
          budget: { max_tokens: fixture.tokens },
        },
      });
      const payload = JSON.parse((pack.content as any)[0].text);
      // working_set is the empty first member (comma-free); recovery is the
      // second member (one comma) and its item survives at the exact boundary.
      expect(payload.sections.working_set).toBeDefined();
      expect(payload.sections.working_set.items).toEqual([]);
      expect(payload.sections.recovery).toBeDefined();
      expect(payload.sections.recovery.item_count).toBe(1);
      expect(payload.sections.recovery.items[0].content_preview).toContain(
        fixture.recContent,
      );
      // Serialized two-member sections equals the fixture length and exactly the
      // budget — first member comma-free, second member one comma, no slack.
      expect(JSON.stringify(payload.sections).length).toBe(fixture.len);
      expect(JSON.stringify(payload.sections).length).toBe(
        fixture.tokens * 4 - 1200,
      );
    } finally {
      await cleanup();
    }
  });
});
