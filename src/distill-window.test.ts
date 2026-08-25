/**
 * Functional tests for DISTILL windowing (#382).
 *
 * WHAT THESE ARE FOR. The windowing decides two things that nothing downstream
 * can repair: which turn a candidate is attributed to, and what the extractor
 * was allowed to read while producing it. Both failures are invisible at
 * runtime -- a candidate attributed to the wrong turn still looks like a
 * candidate, and an extractor that read the whole batch still returns text.
 *
 * ORDERING IS THE OTHER HALF. src/distill-window.ts:25-40 records that
 * `turn_index` is per-hook-batch (every session carries only 0..7) and that
 * `parent_turn_uuid` dangles on 24% of rows, so neither can order anything.
 * These tests assert the SQL never mentions either, because a regression there
 * would reorder the corpus silently and the candidates would still look fine.
 *
 * Input/output at the public boundary, per _DOCS/STANDARDS-testing.md. The pg
 * fake exists to feed `claimDistillBatch` rows and to capture the one statement
 * it issues; nothing asserts on SQL shape except the two ordering-key
 * prohibitions, which have no observable behaviour to assert on instead.
 */

import { describe, expect, it } from "bun:test";
import type pg from "pg";
import {
  buildUnits,
  claimDistillBatch,
  DEFAULT_CONTEXT_WINDOW,
  DISTILL_ORDER_BY,
  isSpeech,
  type DistillTurn,
} from "./distill-window.ts";
import { NON_SPEECH_ROLES } from "./dream-light.ts";

let idCounter = 0;
function turn(over: Partial<DistillTurn> = {}): DistillTurn {
  idCounter++;
  const n = String(idCounter).padStart(12, "0");
  return {
    id: `11111111-1111-4111-8111-${n}`,
    namespace: "rico",
    session_ref: "s1",
    session_seq: idCounter,
    role: "user",
    content: "content",
    repo: "open-brain",
    occurred_at: new Date(Date.UTC(2026, 6, 28, 0, idCounter)),
    is_human_prompt: true,
    ...over,
  };
}

describe("isSpeech", () => {
  it("treats user and assistant as speech and machine output as evidence", () => {
    expect(isSpeech("user")).toBe(true);
    expect(isSpeech("assistant")).toBe(true);
    // Tool output is the grounding a factual assistant turn rests on
    // (distill-window.ts:84-94), so it is context but never a source.
    expect(isSpeech("tool")).toBe(false);
    expect(isSpeech("system")).toBe(false);
  });

  it("counts an unrecognised role as speech rather than dropping it", () => {
    // REGRESSION. This was an allowlist ({user, assistant}), which inverted
    // Light's documented failure direction (dream-light.ts:126-142): a role no
    // one had heard of yielded no candidate at all, silently and permanently.
    // The denylist over-extracts instead, which the operator queue corrects.
    expect(isSpeech("hermes")).toBe(true);
    expect(isSpeech("operator")).toBe(true);
    expect(isSpeech("")).toBe(true);
  });

  it("shares one role set with Light so the two stages cannot drift", () => {
    // The bug was two private lists disagreeing in DIRECTION, so the fix that
    // matters is the shared set, not the current membership.
    for (const role of NON_SPEECH_ROLES) expect(isSpeech(role)).toBe(false);
  });
});

describe("buildUnits — a new runtime's role still produces candidates", () => {
  it("makes an unknown-role turn a CURRENT unit with tool output as context", () => {
    const turns = [
      turn({ role: "user", content: "design the thing" }),
      turn({ role: "tool", content: "(Bash completed with no output)" }),
      turn({ role: "hermes", content: "a NEW runtime said this" }),
    ];
    const units = buildUnits(turns);

    const roles = units.map((u) => u.current.role);
    expect(roles).toContain("hermes");
    // Still not a source: the tool turn is grounding, not a claim.
    expect(roles).not.toContain("tool");

    const unknown = units.find((u) => u.current.role === "hermes")!;
    expect(unknown.context.map((c) => c.role)).toEqual(["user", "tool"]);
  });
});

