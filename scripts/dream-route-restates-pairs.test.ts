import { describe, expect, it } from "vitest";
import {
  agreement,
  parseSheet,
  renderSheet,
  scoreSheet,
} from "./dream-route-restates-pairs.ts";
import {
  candidateOf,
  fakeJevFetch,
  neighbourPairs,
} from "../server/domain/dream-route/run-core.ts";
import type { JevFetch } from "../server/integrations/jev.ts";
import type { FrozenRow } from "../server/domain/dream-route/types.ts";

function row(input: {
  id: string;
  neighbourOf: string | null;
  content: string;
  operatorText?: string | null;
}): FrozenRow {
  return {
    ordinal: 0,
    candidateId: input.id,
    namespace: "rico",
    contentHash: "f".repeat(64),
    source: input.neighbourOf === null ? "draw" : "neighbour",
    neighbourOf: input.neighbourOf,
    snapshot: {
      id: input.id,
      namespace: "rico",
      candidate_type: "fact",
      content: input.content,
      content_hash: "f".repeat(64),
      operator_text: input.operatorText ?? null,
      unit_kind: "exchange",
      anchor_kind: "typed",
      first_said_at: null,
      last_said_at: null,
      source_turn_ids: [],
    },
  };
}

const ROWS: FrozenRow[] = [
  row({ id: "A", neighbourOf: null, content: "run the isolated suite always" }),
  row({
    id: "B",
    neighbourOf: "A",
    content: "line one\n\nline three",
    operatorText: "use it",
  }),
  row({ id: "C", neighbourOf: "A", content: "run the isolated suite always please" }),
];

function pairs() {
  return neighbourPairs(ROWS).map(({ item, member }) => ({
    item: candidateOf(item),
    member: candidateOf(member),
  }));
}

describe("renderSheet", () => {
  const text = renderSheet({ source: "rows fixture.json", pairs: pairs() });

  it("writes one section per pair with ids and an open label", () => {
    expect(text.match(/^## Pair /gm)).toHaveLength(2);
    expect(text).toContain("Source: rows fixture.json. Pairs: 2.");
    expect(text).toContain("## Pair 1\n\n- item: B\n- member: A");
    expect(text).toContain("## Pair 2\n\n- item: C\n- member: A");
    expect(text.match(/^label: \?$/gm)).toHaveLength(2);
  });

  it("quotes content line by line and marks a missing operator text", () => {
    expect(text).toContain("Item content:\n> line one\n>\n> line three\n");
    expect(text).toContain("Item, operator said:\n> use it\n");
    expect(text).toContain("Member, operator said:\n> not recorded\n");
  });

  it("ends in exactly one newline", () => {
    expect(text.endsWith("label: ?\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });
});

describe("parseSheet", () => {
  const text = renderSheet({ source: "x", pairs: pairs() });

  it("round-trips ids with undecided labels", () => {
    expect(parseSheet(text)).toEqual([
      { itemId: "B", memberId: "A", label: null },
      { itemId: "C", memberId: "A", label: null },
    ]);
  });

  it("reads yes and no", () => {
    const labelled = text
      .replace("label: ?", "label: yes")
      .replace("label: ?", "label: no");
    expect(parseSheet(labelled).map((entry) => entry.label)).toEqual([true, false]);
  });

  it("throws naming the pair on an unknown label", () => {
    const bad = text.replace(/label: \?\n$/, "label: maybe\n");
    expect(() => parseSheet(bad)).toThrow(/pair 2/);
  });
});

describe("agreement", () => {
  it("counts the confusion cells and unscored items", () => {
    const scores = new Map([
      ["tp", 0.9],
      ["fp", 0.8],
      ["fn", 0.1],
      ["tn", 0.2],
    ]);
    const got = agreement({
      labelled: [
        { itemId: "tp", label: true },
        { itemId: "fp", label: false },
        { itemId: "fn", label: true },
        { itemId: "tn", label: false },
        { itemId: "none", label: true },
      ],
      scores,
      cutoff: 0.7,
    });
    expect(got).toEqual({
      labelled: 5,
      agree: 2,
      tp: 1,
      fp: 1,
      fn: 2,
      tn: 1,
      unscored: 1,
    });
  });
});

describe("scoreSheet", () => {
  it("scores labelled pairs on the fake backend", async () => {
    const text = renderSheet({ source: "x", pairs: pairs() }).replace(
      "label: ?",
      "label: yes",
    );
    const lines = await scoreSheet({ text, rows: ROWS });
    expect(lines[0]).toBe("backend fake (counts shared words; judges nothing)");
    expect(lines[2]).toBe("labelled 1 undecided 1");
    expect(lines[3]).toMatch(/^agree [01]\/1$/);
    expect(lines[4]).toMatch(/unscored 0$/);
  });

  it("throws naming an id missing from the rows", async () => {
    const text = renderSheet({ source: "x", pairs: pairs() }).replace(
      "label: ?",
      "label: no",
    );
    await expect(scoreSheet({ text, rows: ROWS.slice(1) })).rejects.toThrow(
      /sheet id A/,
    );
  });

  it("jev branch uses the injected fetch and announces the paid call", async () => {
    const text = renderSheet({ source: "x", pairs: pairs() }).replace(
      "label: ?",
      "label: yes",
    );
    const inner = fakeJevFetch();
    let calls = 0;
    const counting: JevFetch = (url, init) => {
      calls += 1;
      return inner(url, init);
    };
    const logged: string[] = [];
    const lines = await scoreSheet({
      text,
      rows: ROWS,
      backend: "jev",
      env: { OPENBRAIN_JEV_API_KEY: "test-not-a-key" },
      fetchFn: counting,
      log: (line) => logged.push(line),
    });
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(logged).toEqual(["paid: 1 pairs, backend jev"]);
    expect(lines[0]).toBe("backend jev");
    expect(lines[3]).toMatch(/^agree [01]\/1$/);
  });

  it("jev without a key fails through backendFor before any fetch", async () => {
    const text = renderSheet({ source: "x", pairs: pairs() }).replace(
      "label: ?",
      "label: yes",
    );
    let calls = 0;
    const counting: JevFetch = () => {
      calls += 1;
      throw new Error("must not be called");
    };
    await expect(
      scoreSheet({ text, rows: ROWS, backend: "jev", env: {}, fetchFn: counting }),
    ).rejects.toThrow(/OPENBRAIN_JEV_API_KEY is unset/);
    expect(calls).toBe(0);
  });

  it("sweep adds one line per cutoff from 0.50 to 0.95", async () => {
    const text = renderSheet({ source: "x", pairs: pairs() }).replace(
      "label: ?",
      "label: yes",
    );
    const lines = await scoreSheet({ text, rows: ROWS, sweep: true });
    const sweep = lines.slice(5);
    expect(sweep).toHaveLength(10);
    expect(sweep[0]).toMatch(/^sweep 0\.50 agree [01]\/1 tp \d fp \d fn \d tn \d$/);
    expect(sweep[9]).toMatch(/^sweep 0\.95 /);
  });
});