describe("buildUnits — one CURRENT turn, N read-only predecessors", () => {
  it("gives a unit exactly the previous 3 turns as context by default", () => {
    // graphiti's last_n=3 (extract_nodes_and_edges.py:8), adopted not invented.
    const turns = [
      turn({ content: "t0" }),
      turn({ content: "t1" }),
      turn({ content: "t2" }),
      turn({ content: "t3" }),
      turn({ content: "t4" }),
    ];
    const units = buildUnits(turns);
    expect(DEFAULT_CONTEXT_WINDOW).toBe(3);

    const last = units.at(-1)!;
    expect(last.current.content).toBe("t4");
    expect(last.context).toHaveLength(3);
    // Oldest first, so a prompt reads chronologically.
    expect(last.context.map((t) => t.content)).toEqual(["t1", "t2", "t3"]);
  });

  it("never puts the current turn in its own context", () => {
    const turns = [turn({ content: "a" }), turn({ content: "b" })];
    for (const unit of buildUnits(turns)) {
      expect(unit.context.map((t) => t.id)).not.toContain(unit.current.id);
    }
  });

  it("gives the first turn of a session no context rather than borrowing", () => {
    const units = buildUnits([turn({ content: "first" })]);
    expect(units[0]!.context).toEqual([]);
  });

  it("refuses to cross a session boundary", () => {
    // Two sessions are two conversations. Letting one supply context for the
    // other fabricates a relationship the corpus does not contain
    // (distill-window.ts:107-110).
    const turns = [
      turn({ session_ref: "sA", content: "A-1" }),
      turn({ session_ref: "sA", content: "A-2" }),
      turn({ session_ref: "sB", content: "B-1" }),
      turn({ session_ref: "sB", content: "B-2" }),
    ];
    const units = buildUnits(turns);
    const bUnits = units.filter((u) => u.current.session_ref === "sB");
    for (const unit of bUnits) {
      for (const ctx of unit.context) {
        expect(ctx.session_ref).toBe("sB");
      }
    }
    expect(bUnits[0]!.context).toEqual([]);
  });

  it("keeps non-speech turns as CONTEXT but never makes them a unit", () => {
    // The measured case: an assistant's "2370 pass, 0 fail" is only checkable
    // because the tool turn before it carried the test output.
    const turns = [
      turn({ role: "user", content: "run the suite" }),
      turn({ role: "tool", content: "2370 pass, 0 fail" }),
      turn({ role: "assistant", content: "2370 pass, 0 fail." }),
    ];
    const units = buildUnits(turns);
    expect(units.map((u) => u.current.role)).toEqual(["user", "assistant"]);
    const assistantUnit = units[1]!;
    expect(assistantUnit.context.map((t) => t.role)).toEqual(["user", "tool"]);
  });

  it("a short turn keeps its meaning because the proposal is in its context", () => {
    // THE CENTRAL CASE. "go" is 2 characters and authorizes a specific thing;
    // the only place that thing exists is the preceding turn.
    const turns = [
      turn({
        role: "assistant",
        content: "I can switch both hooks to the new host.",
      }),
      turn({ role: "user", content: "go" }),
    ];
    const unit = buildUnits(turns).find((u) => u.current.content === "go")!;
    expect(unit.context.map((t) => t.content)).toEqual([
      "I can switch both hooks to the new host.",
    ]);
  });

  it("clamps a negative or fractional window to a sane integer", () => {
    const turns = [turn(), turn(), turn()];
    expect(buildUnits(turns, -5).at(-1)!.context).toEqual([]);
    expect(buildUnits(turns, 1.9).at(-1)!.context).toHaveLength(1);
  });

  it("returns nothing for an empty corpus rather than throwing", () => {
    expect(buildUnits([])).toEqual([]);
  });
});

describe("claimDistillBatch — ordering key and stamping", () => {
  interface Recorded {
    text: string;
    values: unknown[];
  }

  function fakeDb(rows: Record<string, unknown>[]) {
    const seen: Recorded[] = [];
    const query = (async (text: string, values: unknown[] = []) => {
      seen.push({ text, values });
      return { rows, rowCount: rows.length };
    }) as unknown as pg.Pool["query"];
    return { seen, query };
  }

  function row(over: Record<string, unknown> = {}) {
    const t = turn();
    return { ...t, is_due: true, ...over };
  }

  it("orders by (session_ref, occurred_at, id) and never by turn_index", async () => {
    // turn_index is per-hook-batch: every session carries only 0..7
    // (036_raw_turns_session_seq.sql:5-16). Ordering on it silently shuffles
    // the corpus and every candidate still looks well-formed.
    expect(DISTILL_ORDER_BY).toBe(
      "session_ref NULLS LAST, occurred_at NULLS LAST, id",
    );
    const db = fakeDb([row()]);
    await claimDistillBatch(db);
    const sql = db.seen[0]!.text;
    expect(sql).toContain(DISTILL_ORDER_BY);
    expect(sql).not.toContain("turn_index");
    // parent_turn_uuid dangles on 24% of rows (036:41-44), so it cannot order
    // or thread anything either.
    expect(sql).not.toContain("parent_turn_uuid");
  });

  it("stamps EVERY due turn, including the non-speech ones that produced no unit", async () => {
    // Without this the ~1,360 tool turns are re-selected forever and the sweep
    // never terminates (distill-window.ts:148-152).
    const speech = row({ role: "user", content: "switch both" });
    const tool = row({ role: "tool", content: "OK" });
    const batch = await claimDistillBatch(fakeDb([speech, tool]));

    expect(batch.units).toHaveLength(1);
    expect(batch.units[0]!.current.role).toBe("user");
    expect(batch.consumedTurnIds).toHaveLength(2);
    expect(batch.consumedTurnIds).toContain(tool.id as string);
  });

  it("treats an already-distilled turn as context, never as re-extractable work", async () => {
    const done = row({ is_due: false, content: "earlier, already distilled" });
    const due = row({ is_due: true, content: "go" });
    const batch = await claimDistillBatch(fakeDb([done, due]));

    expect(batch.units).toHaveLength(1);
    expect(batch.units[0]!.current.content).toBe("go");
    // It supplied context...
    expect(batch.units[0]!.context.map((t) => t.content)).toEqual([
      "earlier, already distilled",
    ]);
    // ...but is not re-stamped.
    expect(batch.consumedTurnIds).toEqual([due.id as string]);
  });

  it("reports a session_seq backfill gap rather than hiding it", async () => {
    const batch = await claimDistillBatch(
      fakeDb([row({ session_seq: null }), row({ session_seq: 7 })]),
    );
    expect(batch.missingSessionSeq).toBe(1);
    // And the NULL-seq turn is still processed: ordering does not depend on it.
    expect(batch.consumedTurnIds).toHaveLength(2);
  });

  it("scopes to a namespace when asked and passes it as a bound parameter", async () => {
    const db = fakeDb([]);
    await claimDistillBatch(db, { namespace: "rico" });
    expect(db.seen[0]!.text).toContain("namespace = $1");
    expect(db.seen[0]!.values[0]).toBe("rico");
  });

  it("binds both due selection and context reads to the producer's lane", async () => {
    const db = fakeDb([]);
    const laneId = "77777777-7777-4777-8777-777777777777";
    await claimDistillBatch(db, { namespace: "rico", laneId });
    const sql = db.seen[0]!.text;
    expect(sql).toContain("AND lane_id = $2::uuid");
    expect(sql).toContain("AND t.lane_id = $2::uuid");
    expect(db.seen[0]!.values.slice(0, 2)).toEqual(["rico", laneId]);
  });

  it("keeps lane-less turns in their own producer batch", async () => {
    const db = fakeDb([]);
    await claimDistillBatch(db, { namespace: "rico", laneId: null });
    const sql = db.seen[0]!.text;
    expect(sql).toContain("AND lane_id IS NULL");
    expect(sql).toContain("AND t.lane_id IS NULL");
    expect(db.seen[0]!.values[0]).toBe("rico");
  });

  it("bounds both the session and turn limits so one sweep cannot read the table", async () => {
    const db = fakeDb([]);
    await claimDistillBatch(db, { maxSessions: 10_000, maxTurns: 10_000_000 });
    // Clamped at the module's ceilings (64 sessions / 20,000 turns). Asserted
    // positionally rather than as the whole array: the third parameter is the
    // context reach, which the query gained when the turn bound was moved onto
    // the due turns alone, and which the next test covers directly.
    expect(db.seen[0]!.values[0]).toBe(64);
    expect(db.seen[0]!.values[1]).toBe(20_000);
  });

  it("bounds the turn count by DUE turns, never by due-plus-context", async () => {
    // THE REGRESSION THIS EXISTS FOR. The query once read each due session
    // whole and applied `LIMIT maxTurns` to the result, so in a long-running
    // session the already-distilled context consumed the entire bound and the
    // due turns fell off the end. Measured on the dogfood corpus 2026-08-25:
    // 0 due turns and 1500 context turns claimed against a 190,102-turn
    // backlog, which the handler then reported as a successful sweep.
    const db = fakeDb([]);
    await claimDistillBatch(db, { maxTurns: 1500, contextWindow: 3 });
    const sql = db.seen[0]!.text;

    // The bound applies inside the due-turn selection...
    const dueClause = sql.slice(
      sql.indexOf("due_turns AS ("),
      sql.indexOf("context_bounds AS ("),
    );
    expect(dueClause).toContain("distilled_at IS NULL");
    expect(dueClause).toContain("LIMIT $2");

    // ...and the context read carries no turn bound of its own, so context can
    // never displace work.
    const contextClause = sql.slice(sql.indexOf("context_turns AS ("));
    expect(contextClause).not.toContain("LIMIT");

    // The context reach is a bound parameter, not interpolated.
    expect(db.seen[0]!.values[2]).toBe(3);
  });

  it("reads context as a session_seq range within the due turn's own session", async () => {
    // A row-count reach could walk off the start of a session and pull the tail
    // of an unrelated one as if it were preceding context. The range is
    // computed per session_ref and joined on it.
    const db = fakeDb([]);
    await claimDistillBatch(db, { contextWindow: 5 });
    const sql = db.seen[0]!.text;
    expect(sql).toContain("min(session_seq) -");
    expect(sql).toContain("t.session_ref IS NOT DISTINCT FROM b.session_ref");
    expect(db.seen[0]!.values[2]).toBe(5);
  });

  it("returns an empty batch for an empty queue -- the terminal state", async () => {
    const batch = await claimDistillBatch(fakeDb([]));
    expect(batch).toEqual({
      units: [],
      consumedTurnIds: [],
      missingSessionSeq: 0,
    });
  });
});
